import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import type { Address, Signature } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { commitmentOf, DEVNET_GENESIS_HASH, type Delivery, saltCheckOf } from "@intent-engine/client";
import { DeliveryUnfit, fetchDelivery, NOT_PUBLIC } from "../src/delivery-fetch.js";
import { type Lookup, privateAddress, publicHost } from "../src/public-address.js";
import { h, transport, world } from "./harness.js";

describe("private addresses", () => {
  it("names loopback, private, link-local, shared, reserved and multicast addresses private", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "255.255.255.255",
      "198.18.0.1",
      "::1",
      "::",
      "fc00::1",
      "fd12:3456::1",
      "fe80::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::ffff:10.0.0.1",
      "not-an-ip",
    ]) {
      expect(privateAddress(ip), ip).toBe(true);
    }
  });

  it("names ordinary internet addresses public", () => {
    for (const ip of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "192.169.0.1", "100.128.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
      expect(privateAddress(ip), ip).toBe(false);
    }
  });

  it("checks every address a host resolves to, and refuses one that resolves to nothing or not at all", async () => {
    const answers: Record<string, string[]> = { "public.example": ["93.184.216.34"], "mixed.example": ["93.184.216.34", "10.0.0.5"], "empty.example": [] };
    const lookup: Lookup = async (host) => {
      const found = answers[host];
      if (found === undefined) {
        throw new Error("ENOTFOUND");
      }
      return found;
    };
    expect(await publicHost("public.example", lookup)).toBe(true);
    expect(await publicHost("mixed.example", lookup)).toBe(false);
    expect(await publicHost("empty.example", lookup)).toBe(false);
    expect(await publicHost("missing.example", lookup)).toBe(false);
    expect(await publicHost("[::1]", lookup)).toBe(false);
    expect(await publicHost("8.8.8.8", lookup)).toBe(true);
  });
});

describe("fetching a delivery on a public cluster", () => {
  const bytes = new TextEncoder().encode("export default (a, b) => a + b;\n");
  const party = "11111111111111111111111111111111" as Address;
  const delivery = (url: string): Delivery => ({
    intent: party,
    sha256: "",
    url,
    worker: party,
    signature: "s" as Signature,
    slot: 1n,
    blockTime: null,
    commitment: commitmentOf(party, party, "ab".repeat(16), createHash("sha256").update(bytes).digest("hex")),
    check: saltCheckOf("ab".repeat(16)),
    salt: "ab".repeat(16),
    sealed: "",
  });
  const lookup: Lookup = async (host) => (host === "internal.example" ? ["192.168.0.10"] : ["93.184.216.34"]);
  const asked: string[] = [];
  const get = async (url: string) => {
    asked.push(url);
    return new Response(bytes);
  };

  it("refuses a url that points into a private network without fetching it, and fetches a public one", async () => {
    await world();
    h.genesis = DEVNET_GENESIS_HASH;
    for (const url of ["https://internal.example/work.mjs", "https://127.0.0.1/work.mjs", "https://[::1]/work.mjs", "https://169.254.169.254/latest"]) {
      await expect(fetchDelivery(get, transport, delivery(url), 5, lookup), url).rejects.toThrow(new DeliveryUnfit(url, NOT_PUBLIC));
    }
    expect(asked).toEqual([]);
    const fetched = await fetchDelivery(get, transport, delivery("https://work.example/work.mjs"), 5, lookup);
    expect(asked).toEqual(["https://work.example/work.mjs"]);
    await rm(fetched.root, { recursive: true, force: true });
  });

  it("fetches a local address on a local cluster", async () => {
    await world();
    asked.length = 0;
    const fetched = await fetchDelivery(get, transport, delivery("https://127.0.0.1/work.mjs"), 5, lookup);
    expect(asked).toEqual(["https://127.0.0.1/work.mjs"]);
    await rm(fetched.root, { recursive: true, force: true });
  });
});
