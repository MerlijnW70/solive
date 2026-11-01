import { type Address } from "@solana/kit";
import { Client } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it } from "vitest";
import { CLUSTERS } from "../src/args.js";
import { DEVNET_URL } from "../src/tokens.js";
import { DEVNET_VIEW, EXPLORER, explorerLink, setup } from "../src/wallet.js";
import { ok } from "./agent-wallet-kit.js";
import { fresh } from "./agent-wallet-kit.js";
import { cli, HOME, runtime, transport, world } from "./harness.js";
import { defaultWallet } from "../src/wallet.js";
import { readFileSync } from "node:fs";

const ROOT = new URL("../../../", import.meta.url).pathname;
const read = (path: string) => readFileSync(`${ROOT}${path}`, "utf8");
const ADDRESS = "11111111111111111111111111111112" as Address;

describe("the devnet explorer link", () => {
  beforeEach(async () => {
    await world();
  });

  it("opens the address on devnet and testnet", () => {
    expect(explorerLink(ADDRESS, DEVNET_URL)).toBe(`${EXPLORER}/address/${ADDRESS}?cluster=devnet`);
    expect(explorerLink(ADDRESS, CLUSTERS["testnet"] ?? "")).toBe(`${EXPLORER}/address/${ADDRESS}?cluster=testnet`);
  });

  it("is absent on mainnet and on other nodes", () => {
    expect(explorerLink(ADDRESS, CLUSTERS["mainnet-beta"] ?? "")).toBeUndefined();
    expect(explorerLink(ADDRESS, "http://127.0.0.1:8899")).toBeUndefined();
  });

  it("is in the CLI setup result with the wallet's own address, and the hint names devnet", async () => {
    const made = (await setup(transport, runtime({}), DEVNET_URL, defaultWallet(HOME))) as { address: string; explorer: string; hint: string };
    expect(made.explorer).toBe(`${EXPLORER}/address/${made.address}?cluster=devnet`);
    expect(made.hint).toBe(DEVNET_VIEW);
  });

  it("is left out of setup on mainnet and on another node, with no hint", async () => {
    for (const url of [CLUSTERS["mainnet-beta"] ?? "", "http://flag"]) {
      const made = (await setup(transport, runtime({}), url, defaultWallet(HOME))) as Record<string, string>;
      expect("explorer" in made).toBe(false);
      expect("hint" in made).toBe(false);
    }
  });

  it("is in the CLI setup output", async () => {
    const out = (await cli(["setup"], {})).json();
    expect(out["explorer"]).toBe(`${EXPLORER}/address/${out["address"]}?cluster=devnet`);
    expect(out["hint"]).toBe(DEVNET_VIEW);
  });
});

describe("the wallet server's explorer link", () => {
  let client: Client;

  beforeEach(async () => {
    client = await fresh();
  });

  it("setup and balance return the same link for the wallet's address", async () => {
    const made = await ok(client, "wallet_setup");
    const link = `${EXPLORER}/address/${made["address"] as string}?cluster=devnet`;
    expect(made["explorer"]).toBe(link);
    expect(made["hint"]).toBe(DEVNET_VIEW);
    expect((await ok(client, "wallet_balance"))["explorer"]).toBe(link);
  });
});

describe("the devnet docs paragraphs", () => {
  it("say how to see devnet funds", () => {
    expect(read("docs/quickstart.md")).toContain("To see devnet SOL, open the `explorer` link that `setup` prints, or switch your wallet app or explorer to devnet. Devnet funds never show on mainnet.");
    expect(read("docs/mcp.md")).toContain("`solive_wallet_setup` and `solive_wallet_balance` return an `explorer` link that opens your address on devnet. Devnet SOL shows only when your wallet app or explorer is switched to devnet.");
  });
});
