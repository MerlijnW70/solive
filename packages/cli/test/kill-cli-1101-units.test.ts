import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, generateKeyPairSigner } from "@solana/kit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getLineLeftEventEncoder, getStakeMovedEventEncoder, getStoodByEventEncoder, seal } from "@intent-engine/core/internal";
import { MAX_SPEC_BYTES } from "@intent-engine/client/internal";
import { type EngineTransaction } from "@intent-engine/client";
import { DEVNET_TEST_MINT, NATIVE_MINT } from "@intent-engine/core";
import { testSignature } from "@intent-engine/client/testing";
import { NPM_REGISTRY } from "../src/npm-registry.js";
import { EXIT_OK, main } from "../src/main.js";
import { settingsPath } from "../src/wallet.js";
import { connectThrough, fresh, ok, preset, tag } from "./agent-wallet-kit.js";
import { h, HOME, instant, NOW, resetHarness, runtime, transport, world } from "./harness.js";

const STAKE = 50_000_000n;
const FORFEITED = 1;

const landed = (label: string, slot: bigint, emitted: Uint8Array[]): EngineTransaction => ({ signature: testSignature(label), slot, blockTime: NOW + slot, failed: false, emitted });

describe("sealing a spec whose sealed form is exactly the size the tools read", () => {
  it("seals it", async () => {
    const client = await fresh();
    const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
    let exact: { invite: Address[]; size: number } | undefined;
    for (let attempt = 0; attempt < 64 && exact === undefined; attempt += 1) {
      const invite = await Promise.all(Array.from({ length: 7 }, async () => (await generateKeyPairSigner()).address));
      const lengthAt = async (size: number) => (await seal(new Uint8Array(size).fill(97), [...invite, wallet])).length;
      let size = Math.floor(((MAX_SPEC_BYTES - (await lengthAt(0))) * 3) / 4) + 4;
      while ((await lengthAt(size)) > MAX_SPEC_BYTES) {
        size -= 1;
      }
      if ((await lengthAt(size)) === MAX_SPEC_BYTES) {
        exact = { invite, size };
      }
    }
    if (exact === undefined) {
      throw new Error("no invite list seals to exactly the limit");
    }
    const sealed = await ok(client, "wallet_seal_spec", { text: "a".repeat(exact.size), invite: exact.invite });
    expect((sealed["sealed"] as string).length).toBe(MAX_SPEC_BYTES);
  }, 120_000);
});

describe("add-to with --setup", () => {
  let bin = "";

  beforeAll(() => {
    bin = mkdtempSync(join(tmpdir(), "add-to-url-bin-"));
    writeFileSync(join(bin, "claude"), "");
    chmodSync(join(bin, "claude"), 0o755);
  });

  afterAll(() => {
    rmSync(bin, { recursive: true, force: true });
  });

  it("keeps the RPC url an earlier setup saved", async () => {
    resetHarness();
    instant.fetch = undefined;
    const saved = "https://" + "rpc.example.org/";
    h.files.set(settingsPath(HOME), JSON.stringify({ url: saved, keypair: `${HOME}/.config/intent-engine/wallet.json` }));
    const rt = { ...runtime({}), env: { PATH: bin }, launch: async (program: string) => ({ code: 0, output: program === "npm" ? `${NPM_REGISTRY}\n` : "" }) };
    const code = await main(["add-to", "claude"], rt, { out: () => undefined, err: () => undefined, tty: false });
    expect(code).toBe(EXIT_OK);
    expect(JSON.parse(h.files.get(settingsPath(HOME)) as string)).toMatchObject({ url: saved });
  });
});

describe("wallet_history of a place in a line", () => {
  it("names the stake's end in the wallet's own history, not a later leave found only in the escrow's", async () => {
    await world();
    h.files.clear();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    const lined = (await generateKeyPairSigner()).address;
    const owner = (await generateKeyPairSigner()).address;
    let wallet = "" as Address;
    let own: EngineTransaction[] = [];
    let escrow: EngineTransaction[] = [];
    const client = await connectThrough({ ...transport, engineTransactions: async (_limit, of) => (of === wallet ? own : of === lined ? escrow : []) });
    wallet = (await ok(client, "wallet_setup"))["address"] as Address;
    const joined = landed("join", 5n, [tag(getStoodByEventEncoder().encode({ intent: lined, worker: wallet, seq: 0, secs: 600, stake: STAKE }))]);
    const left = landed("leave", 6n, [tag(getLineLeftEventEncoder().encode({ intent: lined, worker: wallet, seq: 0, refunded: STAKE }))]);
    const forfeit = landed("forfeit", 9n, [tag(getStakeMovedEventEncoder().encode({ intent: lined, worker: wallet, to: owner, amount: STAKE, role: FORFEITED }))]);
    own = [forfeit, joined];
    escrow = [forfeit, left, joined];
    const entry = (action: string, outcome: string, signature: string, slot: bigint) => ({ intent: lined, action, stake: "0.05", stake_outcome: outcome, signature: testSignature(signature), at: String(NOW + slot) });
    expect((await ok(client, "wallet_history"))["claims"]).toEqual([entry("left", "returned", "leave", 6n), entry("queued", "forfeited", "join", 5n)]);
  });
});
