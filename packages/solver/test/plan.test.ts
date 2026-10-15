import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  type Config,
  encodeParams,
  type Intent,
  IntentStatus,
  Kind,
  kindBit,
  PAUSE_FILL,
  splitFees,
} from "@intent-engine/core";
import { decide, type Pricer, type Quote, type QuoteRequest, type Strategy } from "../src/index.js";

const KEY = "11111111111111111111111111111112" as Address;
const PARTNER = "SysvarC1ock11111111111111111111111111111111" as Address;
const SOLVER = "SysvarRent111111111111111111111111111111111" as Address;
const NOW = 1_700_000_000n;
const AMOUNT = 100_000n;
const MIN_OUT = 90_000n;

function intent(over: Partial<Intent> = {}): Intent {
  return {
    discriminator: new Uint8Array(8),
    owner: KEY,
    inputMint: KEY,
    outputMint: PARTNER,
    receiver: KEY,
    nonce: 1n,
    escrowed: AMOUNT,
    createdAt: NOW,
    expiresAt: NOW + 60n,
    kind: Kind.SwapExactIn,
    status: IntentStatus.Open,
    bump: 255,
    vaultBump: 255,
    version: 1,
    padding: new Uint8Array(1),
    flags: 0,
    params: encodeParams({ kind: Kind.SwapExactIn, amountIn: AMOUNT, minOut: MIN_OUT }),
    rentPayer: KEY,
    filled: 0n,
    revision: 0,
    partnerBps: 0,
    partnerCutBps: 2_000,
    inFlight: 0n,
    partner: KEY,
    bounty: 0,
    mandate: "11111111111111111111111111111111" as Address,
    gap: new Uint8Array(4),
    mandateSerial: 0n,
    agentFee: 0n,
    reserved: new Uint8Array(16),
    ...over,
  };
}

function config(over: Partial<Config> = {}): Config {
  return {
    discriminator: new Uint8Array(8),
    admin: KEY,
    pendingAdmin: KEY,
    guardian: KEY,
    feeRecipient: KEY,
    enabledKinds: 0b1_1110n,
    feeBps: 5,
    paused: 0,
    version: 1,
    bump: 255,
    kindFeeMask: 0,
    partnerCutBps: 2_000,
    domain: new Uint8Array(32),
    fillDisabledKinds: 0n,
    kindFeeBps: [0, 0, 0, 0],
    crankBounty: 0,
    createFee: 0,
    capsRequired: 0,
    reserved: new Uint8Array(7),
    ...over,
  };
}

function market(out: (amountIn: bigint) => bigint | null): Pricer & { asked: QuoteRequest[] } {
  const asked: QuoteRequest[] = [];
  return {
    asked,
    async quote(request) {
      asked.push(request);
      const amountOut = out(request.amountIn);
      return amountOut === null ? null : { amountIn: request.amountIn, amountOut, instructions: [], lookupTables: [] };
    },
  };
}

const floors = (raw: bigint) => new Map([[PARTNER, raw]]);
const strategy: Strategy = { minProfit: floors(1_000n), maxFeeBps: 100 };
const pays = (amountOut: bigint) => market(() => amountOut);

