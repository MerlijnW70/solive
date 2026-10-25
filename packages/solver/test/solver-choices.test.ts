import type { Address, KeyPairSigner } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { LiteSVM } from "litesvm";
import { beforeEach, describe, expect, it } from "vitest";
import { findAssociatedTokenAddress, type Intent, IntentStatus, Kind, splitFees } from "@intent-engine/core";
import {
  buildCreateIntent,
  buildUpdateEconomics,
  findIntentPda,
  MAX_CRANK_BOUNTY,
  MAX_CREATE_FEE,
} from "@intent-engine/core/internal";
import {
  BACKOFF_MAX_INTERVALS,
  backingOff,
  backoff,
  type Chain,
  rentExempt,
  TOKEN_ACCOUNT_SPACE,
  type Pricer,
  type Quote,
  tick,
} from "../src/index.js";
import {
  AMOUNT,
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
  const { send, funded, mint, ata, balance, chain, open, simulated, floors, solve } = engineTools(engine);

  beforeEach(async () => {
    ({ svm, authority, feeRecipient, owner, solver, stash, inputMint, outputMint, receiver, solverInput, solverOutput, stashAccount, feeTo, intents } = await deployEngine());
  });

  it("backoff waits in seconds not ticks", async () => {
    const intent = await open(32n);
    const interval = 5;
    let clock = 0;
    const held = backoff(interval, () => clock);
    const pricer = () => stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 4_000n);
    let failing = true;
    let tried = 0;
    const moved: Chain = {
      ...chain(),
      intents: async () => (await chain().intents()).map((e) => ({ ...e, intent: { ...e.intent, expiresAt: e.intent.expiresAt + 1n } })),
    };
    const run = (extra: Partial<Parameters<typeof tick>[0]> = {}) =>
      solve(pricer(), {
        backoff: held,
        simulate: async (wire, watch) => {
          tried += 1;
          return failing ? { err: "InstructionError", unitsConsumed: null, balances: [] } : simulated(wire, watch);
        },
        ...extra,
      });
    const failedOnce = async (extra: Partial<Parameters<typeof tick>[0]> = {}) =>
      expect((await run(extra)).failed.map((f) => f.intent)).toEqual([intent]);
    await failedOnce();
    for (let i = 0; i < 40; i += 1) {
      expect((await run()).skipped).toEqual([{ intent, reason: backingOff(1, interval) }]);
    }
    expect(tried).toBe(1);
    clock = interval * 1_000 - 1;
    expect((await run()).skipped).toEqual([{ intent, reason: backingOff(1, 1) }]);
    clock = interval * 1_000;
    await failedOnce();
    expect((await run()).skipped).toEqual([{ intent, reason: backingOff(2, 2 * interval) }]);
    clock += 2 * interval * 1_000;
    await failedOnce();
    expect((await run()).skipped).toEqual([{ intent, reason: backingOff(3, 4 * interval) }]);
    expect(tried).toBe(3);
    await failedOnce({ chain: moved });
    expect(tried).toBe(4);
    expect((await run({ chain: moved })).skipped).toEqual([{ intent, reason: backingOff(1, interval) }]);
    clock += interval * 1_000;
    failing = false;
    expect((await run({ chain: moved })).filled.map((f) => f.intent)).toEqual([intent]);
    expect(held.size()).toBe(0);
    expect(balance(receiver)).toBe(MIN_OUT);
    const state = (await chain().intents())[0]?.intent;
    if (state === undefined) {
      throw new Error("intent missing");
    }
    const alone = backoff(interval, () => clock);
    for (let i = 0; i < 10; i += 1) {
      alone.failed(intent, state);
    }
    expect(alone.waiting(intent, state)).toEqual({ failures: 10, seconds: interval * BACKOFF_MAX_INTERVALS });
    alone.succeeded(intent);
    expect(alone.waiting(intent, state)).toBeNull();
    alone.failed(intent, state);
    expect(alone.waiting(intent, state)).toEqual({ failures: 1, seconds: interval });
  });

  it("backoff forgets intents that are no longer open", async () => {
    const opened = [await open(40n), await open(41n), await open(42n), await open(43n)];
    const listed = await chain().intents();
    const stateOf = (address: Address): Intent => {
      const found = listed.find((entry) => entry.address === address)?.intent;
      if (found === undefined) {
        throw new Error("intent missing");
      }
      return found;
    };
    const [kept, filled, expired, gone] = opened.map((address) => ({ address, intent: stateOf(address) }));
    if (kept === undefined || filled === undefined || expired === undefined || gone === undefined) {
      throw new Error("intents missing");
    }
    const held = backoff(5, () => 0);
    for (const { address, intent } of listed) {
      held.failed(address, intent);
    }
    expect(held.size()).toBe(4);
    held.retain(listed, NOW);
    expect(held.size()).toBe(4);
    held.retain(
      [
        kept,
        { ...filled, intent: { ...filled.intent, status: IntentStatus.Filled } },
        { ...expired, intent: { ...expired.intent, expiresAt: NOW } },
      ],
      NOW,
    );
    expect(held.size()).toBe(1);
    expect(held.waiting(kept.address, kept.intent)).toEqual({ failures: 1, seconds: 5 });
    for (const { address, intent } of [filled, expired, gone]) {
      expect(held.waiting(address, intent)).toBeNull();
    }
    held.retain([{ ...kept, intent: { ...kept.intent, status: IntentStatus.Cancelled } }], NOW);
    expect(held.size()).toBe(0);
  });

  it("asks the chain nothing about an intent it can tell from its own state that it will not fill", async () => {
    await open(1n);
    const asked: string[] = [];
    const counted = chain();
    const watched: Chain = {
      ...counted,
      tokenProgram: async (mint) => (asked.push("tokenProgram"), counted.tokenProgram(mint)),
      exists: async (address) => (asked.push("exists"), counted.exists(address)),
      blockhash: async () => (asked.push("blockhash"), counted.blockhash()),
      tokenAmount: async (address) => (asked.push("tokenAmount"), counted.tokenAmount(address)),
      lookupTables: async (addresses) => (asked.push("lookupTables"), counted.lookupTables(addresses)),
    };
    const none: Pricer = { quote: async () => null };
    const report = await solve(none, { chain: watched, strategy: { minProfit: new Map(), maxFeeBps: 100 } });
    expect(report.skipped).toEqual([{ intent: intents[0], reason: `no profit floor is set for ${outputMint}` }]);
    expect(asked).toEqual([]);
    await solve(none, { chain: watched });
    expect(asked.length).toBeGreaterThan(0);
  });

  it("skips an output token it has no profit floor for before asking the market", async () => {
    const intent = await open(14n);
    let asked = 0;
    const pricer: Pricer = {
      async quote() {
        asked += 1;
        return null;
      },
    };
    const report = await solve(pricer, { strategy: { minProfit: new Map(), maxFeeBps: 100 } });
    expect(report.skipped).toEqual([{ intent, reason: `no profit floor is set for ${outputMint}` }]);
    expect(asked).toBe(0);
  });

  it("opens its own input account for a token it has never received, inside the fill", async () => {
    const intent = await open(15n);
    solver = await funded();
    solverOutput = await ata(authority, solver.address, outputMint);
    const fresh = await findAssociatedTokenAddress({ owner: solver.address, mint: inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(svm.getAccount(fresh).exists).toBe(false);
    const stashInput = swapping.current?.to ?? fresh;
    swapping.current = { mint: inputMint, from: fresh, to: stashInput, authority: solver };
    const sold = balance(stashInput);
    const report = await solve(stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 4_000n));
    expect(report.failed).toEqual([]);
    expect(report.filled.map((f) => f.intent)).toEqual([intent]);
    expect(balance(fresh)).toBe(0n);
    expect(balance(stashInput) - sold).toBe(splitFees(AMOUNT, 5, 0, 0).net);
  });

  it("opens its own output account for a token it has never held, inside the fill", async () => {
    const intent = await open(17n);
    solver = await funded();
    solverInput = await ata(authority, solver.address, inputMint);
    const fresh = await findAssociatedTokenAddress({ owner: solver.address, mint: outputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(svm.getAccount(fresh).exists).toBe(false);
    swapping.current = { mint: inputMint, from: solverInput, to: swapping.current?.to ?? solverInput, authority: solver };
    const report = await solve(stashMarket(stash, stashAccount, outputMint, fresh, () => MIN_OUT + 4_000n));
    expect(report.failed).toEqual([]);
    expect(report.filled).toEqual([{ intent, profit: 4_000n, cost: expect.any(BigInt), signature: expect.any(String), rent: rentExempt(TOKEN_ACCOUNT_SPACE) }]);
    expect(balance(fresh)).toBe(4_000n);
    expect(balance(receiver)).toBe(MIN_OUT);
  });

  it("checks that every payee can be paid before it spends a quote", async () => {
    const partner = await funded();
    const loner = await open(16n, partner.address);
    let asked = 0;
    const pricer: Pricer = {
      async quote() {
        asked += 1;
        return null;
      },
    };
    const report = await solve(pricer);
    expect(report.skipped).toEqual([{ intent: loner, reason: "no partner account to pay into" }]);
    expect(asked).toBe(0);
  });

  it("pays a partner its share when the intent names one", async () => {
    const partner = await funded();
    const partnerTo = await ata(authority, partner.address, inputMint);
    await send(authority, [
      await buildUpdateEconomics({
        admin: authority,
        economics: { kindFeeMask: 0, kindFeeBps: [0, 0, 0, 0], partnerCutBps: 2_000, crankBounty: 0, createFee: 0 },
      }),
    ]);
    await open(2n, partner.address);
    const report = await solve(stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 2_000n));
    expect(report.filled).toHaveLength(1);
    const fees = splitFees(AMOUNT, 5, 50, 2_000);
    expect(balance(partnerTo)).toBe(fees.partner);
    expect(balance(feeTo)).toBe(fees.protocol);
    expect([balance(solverInput), balance(swapping.current?.to ?? solverInput)]).toEqual([0n, fees.net]);
  });

  it("skips what does not pay and keeps going after a failure", async () => {
    const thin = await open(3n);
    const broken = await open(4n);
    const good = await open(5n);
    const outs = new Map<Address, bigint | "throw">([
      [thin, MIN_OUT + 999n],
      [broken, "throw"],
      [good, MIN_OUT + 5_000n],
    ]);
    let current = 0;
    const order = [thin, broken, good];
    const pricer: Pricer = {
      async quote(request) {
        const which = order[current];
        current += 1;
        const out = which === undefined ? undefined : outs.get(which);
        if (out === "throw") {
          throw new Error("market unavailable");
        }
        return stashMarket(stash, stashAccount, outputMint, solverOutput, () => out ?? null).quote(request);
      },
    };
    const report = await solve(pricer, { concurrency: 1 });
    expect(report.skipped).toEqual([{ intent: thin, reason: "profit 999 is below 1000" }]);
    expect(report.failed).toEqual([{ intent: broken, error: "market unavailable" }]);
    expect(report.filled.map((f) => f.intent)).toEqual([good]);
    expect(balance(receiver)).toBe(MIN_OUT);
  });

  it("rides a cyclic arbitrage on the spread in the same transaction", async () => {
    const intent = await open(6n);
    const arbStash = await funded();
    const arbAccount = await ata(authority, arbStash.address, outputMint, 1_000_000n);
    const cycle = async (_mint: Address, amount: bigint): Promise<Quote> =>
      stashMarket(arbStash, arbAccount, outputMint, solverOutput, () => 2_500n).quote({
        inputMint: outputMint,
        outputMint,
        amountIn: amount,
        taker: solver.address,
      }) as Promise<Quote>;
    const report = await solve(stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 2_000n), {
      strategy: {
        minProfit: floors(1_000n),
        maxFeeBps: 100,
        cycle: async (m, amount) => {
          const q = await cycle(m, amount);
          return { ...q, amountOut: amount + q.amountOut };
        },
      },
    });
    expect(report.filled).toEqual([{ intent, profit: 4_500n, cost: expect.any(BigInt), signature: expect.any(String) }]);
    expect(balance(solverOutput)).toBe(4_500n);
    expect(balance(receiver)).toBe(MIN_OUT);
  });

  it("skips an intent whose fee or partner account does not exist yet", async () => {
    const partner = await funded();
    const loner = await open(8n, partner.address);
    const report = await solve(stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 9_000n));
    expect(report).toEqual({ filled: [], sent: [], skipped: [{ intent: loner, reason: "no partner account to pay into" }], failed: [] });
    const nofee = await mint(authority);
    await ata(authority, owner.address, nofee, 1_000_000n);
    await send(owner, [
      await buildCreateIntent({
        owner,
        treasury: feeRecipient.address,
        maxCreateFee: MAX_CREATE_FEE,
        maxBounty: MAX_CRANK_BOUNTY,
        nonce: 9n,
        params: { kind: Kind.SwapExactIn, amountIn: AMOUNT, minOut: MIN_OUT },
        expiresAt: NOW + 3_600n,
        inputMint: nofee,
        outputMint,
        inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        partner: { key: partner.address, bps: 50 },
      }),
    ]);
    const [both] = await findIntentPda({ owner: owner.address, nonce: 9n });
    intents.length = 0;
    intents.push(both);
    const again = await solve(stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 9_000n));
    expect(again.skipped).toEqual([{ intent: both, reason: "no fee or partner account to pay into" }]);
  });
});
