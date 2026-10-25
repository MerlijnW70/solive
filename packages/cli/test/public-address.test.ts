import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { type AnnouncementView } from "@intent-engine/client";
import { DEVNET_GENESIS_HASH } from "@intent-engine/client/internal";
import { announcementCommitment } from "@intent-engine/core/internal";
import { type Announced, DeliveryUnfit, fetchDelivery, NOT_PUBLIC } from "../src/delivery-fetch.js";
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
  const salt = new Uint8Array(16).fill(0xab);
  const delivery = async (url: string): Promise<Announced> => {
    const commitment = await announcementCommitment(party, party, { delivered: Uint8Array.from(createHash("sha256").update(bytes).digest()), salt });
    return { announcement: { address: party, intent: party, worker: party, commitment } as unknown as AnnouncementView, salt: Buffer.from(salt).toString("hex"), url };
  };
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
      await expect(fetchDelivery(get, transport, await delivery(url), 5, lookup), url).rejects.toThrow(new DeliveryUnfit(url, NOT_PUBLIC));
    }
    expect(asked).toEqual([]);
    const fetched = await fetchDelivery(get, transport, await delivery("https://work.example/work.mjs"), 5, lookup);
    expect(asked).toEqual(["https://work.example/work.mjs"]);
    await rm(fetched.root, { recursive: true, force: true });
  });

  it("fetches a local address on a local cluster", async () => {
    await world();
    asked.length = 0;
    const fetched = await fetchDelivery(get, transport, await delivery("https://127.0.0.1/work.mjs"), 5, lookup);
    expect(asked).toEqual(["https://127.0.0.1/work.mjs"]);
    await rm(fetched.root, { recursive: true, force: true });
  });
});