describe("fill decisions", () => {
  it("fills when the guaranteed output beats the requirement by the minimum profit", async () => {
    const pricer = pays(MIN_OUT + 1_000n);
    const d = await decide(KEY, intent(), config(), NOW, pricer, SOLVER, strategy);
    const fees = splitFees(AMOUNT, 5, 0, 2_000);
    expect(d).toEqual({
      kind: "fill",
      plan: expect.objectContaining({
        amountIn: AMOUNT,
        required: MIN_OUT,
        feeBps: 5,
        fees,
        profit: 1_000n,
        arbitrage: null,
      }),
    });
    expect(pricer.asked).toEqual([{ inputMint: KEY, outputMint: PARTNER, amountIn: fees.net, taker: SOLVER }]);
    const short = await decide(KEY, intent(), config(), NOW, pays(MIN_OUT + 999n), SOLVER, strategy);
    expect(short).toEqual({ kind: "skip", reason: "profit 999 is below 1000" });
  });

  it("sells only what remains after the protocol fee and the partner share", async () => {
    const pricer = pays(MIN_OUT + 5_000n);
    const partnered = intent({ partner: PARTNER, partnerBps: 50 });
    const d = await decide(KEY, partnered, config({ kindFeeMask: 0b10, kindFeeBps: [7, 0, 0, 0] }), NOW, pricer, SOLVER, strategy);
    const fees = splitFees(AMOUNT, 7, 50, 2_000);
    expect(d.kind === "fill" ? [d.plan.feeBps, d.plan.fees] : d).toEqual([7, fees]);
    expect(pricer.asked[0]?.amountIn).toBe(fees.net);
    const bounded = await decide(KEY, partnered, config(), NOW, pricer, SOLVER, { ...strategy, maxFeeBps: 54 });
    expect(bounded).toEqual({ kind: "skip", reason: "fees of 55 bps exceed the bound of 54" });
    const exact = await decide(KEY, partnered, config(), NOW, pricer, SOLVER, { ...strategy, maxFeeBps: 55 });
    expect(exact.kind).toBe("fill");
  });

  it("prices the remaining amount of a partly filled intent", async () => {
    const pricer = market((a) => a);
    const remaining = 40_000n;
    const half = intent({
      filled: AMOUNT - remaining,
      params: encodeParams({ kind: Kind.LimitOrder, makeAmount: AMOUNT, takeAmount: 1n }),
      kind: Kind.LimitOrder,
    });
    const d = await decide(KEY, half, config(), NOW, pricer, SOLVER, { ...strategy, minProfit: floors(0n) });
    expect(d.kind === "fill" ? d.plan.amountIn : d).toBe(remaining);
  });

  it("skips every intent the program would refuse to fill", async () => {
    const pricer = pays(MIN_OUT * 2n);
    const cases: [Intent, Config, bigint, string][] = [
      [intent({ version: 2 }), config(), NOW, "unsupported intent version 2"],
      [intent({ status: IntentStatus.Filled }), config(), NOW, "not open"],
      [intent(), config(), NOW + 60n, "expired"],
      [intent(), config({ paused: PAUSE_FILL }), NOW, "fills are paused"],
      [intent(), config({ fillDisabledKinds: kindBit(Kind.SwapExactIn) }), NOW, "fills of this kind are stopped"],
      [intent({ kind: 9 }), config(), NOW, "unreadable params: UnknownKind"],
      [
        intent({
          kind: Kind.AttestedResult,
          params: encodeParams({ kind: Kind.AttestedResult, amountIn: AMOUNT, minResult: 1n, maxResult: 2n, attestor: KEY, specHash: new Uint8Array(32), judgeFee: 0n }),
        }),
        config(),
        NOW,
        "settles only with an attestation",
      ],
    ];
    for (const [i, c, now, reason] of cases) {
      expect(await decide(KEY, i, c, now, pricer, SOLVER, strategy), reason).toEqual({ kind: "skip", reason });
    }
    expect(pricer.asked).toEqual([]);
    expect(await decide(KEY, intent(), config({ paused: 1 }), NOW + 59n, pricer, SOLVER, strategy)).toMatchObject({ kind: "fill" });
    expect(await decide(KEY, intent(), config({ fillDisabledKinds: kindBit(Kind.LimitOrder) }), NOW, pricer, SOLVER, strategy)).toMatchObject({
      kind: "fill",
    });
    expect(await decide(KEY, intent(), config(), NOW, market(() => null), SOLVER, strategy)).toEqual({
      kind: "skip",
      reason: "no route",
    });
  });

  it("rides a profitable cycle on the spread and ignores one that loses", async () => {
    const cycleQuote = (gain: bigint) => async (mint: Address, amount: bigint): Promise<Quote> => ({
      amountIn: amount,
      amountOut: amount + gain,
      instructions: [],
      lookupTables: [mint],
    });
    const pricer = pays(MIN_OUT + 2_000n);
    const win = await decide(KEY, intent(), config(), NOW, pricer, SOLVER, { ...strategy, cycle: cycleQuote(700n) });
    expect(win.kind === "fill" ? [win.plan.profit, win.plan.arbitrage?.amountIn] : win).toEqual([2_700n, 2_000n]);
    const flat = await decide(KEY, intent(), config(), NOW, pricer, SOLVER, { ...strategy, cycle: cycleQuote(0n) });
    expect(flat.kind === "fill" ? [flat.plan.profit, flat.plan.arbitrage] : flat).toEqual([2_000n, null]);
    const none = await decide(KEY, intent(), config(), NOW, pricer, SOLVER, { ...strategy, cycle: async () => null });
    expect(none.kind === "fill" ? none.plan.arbitrage : none).toBeNull();
    const asked: bigint[] = [];
    const watched = async (mint: Address, amount: bigint) => {
      asked.push(amount);
      return cycleQuote(1n)(mint, amount);
    };
    await decide(KEY, intent(), config(), NOW, pays(MIN_OUT), SOLVER, { ...strategy, minProfit: floors(0n), cycle: watched });
    expect(asked).toEqual([]);
  });

  it("never lets a cycle spend more than the spread, so it cannot touch the solver's own inventory", async () => {
    const pricer = pays(MIN_OUT + 2_000n);
    const greedy = async (mint: Address, amount: bigint): Promise<Quote> => ({
      amountIn: amount + 1n,
      amountOut: amount + 5_000n,
      instructions: [],
      lookupTables: [mint],
    });
    const d = await decide(KEY, intent(), config(), NOW, pricer, SOLVER, { ...strategy, cycle: greedy });
    expect(d.kind === "fill" ? [d.plan.profit, d.plan.arbitrage] : d).toEqual([2_000n, null]);
    const exact = async (mint: Address, amount: bigint): Promise<Quote> => ({ ...(await greedy(mint, amount)), amountIn: amount });
    const rides = await decide(KEY, intent(), config(), NOW, pricer, SOLVER, { ...strategy, cycle: exact });
    expect(rides.kind === "fill" ? rides.plan.arbitrage?.amountIn : rides).toBe(2_000n);
  });

  it("never fills from a route that pays less than the intent requires, whatever the profit floor", async () => {
    const short = await decide(KEY, intent(), config(), NOW, pays(MIN_OUT - 1n), SOLVER, { ...strategy, minProfit: floors(-10n) });
    expect(short).toEqual({ kind: "skip", reason: `the route pays ${MIN_OUT - 1n}, less than the ${MIN_OUT} the intent requires` });
    const even = await decide(KEY, intent(), config(), NOW, pays(MIN_OUT), SOLVER, { ...strategy, minProfit: floors(0n) });
    expect(even.kind === "fill" ? even.plan.profit : even).toBe(0n);
  });
});
