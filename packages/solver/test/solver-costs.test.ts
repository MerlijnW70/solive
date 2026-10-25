import {
  type Address,
  type Base64EncodedWireTransaction,
  generateKeyPairSigner,
  type KeyPairSigner,
  lamports,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { getSyncNativeInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { LiteSVM, Rent } from "litesvm";
import { beforeEach, describe, expect, it } from "vitest";
import { findAssociatedTokenAddress, NATIVE_MINT } from "@intent-engine/core";
import {
  badSolValue,
  type Chain,
  DEFAULT_MAX_RENT,
  DEFAULT_MAX_SOL_COST,
  LAMPORTS_PER_SIGNATURE,
  rentExempt,
  TOKEN_ACCOUNT_SPACE,
  tooCostly,
  tooMuchRent,
  unsupportedRent,
  decide,
  MAX_COMPUTE_UNITS,
  NET_BELOW_FLOOR,
  netBelowFloor,
  tick,
} from "../src/index.js";
import {
  deployEngine,
  type Engine,
  engineTools,
  MIN_OUT,
  NOW,
  stashMarket,
  swapping,
} from "./solver-engine.js";

let svm: LiteSVM;

describe("solver against the deployed engine", () => {
  let authority: KeyPairSigner;
  let feeRecipient: KeyPairSigner;
  let owner: KeyPairSigner;
  let solver: KeyPairSigner;
  let stash: KeyPairSigner;
  let inputMint: Address;
  let outputMint: Address;
  let receiver: Address;
  let solverInput: Address;
  let solverOutput: Address;
  let stashAccount: Address;
  let feeTo: Address;
  let intents: Address[];

  const engine = (): Engine => ({ svm, authority, feeRecipient, owner, solver, stash, inputMint, outputMint, receiver, solverInput, solverOutput, stashAccount, feeTo, intents });
  const { send, funded, mint, ata, balance, chain, submit, open, simulated, landed, floors, solve, budgetOf, tipOf } = engineTools(engine);

  beforeEach(async () => {
    ({ svm, authority, feeRecipient, owner, solver, stash, inputMint, outputMint, receiver, solverInput, solverOutput, stashAccount, feeTo, intents } = await deployEngine());
  });

  it("skips a fill whose sol cost exceeds the cap", async () => {
    const intent = await open(30n);
    const sent: Base64EncodedWireTransaction[] = [];
    const pricer = () => stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 4_000n);
    const priced = (price: bigint): Partial<Parameters<typeof tick>[0]> => ({
      unitPrice: async () => price,
      simulate: async (wire, watch) => ({ ...(await simulated(wire, watch)), unitsConsumed: null }),
      send: async (wire) => {
        sent.push(wire);
        return landed(wire);
      },
    });
    const signers = 2n;
    const cost = signers * LAMPORTS_PER_SIGNATURE + (5_000_000n * BigInt(MAX_COMPUTE_UNITS)) / 1_000_000n;
    expect(cost).toBeLessThan(DEFAULT_MAX_SOL_COST);
    const capped = await solve(pricer(), { ...priced(5_000_000n), maxSolCost: cost - 1n });
    expect(capped).toEqual({ filled: [], sent: [], skipped: [{ intent, reason: tooCostly(cost, cost - 1n) }], failed: [] });
    const dear = signers * LAMPORTS_PER_SIGNATURE + (10_000_000n * BigInt(MAX_COMPUTE_UNITS)) / 1_000_000n;
    const unbounded = await solve(pricer(), priced(10_000_000n));
    expect(unbounded.skipped).toEqual([{ intent, reason: tooCostly(dear, DEFAULT_MAX_SOL_COST) }]);
    expect(sent).toEqual([]);
    expect(balance(receiver)).toBe(0n);
    const allowed = await solve(pricer(), { ...priced(5_000_000n), maxSolCost: cost });
    expect(allowed.filled).toEqual([{ intent, profit: 4_000n, cost, signature: expect.any(String) }]);
    expect(sent.map((wire) => budgetOf(wire, 2))).toEqual([MAX_COMPUTE_UNITS]);
  });

  it("kept rent does not count against the sol cost", async () => {
    const intent = await open(31n);
    solver = await funded();
    const freshInput = await findAssociatedTokenAddress({ owner: solver.address, mint: inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const freshOutput = await findAssociatedTokenAddress({ owner: solver.address, mint: outputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    swapping.current = { mint: inputMint, from: freshInput, to: swapping.current?.to ?? freshInput, authority: solver };
    const tipAccount = (await generateKeyPairSigner()).address;
    svm.airdrop(tipAccount, lamports(1_000_000_000n));
    const rent = svm.minimumBalanceForRentExemption(BigInt(TOKEN_ACCOUNT_SPACE));
    expect(rentExempt(TOKEN_ACCOUNT_SPACE)).toBe(rent);
    const signers = 2n;
    const cost = signers * LAMPORTS_PER_SIGNATURE + 12_345n;
    const kept = 2n * rent;
    expect(kept).toBeLessThan(DEFAULT_MAX_RENT);
    const tipped = { tip: { account: tipAccount, lamports: 12_345n } };
    const pricer = () => stashMarket(stash, stashAccount, outputMint, freshOutput, () => MIN_OUT + 4_000n);
    const capped = await solve(pricer(), { ...tipped, maxSolCost: cost - 1n });
    expect(capped.skipped).toEqual([{ intent, reason: tooCostly(cost, cost - 1n), rent: kept }]);
    const stingy = await solve(pricer(), { ...tipped, maxSolCost: cost, maxRent: kept - 1n });
    expect(stingy.skipped).toEqual([{ intent, reason: tooMuchRent(kept, kept - 1n), rent: kept }]);
    expect([svm.getAccount(freshInput).exists, svm.getAccount(freshOutput).exists]).toEqual([false, false]);
    const before = svm.getBalance(solver.address) ?? 0n;
    const report = await solve(pricer(), { ...tipped, maxSolCost: cost, maxRent: kept });
    expect(report.filled).toEqual([{ intent, profit: 4_000n, cost, signature: expect.any(String), rent: kept }]);
    expect(before - (svm.getBalance(solver.address) ?? 0n)).toBe(cost + kept);
    expect([svm.getBalance(freshInput), svm.getBalance(freshOutput)]).toEqual([rent, rent]);
  });

  it("prices the rent a fill opens at the chain's live rate and takes a fill only the live rate fits under the cap", async () => {
    svm.setRent(new Rent(5_080n, 1, 50));
    const intent = await open(33n);
    solver = await funded();
    const freshInput = await findAssociatedTokenAddress({ owner: solver.address, mint: inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const freshOutput = await findAssociatedTokenAddress({ owner: solver.address, mint: outputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    swapping.current = { mint: inputMint, from: freshInput, to: swapping.current?.to ?? freshInput, authority: solver };
    const pricer = () => stashMarket(stash, stashAccount, outputMint, freshOutput, () => MIN_OUT + 4_000n);
    const live: Chain = { ...chain(), rent: async () => ({ perByteYear: svm.getRent().lamportsPerByteYear, threshold: svm.getRent().exemptionThreshold }) };
    const cap = 3_000_000n;
    const blind = await solve(pricer(), { maxRent: cap });
    expect(blind.skipped).toEqual([{ intent, reason: tooMuchRent(4_078_560n, cap), rent: 4_078_560n }]);
    const over = await solve(pricer(), { chain: live, maxRent: 2_976_879n });
    expect(over.skipped).toEqual([{ intent, reason: tooMuchRent(2_976_880n, 2_976_879n), rent: 2_976_880n }]);
    expect([svm.getAccount(freshInput).exists, svm.getAccount(freshOutput).exists]).toEqual([false, false]);
    const report = await solve(pricer(), { chain: live, maxRent: cap });
    expect(report.filled).toEqual([{ intent, profit: 4_000n, cost: expect.any(BigInt), signature: expect.any(String), rent: 2_976_880n }]);
    expect([svm.getBalance(freshInput), svm.getBalance(freshOutput)]).toEqual([1_488_440n, 1_488_440n]);
  });

  it("refuses to fill on a chain whose rent is out of range", async () => {
    await open(34n);
    for (const rent of [
      { perByteYear: 6_961n, threshold: 1 },
      { perByteYear: 695n, threshold: 1 },
    ]) {
      const strange: Chain = { ...chain(), rent: async () => rent };
      await expect(solve(stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 4_000n), { chain: strange })).rejects.toThrow(unsupportedRent(Number(rent.perByteYear)));
    }
  });

  async function wrapOutput() {
    svm.withNativeMints();
    outputMint = NATIVE_MINT;
    receiver = await ata(authority, owner.address, NATIVE_MINT);
    solverOutput = await ata(authority, solver.address, NATIVE_MINT);
    stashAccount = await ata(authority, stash.address, NATIVE_MINT);
    await send(stash, [getTransferSolInstruction({ source: stash, destination: stashAccount, amount: 10_000_000n }), getSyncNativeInstruction({ account: stashAccount })]);
    return (spread: bigint) => stashMarket(stash, stashAccount, NATIVE_MINT, solverOutput, () => MIN_OUT + spread, [], 9);
  }

  it("skips a wrapped SOL fill whose spread covers the floor but not the floor plus its sol cost, which it sent before", async () => {
    const market = await wrapOutput();
    const intent = await open(60n);
    const cost = 2n * LAMPORTS_PER_SIGNATURE;
    const spread = 1_000n + cost - 1n;
    const stored = (await chain().intents()).find((entry) => entry.address === intent);
    if (stored === undefined) {
      throw new Error("intent missing");
    }
    const before = await decide(intent, stored.intent, await chain().config(), NOW, market(spread), solver.address, { minProfit: floors(1_000n), maxFeeBps: 100 });
    expect(before).toMatchObject({ kind: "fill", plan: { profit: spread } });
    const report = await solve(market(spread));
    expect(report).toEqual({ filled: [], sent: [], skipped: [{ intent, reason: netBelowFloor(spread, cost, cost, 1_000n) }], failed: [] });
    expect(report.skipped[0]?.reason.startsWith(NET_BELOW_FLOOR)).toBe(true);
    expect([balance(receiver), balance(solverOutput)]).toEqual([0n, 0n]);
    const paid = await solve(market(spread + 1n));
    expect(paid).toEqual({ filled: [{ intent, profit: spread + 1n, cost, signature: expect.any(String) }], sent: [], skipped: [], failed: [] });
    expect([balance(receiver), balance(solverOutput)]).toEqual([MIN_OUT, spread + 1n]);
  });

  it("counts a tip in a wrapped SOL fill's cost, sent alone or as the tail of a bundle", async () => {
    const market = await wrapOutput();
    const intent = await open(61n);
    const tipAccount = (await generateKeyPairSigner()).address;
    svm.airdrop(tipAccount, lamports(1_000_000_000n));
    const bare = 2n * LAMPORTS_PER_SIGNATURE;
    const cost = bare + 12_345n;
    const tipped = { tip: { account: tipAccount, lamports: 12_345n } };
    const spread = 1_000n + bare;
    expect((await solve(market(spread), tipped)).skipped).toEqual([{ intent, reason: netBelowFloor(spread, cost, cost, 1_000n) }]);
    const second = await open(62n);
    const bundles: Base64EncodedWireTransaction[][] = [];
    const bundling = {
      ...tipped,
      sendBundle: async (wires: readonly Base64EncodedWireTransaction[]) => {
        bundles.push([...wires]);
        for (const wire of wires) {
          await submit(wire);
        }
        return "bundle-wrapped";
      },
    };
    const refused = await solve(market(spread), bundling);
    expect([refused.sent, bundles]).toEqual([[], []]);
    expect(new Set(refused.skipped.map((s) => s.intent))).toEqual(new Set([intent, second]));
    expect(refused.skipped.map((s) => s.reason)).toEqual([netBelowFloor(spread, cost, cost, 1_000n), netBelowFloor(spread, cost, cost, 1_000n)]);
    expect(balance(receiver)).toBe(0n);
    const report = await solve(market(1_000n + cost), bundling);
    expect(bundles.map((wires) => wires.map(tipOf))).toEqual([[null, tipAccount]]);
    expect(report.sent.map((s) => s.cost).sort((a, b) => (a < b ? -1 : 1))).toEqual([bare, cost]);
    expect(new Set(report.sent.map((s) => s.intent))).toEqual(new Set([intent, second]));
    expect(balance(receiver)).toBe(2n * MIN_OUT);
  });

  it("converts a fill's sol cost into an output token with a sol value, rounding up, and judges a token without one as before", async () => {
    const intent = await open(63n);
    const cost = 2n * LAMPORTS_PER_SIGNATURE;
    const market = () => stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 4_000n);
    const valued = (floor: bigint, mint: Address, raw: bigint, per: bigint) => ({
      strategy: { minProfit: floors(floor), maxFeeBps: 100, solValue: new Map([[mint, { raw, lamports: per }]]) },
    });
    await expect(solve(market(), valued(1_000n, outputMint, 0n, 1n))).rejects.toThrow(badSolValue(outputMint));
    expect((await solve(market(), valued(667n, outputMint, 1n, 3n))).skipped).toEqual([{ intent, reason: netBelowFloor(4_000n, 3_334n, cost, 667n) }]);
    expect(balance(receiver)).toBe(0n);
    const paid = await solve(market(), valued(666n, outputMint, 1n, 3n));
    expect(paid.filled).toEqual([{ intent, profit: 4_000n, cost, signature: expect.any(String) }]);
    const plain = await open(64n);
    const unpriced = await solve(market(), valued(4_000n, inputMint, 1n, 1_000_000n));
    expect(unpriced).toEqual({ filled: [{ intent: plain, profit: 4_000n, cost, signature: expect.any(String) }], sent: [], skipped: [{ intent, reason: "not open" }], failed: [] });
    expect(balance(receiver)).toBe(2n * MIN_OUT);
  });
});
