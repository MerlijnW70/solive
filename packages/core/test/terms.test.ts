import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { configSummary, IntentCoreError, Kind, kindName, type SummarizedConfig, termsOf } from "../src/index.js";
import { encodeParams, kindBit, PAUSE_CREATE, PAUSE_FILL } from "../src/internal.js";

const ADMIN = "11111111111111111111111111111112" as Address;
const GUARDIAN = "So11111111111111111111111111111111111111112" as Address;
const JUDGE = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;

describe("kind names", () => {
  it("names every kind and nothing else", () => {
    expect(kindName(Kind.SwapExactIn)).toBe("SwapExactIn");
    expect(kindName(Kind.LimitOrder)).toBe("LimitOrder");
    expect(kindName(Kind.DutchAuction)).toBe("DutchAuction");
    expect(kindName(Kind.AttestedResult)).toBe("AttestedResult");
    for (const unknown of [0, 5, 250, -1, 1.5]) {
      expect(kindName(unknown)).toBeUndefined();
    }
  });
});

describe("terms of an intent", () => {
  it("reads what a swap sells and the least it receives", () => {
    const params = { kind: Kind.SwapExactIn, amountIn: 50n, minOut: 7n } as const;
    expect(termsOf({ kind: Kind.SwapExactIn, params: encodeParams(params) })).toEqual({
      kind: Kind.SwapExactIn,
      kindName: "SwapExactIn",
      params,
      sells: 50n,
      receivesAtLeast: 7n,
    });
  });

  it("asks a limit order for its full take amount", () => {
    const params = { kind: Kind.LimitOrder, makeAmount: 30n, takeAmount: 9n } as const;
    const terms = termsOf({ kind: Kind.LimitOrder, params: encodeParams(params) });
    expect([terms.kindName, terms.sells, terms.receivesAtLeast]).toEqual(["LimitOrder", 30n, 9n]);
  });

  it("prices a dutch auction at the time given", () => {
    const params = { kind: Kind.DutchAuction, amountIn: 10n, startOut: 100n, endOut: 50n, startTs: 1_000n, endTs: 2_000n } as const;
    const at = (now: bigint) => termsOf({ kind: Kind.DutchAuction, params: encodeParams(params) }, now).receivesAtLeast;
    expect([at(0n), at(1_500n), at(9_999n)]).toEqual([100n, 75n, 50n]);
    const later = termsOf({ kind: Kind.DutchAuction, params: encodeParams({ ...params, startTs: 1n << 40n, endTs: (1n << 40n) + 1n }) });
    expect(later.receivesAtLeast).toBe(100n);
  });

  it("promises no output for an attested result", () => {
    const params = {
      kind: Kind.AttestedResult,
      amountIn: 40n,
      minResult: 1n,
      maxResult: 1n,
      attestor: JUDGE,
      specHash: new Uint8Array(32).fill(3),
      judgeFee: 4n,
    } as const;
    const terms = termsOf({ kind: Kind.AttestedResult, params: encodeParams(params) });
    expect([terms.kindName, terms.sells, terms.receivesAtLeast]).toEqual(["AttestedResult", 40n, null]);
  });

  it("refuses params it cannot decode", () => {
    expect(() => termsOf({ kind: 9, params: new Uint8Array(128) })).toThrow(IntentCoreError);
  });
});

describe("config summary", () => {
  const config: SummarizedConfig = {
    admin: ADMIN,
    guardian: GUARDIAN,
    paused: PAUSE_FILL,
    enabledKinds: kindBit(Kind.SwapExactIn) | kindBit(Kind.AttestedResult),
    fillDisabledKinds: kindBit(Kind.AttestedResult),
    feeBps: 5,
    kindFeeMask: 1 << Kind.LimitOrder,
    kindFeeBps: [0, 12, 0, 0],
    partnerCutBps: 2_000,
    createFee: 5_000,
    crankBounty: 1_000,
  };

  it("spells out pauses, per-kind switches and fees", () => {
    expect(configSummary(config)).toEqual({
      createPaused: false,
      fillPaused: true,
      kinds: [
        { kind: Kind.SwapExactIn, name: "SwapExactIn", create: true, fill: true, feeBps: 5 },
        { kind: Kind.LimitOrder, name: "LimitOrder", create: false, fill: true, feeBps: 12 },
        { kind: Kind.DutchAuction, name: "DutchAuction", create: false, fill: true, feeBps: 5 },
        { kind: Kind.AttestedResult, name: "AttestedResult", create: true, fill: false, feeBps: 5 },
      ],
      createFee: 5_000n,
      crankBounty: 1_000n,
      partnerCutBps: 2_000,
      admin: ADMIN,
      guardian: GUARDIAN,
    });
    const paused = configSummary({ ...config, paused: PAUSE_CREATE });
    expect([paused.createPaused, paused.fillPaused]).toEqual([true, false]);
  });
});
