import { type Address, type KeyPairSigner, type Signature } from "@solana/kit";
import { getMintToInstruction } from "@solana-program/token";
import { beforeEach, describe, expect, it } from "vitest";
import { testSignature } from "@intent-engine/client/testing";
import { findConfigPda, findIntentPda, splitFee } from "@intent-engine/core/internal";
import { IN_FLIGHT_SECONDS, REFRESH_AFTER_SECONDS } from "../src/commands.js";
import { EXIT_OK } from "../src/main.js";
import { FAILED_ON_CHAIN } from "@intent-engine/solver";
import { ata, balance, cli, ESCROW, FEE_BPS, funded, h, mint, NOW, send, transport, world } from "./harness.js";
import { createSwap } from "./cli-kit.js";

describe("cli against the deployed engine", () => {
  let authority: KeyPairSigner;
  let feeRecipient: KeyPairSigner;
  let owner: KeyPairSigner;
  let inputMint: Address;
  let outputMint: Address;

  beforeEach(async () => {
    ({ authority, feeRecipient, owner, inputMint, outputMint } = await world());
  });

  const create = (nonce: string, expiresAt: bigint) => createSwap(inputMint, outputMint, nonce, expiresAt);

  const watching = async (issued: Address, solver: KeyPairSigner) =>
    cli(
      ["solve", "--keypair", "s.json", "--issue", `${inputMint}:${issued}=1/1`, "--min-profit", `${issued}=1`, "--url", "http://cluster", "--watch", "--interval", "3"],
      { "s.json": solver },
    );

  async function issuedMarket() {
    const solver = await funded();
    const issued = await mint(solver, 6);
    await ata(authority, owner.address, issued);
    await ata(authority, feeRecipient.address, inputMint);
    await ata(authority, solver.address, inputMint);
    await ata(authority, solver.address, issued);
    return { solver, issued };
  }

  it("solve backoff retain uses chain time", async () => {
    h.watched.length = 0;
    h.watched.push(owner.address);
    h.waits.length = 0;
    h.submitted.length = 0;
    const { solver, issued } = await issuedMarket();
    const chainNow = h.svm.getClock().unixTimestamp;
    const expiresAt = chainNow + 500n;
    expect(NOW + 1_000n).toBeGreaterThan(expiresAt);
    await cli(create("8", expiresAt).map((arg) => (arg === outputMint ? issued : arg)), { "owner.json": owner });
    const [late] = await findIntentPda({ owner: owner.address, nonce: 8n });
    expect(h.svm.getAccount(late).exists).toBe(true);
    const refused: string[] = [];
    h.through = {
      ...transport,
      submitWire: async (wire) => {
        refused.push(wire);
        throw new Error("the node refused the fill");
      },
    };
    h.rounds = 3;
    h.changed = [];
    const run = await watching(issued, solver);
    expect([run.code, run.err]).toEqual([EXIT_OK, ""]);
    expect(run.each()).toEqual([expect.objectContaining({ scan: "full", failed: [expect.objectContaining({ intent: late })] })]);
    expect(h.waits).toHaveLength(3);
    expect(refused).toHaveLength(1);
  });

  it("still scans everything once the interval passes, however many notifications keep arriving", async () => {
    h.watched.length = 0;
    h.watched.push(owner.address);
    h.waits.length = 0;
    const { solver, issued } = await issuedMarket();
    await cli(create("3", NOW + 3_600n).map((arg) => (arg === outputMint ? issued : arg)), { "owner.json": owner });
    const [busy] = await findIntentPda({ owner: owner.address, nonce: 3n });
    const view = h.svm.getAccount(busy);
    const data = new Uint8Array(view.exists ? view.data : []);
    h.rounds = 4;
    h.steps = [2n, 2n, 2n];
    h.changed = [[{ address: busy, data }], [{ address: busy, data }], [{ address: busy, data }]];
    const scans = h.scans;
    expect((await watching(issued, solver)).code).toBe(EXIT_OK);
    expect(h.scans - scans).toBe(2);
  });

  it("does not send a second fill for an intent whose first fill is still in flight, and tries again once that wait ends", async () => {
    h.watched.length = 0;
    h.watched.push(owner.address);
    h.waits.length = 0;
    h.submitted.length = 0;
    const { solver, issued } = await issuedMarket();
    await cli(create("2", NOW + 3_600n).map((arg) => (arg === outputMint ? issued : arg)), { "owner.json": owner });
    const [pending] = await findIntentPda({ owner: owner.address, nonce: 2n });
    h.dropSubmits = true;
    h.rounds = 3;
    h.steps = [0n, IN_FLIGHT_SECONDS];
    h.changed = [];
    const run = await watching(issued, solver);
    h.dropSubmits = false;
    expect(run.code).toBe(EXIT_OK);
    expect(run.each().map((r) => (r["sent"] as { intent: Address }[]).map((s) => s.intent))).toEqual([[pending], [pending]]);
    expect(h.submitted).toHaveLength(2);
  });

  it("does not plan a second inventory fill from tokens an unlanded first fill holds, and frees them once that flight ends", async () => {
    h.watched.length = 0;
    h.watched.push(owner.address);
    h.waits.length = 0;
    h.submitted.length = 0;
    const solver = await funded();
    const issued = await mint(solver, 6);
    await ata(authority, owner.address, issued);
    await ata(authority, feeRecipient.address, inputMint);
    await ata(authority, solver.address, inputMint);
    const solverOutput = await ata(authority, solver.address, issued);
    await send(solver, [getMintToInstruction({ mint: issued, token: solverOutput, mintAuthority: solver, amount: splitFee(ESCROW, FEE_BPS).net })]);
    for (const nonce of ["4", "6"]) {
      await cli(create(nonce, NOW + 3_600n).map((arg) => (arg === outputMint ? issued : arg)), { "owner.json": owner });
    }
    const opened = await Promise.all([4n, 6n].map(async (nonce) => (await findIntentPda({ owner: owner.address, nonce }))[0]));
    h.dropSubmits = true;
    h.rounds = 3;
    h.steps = [3n, IN_FLIGHT_SECONDS - 3n];
    h.changed = [];
    const run = await cli(
      ["solve", "--keypair", "s.json", "--inventory", `${inputMint}:${issued}=1/1`, "--min-profit", `${issued}=1`, "--url", "http://cluster", "--watch", "--interval", "3"],
      { "s.json": solver },
    );
    h.dropSubmits = false;
    expect([run.code, run.err]).toEqual([EXIT_OK, ""]);
    const sent = run.each().map((r) => r["sent"] as { intent: Address; holds?: unknown }[]);
    expect(sent.map((round) => round.length)).toEqual([1, 1]);
    expect(sent.map((round) => round[0]?.holds)).toEqual([
      { account: solverOutput, amount: "300" },
      { account: solverOutput, amount: "300" },
    ]);
    expect(opened).toContain(sent[0]?.[0]?.intent);
    expect(h.submitted).toHaveLength(2);
    expect(balance(solverOutput)).toBe(splitFee(ESCROW, FEE_BPS).net);
  });

  it("backs off an intent whose sent fill failed on chain instead of resending it every in-flight window", async () => {
    h.watched.length = 0;
    h.watched.push(owner.address);
    h.waits.length = 0;
    const { solver, issued } = await issuedMarket();
    await cli(create("5", NOW + 3_600n).map((arg) => (arg === outputMint ? issued : arg)), { "owner.json": owner });
    const [doomed] = await findIntentPda({ owner: owner.address, nonce: 5n });
    const lost: Signature[] = [];
    h.through = {
      ...transport,
      submitWire: async () => {
        const signature = testSignature(`lost-${lost.length}`);
        lost.push(signature);
        return signature;
      },
      transactionOf: async (signature) => {
        const found = lost.find((one) => one === signature);
        return found === undefined ? null : { signature: found, slot: 0n, blockTime: null, failed: true, emitted: [] };
      },
    };
    h.rounds = 4;
    h.steps = [IN_FLIGHT_SECONDS, 1n, 3n];
    h.changed = [];
    const run = await watching(issued, solver);
    expect(run.code).toBe(EXIT_OK);
    const intents = (key: string) => run.each().map((r) => ((r[key] ?? []) as { intent: Address }[]).map((s) => s.intent));
    expect(intents("sent")).toEqual([[doomed], [], [doomed]]);
    expect(intents("failed")).toEqual([[], [doomed], []]);
    expect(run.each()[1]?.["failed"]).toEqual([{ intent: doomed, error: `${FAILED_ON_CHAIN}: ${testSignature("lost-0")}` }]);
    expect(lost).toEqual([testSignature("lost-0"), testSignature("lost-1")]);
  });

  it("skips only a notification it cannot decode and still fills the valid ones that came with it", async () => {
    h.watched.length = 0;
    h.watched.push(owner.address);
    h.waits.length = 0;
    const { solver, issued } = await issuedMarket();
    await cli(create("12", NOW + 3_600n).map((arg) => (arg === outputMint ? issued : arg)), { "owner.json": owner });
    const [valid] = await findIntentPda({ owner: owner.address, nonce: 12n });
    const [bogus] = await findIntentPda({ owner: owner.address, nonce: 9n });
    const view = h.svm.getAccount(valid);
    h.rounds = 2;
    h.changed = [[{ address: bogus, data: new Uint8Array([1, 2, 3]) }, { address: valid, data: new Uint8Array(view.exists ? view.data : []) }]];
    const run = await watching(issued, solver);
    expect(run.code).toBe(EXIT_OK);
    expect(run.each()).toEqual([
      { at: String(NOW + 1_000n), scan: "changed", unreadable: [{ intent: bogus, reason: "the data is not an engine intent account" }] },
      expect.objectContaining({ scan: "changed", sent: [expect.objectContaining({ intent: valid })], failed: [] }),
    ]);
  });

  it("refreshes its cache for an intent that keeps failing at most once a minute, not every round and not never", async () => {
    h.watched.length = 0;
    h.watched.push(owner.address);
    h.waits.length = 0;
    const { solver, issued } = await issuedMarket();
    const stranger = await funded();
    await ata(authority, stranger.address, inputMint);
    await ata(authority, stranger.address, issued);
    await cli(create("4", NOW + 3_600n).map((arg) => (arg === outputMint ? issued : arg)), { "owner.json": owner });
    const [config] = await findConfigPda();
    h.rounds = 7;
    h.steps = [5n, 5n, 5n, 5n, REFRESH_AFTER_SECONDS, 5n];
    h.changed = [];
    h.reads.clear();
    const run = await watching(issued, stranger);
    expect(run.code).toBe(EXIT_OK);
    expect(run.each().map((r) => [r["at"], (r["failed"] as unknown[]).length])).toEqual([
      [String(NOW + 1_000n), 1],
      [String(NOW + 1_005n), 1],
      [String(NOW + 1_015n), 1],
      [String(NOW + 1_020n + REFRESH_AFTER_SECONDS), 1],
    ]);
    expect(h.reads.get(config)).toBe(3);
    expect(solver.address).not.toBe(stranger.address);
  });

  it("counts a full scan only once it succeeds, so the next round scans everything again", async () => {
    h.watched.length = 0;
    h.watched.push(owner.address);
    h.waits.length = 0;
    const { solver, issued } = await issuedMarket();
    const [busy] = await findIntentPda({ owner: owner.address, nonce: 3n });
    h.failScans = 1;
    h.rounds = 2;
    h.changed = [[{ address: busy, data: new Uint8Array([1, 2, 3]) }]];
    const scans = h.scans;
    const run = await watching(issued, solver);
    expect(run.code).toBe(EXIT_OK);
    expect(run.each()).toEqual([{ at: String(NOW + 1_000n), scan: "full", error: "scan refused" }]);
    expect(h.scans - scans).toBe(2);
  });
});
