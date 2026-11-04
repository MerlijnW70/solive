import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, lamports } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { askInstantFaucet, FAUCET_EMPTY_SIGN, type FaucetFetch, GH_HINT, type InstantFaucet } from "../src/faucet.js";
import { APP_WAY, FAUCET, otherWays, pasteFirst, whyAirdrop, WHY_EMPTY, WHY_LIMITED, WHY_OTHER, whyShort } from "../src/wallet.js";
import { fresh, ok } from "./agent-wallet-kit.js";
import { cli, h, instant, world } from "./harness.js";
import { DEVNET_URL } from "../src/tokens.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const EMPTY_SAID = "The faucet holds too little SOL right now, so try again later.";
const SIGNATURE = "5".repeat(88);

const answering =
  (status: number, body: unknown, credit = false): FaucetFetch =>
  async (_url, init) => {
    if (credit) {
      h.svm.airdrop((JSON.parse(init.body) as { address: Address }).address, lamports(500_000_000n));
    }
    return { status, json: async () => body };
  };

describe("why a new wallet holds too little SOL", () => {
  beforeEach(async () => {
    await world();
    h.files.clear();
    for (const name of Object.keys(h.env)) {
      delete h.env[name];
    }
    h.airdropRefused = false;
    h.airdrops = [];
  });

  afterEach(() => {
    instant.fetch = undefined;
  });

  it("recognises the service's own empty message", () => {
    expect(read("services/faucet/src/drip.ts")).toContain(EMPTY_SAID);
    expect(EMPTY_SAID).toContain(FAUCET_EMPTY_SIGN);
  });

  it("classifies the instant faucet's refusals", async () => {
    expect(await askInstantFaucet(answering(503, { error: EMPTY_SAID }), {}, "a")).toMatchObject({ kind: "empty" });
    expect(await askInstantFaucet(answering(429, { error: "Slow down." }), {}, "a")).toMatchObject({ kind: "limited" });
    expect(await askInstantFaucet(answering(429, null), {}, "a")).toMatchObject({ kind: "limited" });
    expect(await askInstantFaucet(answering(503, { error: "The devnet node did not answer." }), {}, "a")).not.toHaveProperty("kind");
    expect(await askInstantFaucet(answering(403, { error: EMPTY_SAID }), {}, "a")).not.toHaveProperty("kind");
  });

  it("maps each refusal reason to its plain text", () => {
    const refused = (kind?: "empty" | "limited"): InstantFaucet => (kind === undefined ? { refused: "x" } : { refused: "x", kind });
    expect(whyShort(refused("empty"), false, DEVNET_URL)).toBe(WHY_EMPTY);
    expect(whyShort(refused("limited"), false, DEVNET_URL)).toBe(WHY_LIMITED);
    expect(whyShort(refused(), false, DEVNET_URL)).toBe(WHY_OTHER);
    expect(whyShort(null, true, DEVNET_URL)).toBe(whyAirdrop(DEVNET_URL));
    expect(whyShort(refused("empty"), true, DEVNET_URL)).toBe(`${WHY_EMPTY}; ${whyAirdrop(DEVNET_URL)}`);
    expect(whyShort(null, false, DEVNET_URL)).toBeUndefined();
    expect(whyShort({ lamports: "1", signature: SIGNATURE }, false, DEVNET_URL)).toBeUndefined();
    expect(new Set([WHY_EMPTY, WHY_LIMITED, WHY_OTHER, whyAirdrop(DEVNET_URL)]).size).toBe(4);
  });

  it("puts the reason in the CLI setup result when the faucet is empty and the airdrop is refused", async () => {
    h.airdropRefused = true;
    instant.fetch = answering(503, { error: EMPTY_SAID });
    const made = (await cli(["setup"], {})).json();
    expect(made["why"]).toBe(`${WHY_EMPTY}; ${whyAirdrop(DEVNET_URL)}`);
    expect(made["faucet"]).toEqual({ refused: EMPTY_SAID });
  });

  it("puts the rate limit reason in the result, and none when the wallet holds enough", async () => {
    instant.fetch = answering(429, { error: "Slow down.", retry_after: 30 });
    h.airdropRefused = true;
    expect((await cli(["setup"], {})).json()["why"]).toBe(`${WHY_LIMITED}; ${whyAirdrop(DEVNET_URL)}`);
    h.files.clear();
    h.airdropRefused = false;
    const enough = (await cli(["setup"], {})).json();
    expect(enough).not.toHaveProperty("why");
    expect(enough).not.toHaveProperty("other_ways");
  });

  it("lists the wallet-app route with the address first, then the slower routes", async () => {
    h.airdropRefused = true;
    const made = (await cli(["setup"], {})).json();
    const address = made["address"] as string;
    const ways = made["other_ways"] as string[];
    expect(ways).toEqual(otherWays(address, GH_HINT));
    expect(ways[0]).toBe(APP_WAY(address));
    expect(ways[0]).toContain(address);
    expect(ways[0]).toContain("wallet app switched to devnet");
    expect(ways[1]).toBe(pasteFirst(address));
    expect(ways[2]).toContain(FAUCET);
    expect(ways.length).toBeLessThanOrEqual(4);
  });

  it("gives the MCP wallet setup the same reason and routes", async () => {
    instant.fetch = answering(503, { error: EMPTY_SAID });
    const client = await fresh();
    h.airdropRefused = true;
    const made = await ok(client, "wallet_setup");
    expect(made["why"]).toBe(`${WHY_EMPTY}; ${whyAirdrop(DEVNET_URL)}`);
    expect((made["other_ways"] as string[])[0]).toBe(APP_WAY(made["address"] as string));
    expect(made["faucet"]).toEqual({ refused: EMPTY_SAID });
  });

  it("is in the quickstart and the MCP guide", () => {
    expect(read("docs/quickstart.md")).toContain(
      "If the wallet holds 0 SOL, the `why` in the `setup` output says whether the instant faucet is out of SOL, its rate limit applies or devnet refused the airdrop. `other_ways` lists the routes, fastest first: send devnet SOL to your address from any wallet app switched to devnet, paste it at faucet.solana.com, or file a request with this project's faucet.",
    );
    expect(read("docs/mcp.md")).toContain(
      "When `solive_wallet_setup` returns too little SOL, `why` names the reason and `other_ways` lists the routes, fastest first. The first is to send devnet SOL to the wallet's address from any wallet app switched to devnet.",
    );
  });
});
