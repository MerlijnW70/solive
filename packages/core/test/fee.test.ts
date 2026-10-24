import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Address } from "@solana/kit";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  tokenOf,
  BPS_DENOMINATOR,
  checkSignable,
  createExt,
  ATTESTED_PROTOCOL_FEE,
  describeTerms,
  encodeParams,
  IntentCoreError,
  Kind,
  mulDivCeil,
  mulDivFloor,
  type SignedIntentFields,
  releaseSettles,
  settleBounds,
  splitFee,
  splitFees,
  U64_MAX,
} from "../src/index.js";
import { InvalidInput } from "../src/errors.js";

const RUNS = Number(process.env["PROPERTY_RUNS"] ?? 500);
const amount = fc.oneof(fc.bigInt({ min: 0n, max: U64_MAX }), fc.constantFrom(0n, 1n, 9_999n, 10_000n, U64_MAX - 1n, U64_MAX));
const bps = fc.oneof(fc.integer({ min: 0, max: 10_000 }), fc.constantFrom(0, 1, 9_999, 10_000));

const codeOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error instanceof IntentCoreError ? error.engineError : String(error);
  }
  return "ok";
};

describe("fee splits", () => {
  it("round a fee up to the next whole unit and never take more than the amount", () => {
    expect(BPS_DENOMINATOR).toBe(10_000n);
    expect(splitFee(0n, 30)).toEqual({ fee: 0n, net: 0n });
    expect(splitFee(1n, 1)).toEqual({ fee: 1n, net: 0n });
    expect(splitFee(10_000n, 30)).toEqual({ fee: 30n, net: 9_970n });
    expect(splitFee(10_001n, 30)).toEqual({ fee: 31n, net: 9_970n });
    expect(splitFee(U64_MAX, 10_000)).toEqual({ fee: U64_MAX, net: 0n });
  });

  it("fee helpers refuse out of range inputs", () => {
    for (const bad of [-1, 65_536, 1.5, Number.NaN]) {
      expect(() => splitFee(100n, bad), String(bad)).toThrow(`fee bps ${String(bad)} is not between 0 and 65535`);
      expect(() => splitFee(0n, bad), String(bad)).toThrow(`fee bps ${String(bad)} is not between 0 and 65535`);
      expect(() => splitFees(100n, bad, 0, 0), String(bad)).toThrow(InvalidInput);
      expect(() => splitFees(100n, 0, bad, 0), String(bad)).toThrow(InvalidInput);
      expect(() => splitFees(100n, 0, 1, bad), String(bad)).toThrow(InvalidInput);
    }
    expect(() => splitFee(100n, -50)).toThrow(InvalidInput);
    for (const bad of [-1n, U64_MAX + 1n]) {
      expect(() => splitFee(bad, 30)).toThrow(InvalidInput);
      expect(() => splitFees(bad, 30, 0, 0)).toThrow(InvalidInput);
      expect(() => mulDivFloor(bad, 1n, 1n)).toThrow(InvalidInput);
      expect(() => mulDivCeil(1n, bad, 1n)).toThrow(InvalidInput);
      expect(() => mulDivFloor(1n, 1n, bad)).toThrow(InvalidInput);
    }
    expect(splitFee(U64_MAX, 10_000)).toEqual({ fee: U64_MAX, net: 0n });
    expect(splitFees(0n, 10_000, 0, 10_000)).toEqual({ protocol: 0n, partner: 0n, net: 0n });
    expect(codeOf(() => mulDivFloor(1n, 1n, 0n))).toBe("DivideByZero");
  });

  it("take any u16 bps the program takes and refuse only where the program refuses", () => {
    expect(splitFee(0n, 18_449)).toEqual({ fee: 0n, net: 0n });
    expect(splitFee(0n, 65_535)).toEqual({ fee: 0n, net: 0n });
    expect(codeOf(() => splitFee(100n, 10_001))).toBe("InvalidParams");
    expect(splitFees(0n, 10_001, 0, 0)).toEqual({ protocol: 0n, partner: 0n, net: 0n });
    expect(splitFees(100n, 0, 1, 10_001)).toEqual({ protocol: 1n, partner: 0n, net: 99n });
    expect(codeOf(() => splitFees(100n, 0, 10_001, 0))).toBe("InvalidParams");
    expect(releaseSettles({ amount: 1n, judgeFee: 0n, feeBps: 15_387, partnerBps: 147, cutBps: 0 })).toBe(false);
    expect(releaseSettles({ amount: 1n, judgeFee: 0n, feeBps: 0, partnerBps: 0, cutBps: 65_535 })).toBe(true);
  });

  it("split protocol, partner and net exactly, with the protocol cut taken from the partner", () => {
    expect(splitFees(100_000n, 5, 50, 2_000)).toEqual({ protocol: 150n, partner: 400n, net: 99_450n });
    expect(splitFees(100_000n, 0, 0, 0)).toEqual({ protocol: 0n, partner: 0n, net: 100_000n });
    expect(splitFees(100_000n, 0, 50, 10_000)).toEqual({ protocol: 500n, partner: 0n, net: 99_500n });
    expect(codeOf(() => splitFees(1n, 1, 1, 0))).toBe("InvalidParams");
    expect(splitFees(U64_MAX, 10_000, 0, 0)).toEqual({ protocol: U64_MAX, partner: 0n, net: 0n });
  });

  it("always add back up to the amount for any fee within one hundred percent", () => {
    fc.assert(
      fc.property(amount, bps, (a, b) => {
        const s = splitFee(a, b);
        expect(s.fee + s.net).toBe(a);
        expect(s.fee * BPS_DENOMINATOR >= a * BigInt(b)).toBe(true);
        expect(s.fee === 0n || (s.fee - 1n) * BPS_DENOMINATOR < a * BigInt(b)).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });

  it("conserve every split that succeeds and fail only with named errors", () => {
    fc.assert(
      fc.property(amount, bps, bps, bps, (a, fee, partner, cut) => {
        const code = codeOf(() => splitFees(a, fee, partner, cut));
        if (code !== "ok") {
          expect(["InvalidParams", "Overflow"]).toContain(code);
          expect(fee + partner > 0).toBe(true);
          return;
        }
        const f = splitFees(a, fee, partner, cut);
        expect(f.protocol + f.partner + f.net).toBe(a);
        expect(f.protocol >= splitFee(a, fee).fee).toBe(true);
        expect(f.net <= splitFee(a, fee).net).toBe(true);
        expect(f.partner >= 0n && f.net >= 0n).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });
});

const IN = "So11111111111111111111111111111111111111112" as Address;
const OUT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;
const ATTESTOR = "11111111111111111111111111111112" as Address;

describe("terms an owner reads before signing", () => {
  it("name what each kind sells and the least it accepts", () => {
    const terms = (params: Parameters<typeof encodeParams>[0]) =>
      describeTerms({ kind: params.kind, params: encodeParams(params), inputMint: IN, outputMint: OUT }, { inputDecimals: 9, outputDecimals: 6 });
    expect(terms({ kind: Kind.SwapExactIn, amountIn: 1_500_000_000n, minOut: 2_000_000n })).toEqual([
      `Sell: exactly 1.5 of ${IN}`,
      `Receive: at least 2 of ${OUT}`,
    ]);
    expect(terms({ kind: Kind.LimitOrder, makeAmount: 1n, takeAmount: 1n })).toEqual([
      `Sell: exactly 0.000000001 of ${IN}`,
      `Receive: at least 0.000001 of ${OUT}`,
    ]);
    expect(terms({ kind: Kind.DutchAuction, amountIn: 10n, startOut: 9n, endOut: 3n, startTs: 0n, endTs: 60n })).toEqual([
      `Sell: exactly 0.00000001 of ${IN}`,
      `Receive: at least 0.000009 of ${OUT} at 1970-01-01T00:00:00.000Z, falling to 0.000003 of ${OUT} at 1970-01-01T00:01:00.000Z`,
    ]);
    expect(terms({ kind: Kind.AttestedResult, amountIn: 10n, minResult: 1n, maxResult: 2n, attestor: ATTESTOR, specHash: new Uint8Array(32), judgeFee: 0n })).toEqual([
      `Sell: exactly 0.00000001 of ${IN}`,
      `Settles: when ${ATTESTOR} attests a result between 1 and 2`,
      `Payee: chosen by ${ATTESTOR} when it attests; one signature from it pays the sold amount, less fees, to any wallet it signs for`,
      ATTESTED_PROTOCOL_FEE,
      `Output token: ${OUT}, a label only; the release pays out the sold token, never this one`,
    ]);
  });

  it("put a name the caller knows in front of the mint it stands for, and nothing when it knows none", () => {
    const named = { inputDecimals: 9, outputDecimals: 6, inputName: "SOL", outputName: "USD" };
    const terms = (params: Parameters<typeof encodeParams>[0], o: Parameters<typeof describeTerms>[1]) =>
      describeTerms({ kind: params.kind, params: encodeParams(params), inputMint: IN, outputMint: OUT }, o);
    expect(terms({ kind: Kind.SwapExactIn, amountIn: 1_500_000_000n, minOut: 2_000_000n }, named)).toEqual([
      `Sell: exactly 1.5 of SOL (${IN})`,
      `Receive: at least 2 of USD (${OUT})`,
    ]);
    expect(terms({ kind: Kind.AttestedResult, amountIn: 10n, minResult: 1n, maxResult: 2n, attestor: ATTESTOR, specHash: new Uint8Array(32), judgeFee: 0n }, { outputName: "USD" }).at(-1)).toBe(
      `Output token: USD (${OUT}), a label only; the release pays out the sold token, never this one`,
    );
    expect(terms({ kind: Kind.SwapExactIn, amountIn: 1n, minOut: 1n }, { inputName: "SOL" })).toEqual([`Sell: exactly 1 raw units of SOL (${IN})`, `Receive: at least 1 raw units of ${OUT}`]);
    expect(tokenOf(OUT, undefined)).toBe(OUT);
  });

  it("refuse to sign unknown flags or a malformed extension and pass sound fields through unchanged", () => {
    const fields: SignedIntentFields = {
      domain: new Uint8Array(32),
      owner: ATTESTOR,
      ownerInput: ATTESTOR,
      inputMint: IN,
      outputMint: OUT,
      receiver: ATTESTOR,
      nonce: 0n,
      expiresAt: 1n,
      submitBy: 1n,
      kind: Kind.SwapExactIn,
      params: encodeParams({ kind: Kind.SwapExactIn, amountIn: 1n, minOut: 1n }),
      epoch: 0n,
    };
    expect(checkSignable(fields)).toBe(fields);
    const partnered = { ...fields, ext: createExt({ partner: { key: OUT, bps: 30 } }) };
    expect(checkSignable(partnered)).toBe(partnered);
    expect(codeOf(() => checkSignable({ ...fields, flags: 1 }))).toBe("FlagsUnknown");
    expect(codeOf(() => checkSignable({ ...fields, ext: new Uint8Array([1, 2]) }))).not.toBe("ok");
    expect(codeOf(() => checkSignable({ ...fields, ext: new Uint8Array([9, 0, 0]) }))).not.toBe("ok");
  });
});

describe("release settlement", () => {
  const terms = { feeBps: 5, partnerBps: 50, cutBps: 0 };

  it("settles only when the amount after the judge fee covers the rounded-up fees", () => {
    expect(releaseSettles({ ...terms, amount: 2n, judgeFee: 1n })).toBe(false);
    expect(releaseSettles({ ...terms, amount: 3n, judgeFee: 1n })).toBe(true);
    expect(releaseSettles({ ...terms, amount: 1n, judgeFee: 1n })).toBe(false);
    expect(releaseSettles({ ...terms, amount: 0n, judgeFee: 0n })).toBe(false);
    expect(releaseSettles({ ...terms, partnerBps: 0, amount: 1n, judgeFee: 0n })).toBe(true);
    expect(releaseSettles({ ...terms, partnerBps: 0, amount: 5n, judgeFee: 5n })).toBe(false);
  });

  it("names the least amount and the most judge fee that settle", () => {
    expect(settleBounds({ ...terms, amount: 2n, judgeFee: 1n })).toEqual({ leastAmount: 3n, mostJudgeFee: 0n });
    expect(settleBounds({ ...terms, amount: 10n, judgeFee: 10n })).toEqual({ leastAmount: 12n, mostJudgeFee: 8n });
    expect(settleBounds({ ...terms, amount: 1n, judgeFee: 0n })).toEqual({ leastAmount: 2n });
    expect(settleBounds({ ...terms, partnerBps: 0, amount: 0n, judgeFee: 0n })).toEqual({ leastAmount: 1n });
    expect(settleBounds({ feeBps: 6_000, partnerBps: 5_000, cutBps: 0, amount: 9n, judgeFee: 0n })).toEqual({});
  });

  it("searches rests up to a whole denominator and names a least amount of exactly u64 max", () => {
    const whole = { feeBps: 1, partnerBps: 9_999, cutBps: 0 };
    expect(releaseSettles({ ...whole, amount: BPS_DENOMINATOR - 1n, judgeFee: 0n })).toBe(false);
    expect(settleBounds({ ...whole, amount: BPS_DENOMINATOR, judgeFee: 0n })).toStrictEqual({ leastAmount: BPS_DENOMINATOR, mostJudgeFee: 0n });
    expect(settleBounds({ ...terms, partnerBps: 0, feeBps: 0, amount: U64_MAX, judgeFee: U64_MAX - 1n })).toStrictEqual({ leastAmount: U64_MAX, mostJudgeFee: U64_MAX - 1n });
    expect(settleBounds({ ...terms, partnerBps: 0, feeBps: 0, amount: 0n, judgeFee: U64_MAX })).toStrictEqual({});
  });

  it("agrees with the release fee split for any terms", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 100_000n }), fc.bigInt({ min: 0n, max: 100_000n }), fc.integer({ min: 0, max: 300 }), fc.integer({ min: 0, max: 100 }), (amount, judgeFee, feeBps, partnerBps) => {
        const t = { amount, judgeFee, feeBps, partnerBps, cutBps: 2_000 };
        const direct = amount > judgeFee && codeOf(() => splitFees(amount - judgeFee, feeBps, partnerBps, 2_000)) === "ok";
        expect(releaseSettles(t)).toBe(direct);
        const bounds = settleBounds(t);
        if (bounds.leastAmount !== undefined) {
          expect(releaseSettles({ ...t, amount: bounds.leastAmount })).toBe(true);
          expect(bounds.leastAmount === judgeFee + 1n || !releaseSettles({ ...t, amount: bounds.leastAmount - 1n })).toBe(true);
        }
        if (bounds.mostJudgeFee !== undefined) {
          expect(releaseSettles({ ...t, judgeFee: bounds.mostJudgeFee })).toBe(true);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("agrees with the program's release_settles on every case of the shared table", () => {
    const table = JSON.parse(readFileSync(fileURLToPath(new URL("./golden/release-settles.json", import.meta.url)), "utf8")) as {
      cases: { amount: string; judge_fee: string; fee_bps: number; partner_bps: number; cut_bps: number; settles: boolean }[];
    };
    expect(table.cases.length).toBeGreaterThan(400);
    expect(table.cases.some((c) => c.settles)).toBe(true);
    expect(table.cases.some((c) => !c.settles)).toBe(true);
    for (const c of table.cases) {
      const t = { amount: BigInt(c.amount), judgeFee: BigInt(c.judge_fee), feeBps: c.fee_bps, partnerBps: c.partner_bps, cutBps: c.cut_bps };
      expect(releaseSettles(t), JSON.stringify(c)).toBe(c.settles);
    }
  });
});
