import type { Address } from "@solana/kit";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  tokenOf,
  BPS_DENOMINATOR,
  checkSignable,
  createExt,
  describeTerms,
  encodeParams,
  IntentCoreError,
  Kind,
  type SignedIntentFields,
  splitFee,
  splitFees,
  U64_MAX,
} from "../src/index.js";

const RUNS = Number(process.env["PROPERTY_RUNS"] ?? 500);
const amount = fc.oneof(fc.bigInt({ min: 0n, max: U64_MAX }), fc.constantFrom(0n, 1n, 9_999n, 10_000n, U64_MAX - 1n, U64_MAX));
const bps = fc.oneof(fc.integer({ min: 0, max: 10_000 }), fc.constantFrom(0, 1, 9_999, 10_000));

const codeOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    return error instanceof IntentCoreError ? error.code : String(error);
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
    expect(codeOf(() => splitFee(1n, 10_001))).toBe("InvalidParams");
    expect(splitFee(0n, 10_001)).toEqual({ fee: 0n, net: 0n });
  });

  it("split protocol, partner and net exactly, with the protocol cut taken from the partner", () => {
    expect(splitFees(100_000n, 5, 50, 2_000)).toEqual({ protocol: 150n, partner: 400n, net: 99_450n });
    expect(splitFees(100_000n, 0, 0, 0)).toEqual({ protocol: 0n, partner: 0n, net: 100_000n });
    expect(splitFees(100_000n, 0, 50, 10_000)).toEqual({ protocol: 500n, partner: 0n, net: 99_500n });
    expect(codeOf(() => splitFees(1n, 1, 1, 0))).toBe("InvalidParams");
    expect(codeOf(() => splitFees(1_000_000n, 0, 100, 10_001))).toBe("InvalidParams");
    expect(splitFees(100n, 0, 1, 10_001)).toEqual({ protocol: 1n, partner: 0n, net: 99n });
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
    expect(terms({ kind: Kind.AttestedResult, amountIn: 10n, minResult: 1n, maxResult: 2n, attestor: ATTESTOR })).toEqual([
      `Sell: exactly 0.00000001 of ${IN}`,
      `Settles: when ${ATTESTOR} attests a result between 1 and 2`,
      `Output token: ${OUT}, recorded with the intent only; an attested settlement pays you nothing on chain`,
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
    expect(terms({ kind: Kind.AttestedResult, amountIn: 10n, minResult: 1n, maxResult: 2n, attestor: ATTESTOR }, { outputName: "USD" })[2]).toBe(
      `Output token: USD (${OUT}), recorded with the intent only; an attested settlement pays you nothing on chain`,
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
