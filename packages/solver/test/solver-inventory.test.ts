import {
  type Address,
  type Base64EncodedWireTransaction,
  generateKeyPairSigner,
  type KeyPairSigner,
} from "@solana/kit";
import { getMintToInstruction, getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { LiteSVM } from "litesvm";
import { beforeEach, describe, expect, it } from "vitest";
import { splitFees } from "@intent-engine/core";
import {
  BALANCES_REFUSED,
  INVENTORY_SPENT,
  inventoryPricer,
  type Pricer,
  tick,
} from "../src/index.js";
import {
  AMOUNT,
  deployEngine,
  type Engine,
  engineTools,
  MIN_OUT,
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
  const { send, mint, ata, balance, submit, open, landed, solve, bundled } = engineTools(engine);

  beforeEach(async () => {
    ({ svm, authority, feeRecipient, owner, solver, stash, inputMint, outputMint, receiver, solverInput, solverOutput, stashAccount, feeTo, intents } = await deployEngine());
  });

  it("refuses a route that sends the swap output elsewhere, even when its own inventory could cover the fill", async () => {
    await open(1n);
    await send(authority, [getMintToInstruction({ mint: outputMint, token: solverOutput, mintAuthority: authority, amount: 5_000_000n })]);
    const elsewhere = await ata(authority, (await generateKeyPairSigner()).address, outputMint);
    const held = { solver: balance(solverOutput), receiver: balance(receiver) };
    const report = await solve(stashMarket(stash, stashAccount, outputMint, elsewhere, () => MIN_OUT + 4_000n));
    expect(report.filled).toEqual([]);
    expect(report.failed.map((f) => f.error.split(":")[0])).toEqual([BALANCES_REFUSED]);
    expect([balance(solverOutput), balance(receiver), balance(elsewhere)]).toEqual([held.solver, held.receiver, 0n]);
  });

  it("refuses a route that delivers less than it quoted, or takes more of the solver's input than it quoted", async () => {
    const lying = (quoted: bigint, delivered: bigint, extraInput: bigint): Pricer => ({
      async quote(request) {
        const take = swapping.current;
        if (take === null) {
          throw new Error("no swap input configured");
        }
        return {
          amountIn: request.amountIn,
          amountOut: quoted,
          lookupTables: [],
          instructions: [
            getTransferCheckedInstruction({
              source: take.from,
              mint: take.mint,
              destination: take.to,
              authority: take.authority,
              amount: request.amountIn + extraInput,
              decimals: 6,
            }),
            getTransferCheckedInstruction({
              source: stashAccount,
              mint: outputMint,
              destination: solverOutput,
              authority: stash,
              amount: delivered,
              decimals: 6,
            }),
          ],
        };
      },
    });
    await send(authority, [getMintToInstruction({ mint: inputMint, token: solverInput, mintAuthority: authority, amount: 10n })]);
    await open(1n);
    const short = await solve(lying(MIN_OUT + 4_000n, MIN_OUT + 1_000n, 0n));
    expect(short.filled).toEqual([]);
    expect(short.failed.map((f) => f.error.split(":")[0])).toEqual([BALANCES_REFUSED]);
    const greedy = await solve(lying(MIN_OUT + 4_000n, MIN_OUT + 4_000n, 1n));
    expect(greedy.filled).toEqual([]);
    expect(greedy.failed.map((f) => f.error.split(":")[0])).toEqual([BALANCES_REFUSED]);
    const honest = await solve(lying(MIN_OUT + 4_000n, MIN_OUT + 4_000n, 0n));
    expect(honest.failed).toEqual([]);
    expect(honest.filled).toHaveLength(1);
  });

  it("fills an intent from the solver's own output tokens with no route, when the simulation keeps the planned balances", async () => {
    const intent = await open(1n);
    await send(authority, [getMintToInstruction({ mint: outputMint, token: solverOutput, mintAuthority: authority, amount: AMOUNT })]);
    const pricer = inventoryPricer(
      [{ inputMint, outputMint, outputTokenProgram: TOKEN_PROGRAM_ADDRESS, out: 1n, in: 1n }],
      async () => balance(solverOutput),
    );
    const fees = splitFees(AMOUNT, 5, 0, 0);
    const report = await solve(pricer);
    expect(report).toEqual({ filled: [{ intent, profit: fees.net - MIN_OUT, cost: expect.any(BigInt), signature: expect.any(String) }], sent: [], skipped: [], failed: [] });
    expect([balance(receiver), balance(solverOutput), balance(solverInput), balance(feeTo)]).toEqual([MIN_OUT, AMOUNT - MIN_OUT, fees.net, fees.protocol]);
  });

  it("skips, without failing, an inventory fill whose stock an earlier fill of the same tick already spent", async () => {
    const first = await open(1n);
    const second = await open(2n);
    await send(authority, [getMintToInstruction({ mint: outputMint, token: solverOutput, mintAuthority: authority, amount: AMOUNT })]);
    const pricer = inventoryPricer(
      [{ inputMint, outputMint, outputTokenProgram: TOKEN_PROGRAM_ADDRESS, out: 1n, in: 1n }],
      async () => balance(solverOutput),
    );
    const report = await solve(pricer);
    expect(report.failed).toEqual([]);
    expect(report.filled).toHaveLength(1);
    expect(report.skipped.map((s) => [s.intent, s.reason.split(":")[0]])).toEqual([
      [report.filled[0]?.intent === first ? second : first, INVENTORY_SPENT],
    ]);
    expect(balance(receiver)).toBe(MIN_OUT);
  });

  it("sends every inventory fill its stock covers when the sends are not yet confirmed, and skips the one it cannot cover", async () => {
    const opened = [await open(1n), await open(2n), await open(3n)];
    await send(authority, [getMintToInstruction({ mint: outputMint, token: solverOutput, mintAuthority: authority, amount: 2n * AMOUNT })]);
    const pricer = inventoryPricer(
      [{ inputMint, outputMint, outputTokenProgram: TOKEN_PROGRAM_ADDRESS, out: 1n, in: 1n }],
      async () => 3n * AMOUNT,
    );
    const report = await solve(pricer, { send: async (wire) => ({ ...(await landed(wire)), confirmed: false }) });
    expect([report.filled, report.failed]).toEqual([[], []]);
    expect(report.sent).toHaveLength(2);
    expect(report.skipped.map((s) => s.reason.split(":")[0])).toEqual([INVENTORY_SPENT]);
    expect(new Set([...report.sent.map((s) => s.intent), ...report.skipped.map((s) => s.intent)])).toEqual(new Set(opened));
    expect(balance(receiver)).toBe(2n * MIN_OUT);
  });

  it("reports the account and amount an unlanded inventory fill holds back, and a route fill holds nothing", async () => {
    const stocked = await open(1n);
    await send(authority, [getMintToInstruction({ mint: outputMint, token: solverOutput, mintAuthority: authority, amount: AMOUNT })]);
    const pricer = inventoryPricer(
      [{ inputMint, outputMint, outputTokenProgram: TOKEN_PROGRAM_ADDRESS, out: 1n, in: 1n }],
      async () => balance(solverOutput),
    );
    const unlanded = { send: async (wire: Base64EncodedWireTransaction) => ({ ...(await landed(wire)), confirmed: false }) };
    const report = await solve(pricer, unlanded);
    expect(report.sent).toEqual([
      { intent: stocked, profit: splitFees(AMOUNT, 5, 0, 0).net - MIN_OUT, cost: expect.any(BigInt), signature: expect.any(String), holds: { account: solverOutput, amount: MIN_OUT } },
    ]);
    const routed = await open(2n);
    const route = await solve(stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 4_000n), unlanded);
    expect(route.sent).toEqual([{ intent: routed, profit: 4_000n, cost: expect.any(BigInt), signature: expect.any(String) }]);
  });

  it("bundles only the inventory fills its stock covers before any of them is sent", async () => {
    const opened = [await open(1n), await open(2n)];
    await send(authority, [getMintToInstruction({ mint: outputMint, token: solverOutput, mintAuthority: authority, amount: AMOUNT })]);
    const pricer = inventoryPricer(
      [{ inputMint, outputMint, outputTokenProgram: TOKEN_PROGRAM_ADDRESS, out: 1n, in: 1n }],
      async () => 3n * AMOUNT,
    );
    const bundled: (readonly Base64EncodedWireTransaction[])[] = [];
    const report = await solve(pricer, {
      sendBundle: async (wires) => {
        bundled.push(wires);
        return "bundle-unsent";
      },
    });
    expect(report.failed).toEqual([]);
    expect(bundled.map((wires) => wires.length)).toEqual([1]);
    expect(report.sent).toHaveLength(1);
    expect(report.skipped.map((s) => s.reason.split(":")[0])).toEqual([INVENTORY_SPENT]);
    expect(new Set([...report.sent.map((s) => s.intent), ...report.skipped.map((s) => s.intent)])).toEqual(new Set(opened));
  });

  it("reports the hold of an inventory fill sent in a bundle", async () => {
    const stocked = await open(1n);
    await send(authority, [getMintToInstruction({ mint: outputMint, token: solverOutput, mintAuthority: authority, amount: AMOUNT })]);
    const pricer = inventoryPricer(
      [{ inputMint, outputMint, outputTokenProgram: TOKEN_PROGRAM_ADDRESS, out: 1n, in: 1n }],
      async () => balance(solverOutput),
    );
    const report = await solve(pricer, {
      sendBundle: async (wires) => {
        for (const wire of wires) {
          await submit(wire);
        }
        return "bundle-held";
      },
    });
    expect(report.sent).toEqual([
      { intent: stocked, profit: splitFees(AMOUNT, 5, 0, 0).net - MIN_OUT, cost: expect.any(BigInt), signature: "bundle-held", holds: { account: solverOutput, amount: MIN_OUT } },
    ]);
  });

  it("treats what earlier fills still hold back as spent: skips the fill it leaves short and fills the one it leaves enough for", async () => {
    const intent = await open(1n);
    await send(authority, [getMintToInstruction({ mint: outputMint, token: solverOutput, mintAuthority: authority, amount: AMOUNT })]);
    const pricer = inventoryPricer(
      [{ inputMint, outputMint, outputTokenProgram: TOKEN_PROGRAM_ADDRESS, out: 1n, in: 1n }],
      async () => 3n * AMOUNT,
    );
    const asked: Address[] = [];
    const holding = (amount: bigint) => (account: Address) => {
      asked.push(account);
      return account === solverOutput ? amount : 0n;
    };
    const short = await solve(pricer, { held: holding(AMOUNT - MIN_OUT + 1n) });
    expect([short.filled, short.sent, short.failed]).toEqual([[], [], []]);
    expect(short.skipped).toEqual([{ intent, reason: `${INVENTORY_SPENT}: ${MIN_OUT - 1n} left, ${MIN_OUT} needed` }]);
    expect(asked).toEqual([solverOutput]);
    expect(balance(receiver)).toBe(0n);
    const enough = await solve(pricer, { held: holding(AMOUNT - MIN_OUT) });
    expect(enough.filled.map((f) => f.intent)).toEqual([intent]);
    expect(balance(receiver)).toBe(MIN_OUT);
  });

  it("refuses an inventory fill whose simulation spends more output than required or brings in less input than planned", async () => {
    const intent = await open(1n);
    await send(authority, [
      getMintToInstruction({ mint: outputMint, token: solverOutput, mintAuthority: authority, amount: AMOUNT }),
      getMintToInstruction({ mint: inputMint, token: solverInput, mintAuthority: authority, amount: 10n }),
    ]);
    const elsewhere = { input: await ata(authority, stash.address, inputMint), output: await ata(authority, stash.address, outputMint) };
    const leaking = (mint: Address, source: Address, destination: Address): Pricer => ({
      async quote(request) {
        return {
          amountIn: request.amountIn,
          amountOut: request.amountIn,
          lookupTables: [],
          inventory: true,
          instructions: [getTransferCheckedInstruction({ source, mint, destination, authority: solver, amount: 1n, decimals: 6 })],
        };
      },
    });
    const held = () => [balance(receiver), balance(solverOutput), balance(solverInput), balance(elsewhere.output), balance(elsewhere.input)];
    const before = held();
    for (const pricer of [leaking(outputMint, solverOutput, elsewhere.output), leaking(inputMint, solverInput, elsewhere.input)]) {
      const report = await solve(pricer);
      expect([report.filled, report.sent, report.skipped]).toEqual([[], [], []]);
      expect(report.failed.map((f) => [f.intent, f.error.split(":")[0]])).toEqual([[intent, BALANCES_REFUSED]]);
      expect(held()).toEqual(before);
    }
  });
});
