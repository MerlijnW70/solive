import { type Address, generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { attestedResult, dutchAuction, IntentCoreError, type IntentParams, Kind, limitOrder, swapExactIn } from "../src/index.js";
import {
  attestedFillPreimage,
  buildEd25519Instruction,
  ed25519Header,
  checkAttested,
  decodeParams,
  decodeParamsLoose,
  encodeParams,
  I64_MAX,
  I64_MIN,
  signedIntentPreimage,
  U64_MAX,
} from "../src/internal.js";
import { InvalidInput } from "../src/errors.js";

const roundTrip = (p: IntentParams) => decodeParams(p.kind, encodeParams(p));

const unsignedFields: [string, (v: bigint) => IntentParams][] = [
  ["swap amountIn", (v) => ({ kind: Kind.SwapExactIn, amountIn: v, minOut: 1n })],
  ["swap minOut", (v) => ({ kind: Kind.SwapExactIn, amountIn: 1n, minOut: v })],
  ["limit makeAmount", (v) => ({ kind: Kind.LimitOrder, makeAmount: v, takeAmount: 1n })],
  ["limit takeAmount", (v) => ({ kind: Kind.LimitOrder, makeAmount: 1n, takeAmount: v })],
  [
    "dutch amountIn",
    (v) => ({ kind: Kind.DutchAuction, amountIn: v, startOut: 2n, endOut: 1n, startTs: 0n, endTs: 1n }),
  ],
  [
    "dutch startOut",
    (v) => ({ kind: Kind.DutchAuction, amountIn: 1n, startOut: v, endOut: 1n, startTs: 0n, endTs: 1n }),
  ],
  [
    "dutch endOut",
    (v) => ({ kind: Kind.DutchAuction, amountIn: 1n, startOut: U64_MAX, endOut: v, startTs: 0n, endTs: 1n }),
  ],
];

const signedFields: [string, (v: bigint) => IntentParams][] = [
  [
    "dutch startTs",
    (v) => ({ kind: Kind.DutchAuction, amountIn: 1n, startOut: 2n, endOut: 1n, startTs: v, endTs: I64_MAX }),
  ],
  [
    "dutch endTs",
    (v) => ({ kind: Kind.DutchAuction, amountIn: 1n, startOut: 2n, endOut: 1n, startTs: I64_MIN, endTs: v }),
  ],
];

describe("params constructors", () => {
  it("build each kind's params that decode back to themselves", async () => {
    const attestor = (await generateKeyPairSigner()).address;
    const made: IntentParams[] = [
      swapExactIn({ amountIn: 7n, minOut: 3n }),
      limitOrder({ makeAmount: 7n, takeAmount: 3n }),
      dutchAuction({ amountIn: 7n, startOut: 9n, endOut: 3n, startTs: 10n, endTs: 20n }),
      attestedResult({ amountIn: 7n, minResult: 1n, maxResult: 1n, attestor, specHash: new Uint8Array(32).fill(5), judgeFee: 1n }),
    ];
    expect(made.map(({ kind }) => kind)).toEqual([Kind.SwapExactIn, Kind.LimitOrder, Kind.DutchAuction, Kind.AttestedResult]);
    for (const params of made) {
      expect(decodeParams(params.kind, encodeParams(params))).toEqual(params);
    }
  });
});

describe("params field ranges", () => {
  it("accept every unsigned field up to u64::MAX and reject negatives and overflow", () => {
    for (const [name, make] of unsignedFields) {
      expect(roundTrip(make(U64_MAX)), name).toEqual(make(U64_MAX));
      expect(() => encodeParams(make(0n)), name).not.toThrow();
      expect(() => encodeParams(make(-1n)), name).toThrow(InvalidInput);
      expect(() => encodeParams(make(U64_MAX + 1n)), name).toThrow(InvalidInput);
    }
  });

  it("accept every signed field across the i64 range and reject beyond it", () => {
    for (const [name, make] of signedFields) {
      expect(() => encodeParams(make(I64_MIN)), name).not.toThrow();
      expect(() => encodeParams(make(I64_MAX)), name).not.toThrow();
      expect(() => encodeParams(make(-5n)), name).not.toThrow();
      expect(() => encodeParams(make(I64_MIN - 1n)), name).toThrow(InvalidInput);
      expect(() => encodeParams(make(I64_MAX + 1n)), name).toThrow(InvalidInput);
    }
    const negative = {
      kind: Kind.DutchAuction,
      amountIn: 1n,
      startOut: 2n,
      endOut: 1n,
      startTs: -5n,
      endTs: 7n,
    } as const;
    expect(roundTrip(negative)).toEqual(negative);
  });

  it("pin the i64 bounds", () => {
    expect(I64_MIN).toBe(-9_223_372_036_854_775_808n);
    expect(I64_MAX).toBe(9_223_372_036_854_775_807n);
  });
});

describe("attested result params", () => {
  const ZERO = "11111111111111111111111111111111" as Address;

  it("round-trip the attestor and reject a zero attestor or trailing bytes", async () => {
    const attestor = (await generateKeyPairSigner()).address;
    const p = { kind: Kind.AttestedResult, amountIn: 5n, minResult: 1n, maxResult: 9n, attestor, specHash: new Uint8Array(32), judgeFee: 0n } as const;
    const bytes = encodeParams(p);
    expect(decodeParams(4, bytes)).toEqual(p);
    expect(() => encodeParams({ ...p, attestor: ZERO })).not.toThrow();
    expect(() => decodeParams(4, encodeParams({ ...p, attestor: ZERO }))).toThrow(
      new IntentCoreError("InvalidParams"),
    );
    const trailing = bytes.slice();
    trailing[96] = 1;
    expect(() => decodeParams(4, trailing)).toThrow(new IntentCoreError("NonCanonical"));
    const specCommitment = bytes.slice();
    specCommitment[56] = 1;
    expect(decodeParams(4, specCommitment).kind).toBe(Kind.AttestedResult);
    const lastKeyByte = bytes.slice();
    lastKeyByte[55] = (lastKeyByte[55] ?? 0) ^ 1;
    expect(() => decodeParams(4, lastKeyByte)).not.toThrow();
  });

  it("validate the result bounds and the amount", async () => {
    const attestor = (await generateKeyPairSigner()).address;
    const p = { kind: Kind.AttestedResult, amountIn: 5n, minResult: 10n, maxResult: 20n, attestor, specHash: new Uint8Array(32), judgeFee: 0n } as const;
    expect(roundTrip({ ...p, minResult: 20n })).toEqual({ ...p, minResult: 20n });
    expect(() => roundTrip({ ...p, minResult: 21n })).toThrow(new IntentCoreError("InvalidParams"));
    expect(() => roundTrip({ ...p, amountIn: 0n })).toThrow(new IntentCoreError("InvalidParams"));
    expect(checkAttested(p, 5n, 10n)).toBe(attestor);
    expect(checkAttested(p, 5n, 20n)).toBe(attestor);
    expect(() => checkAttested(p, 5n, 9n)).toThrow(new IntentCoreError("ResultOutOfBounds"));
    expect(() => checkAttested(p, 5n, 21n)).toThrow(new IntentCoreError("ResultOutOfBounds"));
    expect(() => checkAttested(p, 4n, 15n)).toThrow(new IntentCoreError("AmountMismatch"));
    expect(() =>
      checkAttested({ kind: Kind.SwapExactIn, amountIn: 5n, minOut: 1n }, 5n, 15n),
    ).toThrow(new IntentCoreError("KindMismatch"));
  });
});

describe("signature builders refuse malformed inputs", () => {
  const owner = "11111111111111111111111111111111" as Address;

  it("require a 32-byte domain and 128-byte params", async () => {
    const f = {
      domain: new Uint8Array(32),
      owner,
      ownerInput: owner,
      inputMint: owner,
      outputMint: owner,
      receiver: owner,
      nonce: 0n,
      expiresAt: 0n,
      submitBy: 0n,
      kind: 1,
      params: new Uint8Array(128),
      epoch: 0n,
    };
    await expect(signedIntentPreimage(f)).resolves.toHaveLength(448);
    await expect(signedIntentPreimage({ ...f, domain: new Uint8Array(31) })).rejects.toThrow(InvalidInput);
    await expect(signedIntentPreimage({ ...f, params: new Uint8Array(127) })).rejects.toThrow(InvalidInput);
    const a = { domain: new Uint8Array(32), intent: owner, payee: owner, amountIn: 1n, result: 1n, maxFeeBps: 0 };
    await expect(attestedFillPreimage(a)).resolves.toHaveLength(206);
    await expect(attestedFillPreimage({ ...a, domain: new Uint8Array(33) })).rejects.toThrow(InvalidInput);
  });

  it("require a 64-byte signature", () => {
    expect(() =>
      buildEd25519Instruction({ publicKey: owner, signature: new Uint8Array(63), message: new Uint8Array(1) }),
    ).toThrow(InvalidInput);
    const ix = buildEd25519Instruction({
      publicKey: owner,
      signature: new Uint8Array(64),
      message: new Uint8Array(3),
    });
    expect(ix.data).toHaveLength(115);
  });
});

describe("loose params decoding", () => {
  it("passes known kinds through and keeps the raw bytes of a kind it does not know", () => {
    const swap = { kind: Kind.SwapExactIn, amountIn: 5n, minOut: 1n } as const;
    expect(decodeParamsLoose(swap.kind, encodeParams(swap))).toEqual(swap);
    const raw = new Uint8Array(128).fill(3);
    const loose = decodeParamsLoose(9, raw);
    expect(loose).toEqual({ kind: 9, unknown: true, raw, reason: "UnknownKind" });
    raw[0] = 4;
    expect("raw" in loose && loose.raw[0]).toBe(3);
  });

  it("keeps the raw bytes and the reason when a known kind does not decode, and refuses the wrong length", () => {
    const bad = encodeParams({ kind: Kind.SwapExactIn, amountIn: 5n, minOut: 1n });
    bad[127] = 1;
    expect(decodeParamsLoose(Kind.SwapExactIn, bad)).toEqual({
      kind: Kind.SwapExactIn,
      unknown: true,
      raw: bad,
      reason: "NonCanonical",
    });
    const zero = encodeParams({ kind: Kind.SwapExactIn, amountIn: 1n, minOut: 1n }).fill(0);
    expect(decodeParamsLoose(Kind.SwapExactIn, zero)).toMatchObject({ unknown: true, reason: "InvalidParams" });
    expect(() => decodeParamsLoose(9, new Uint8Array(3))).toThrow(InvalidInput);
    expect(() => decodeParamsLoose(Kind.SwapExactIn, new Uint8Array(129))).toThrow(InvalidInput);
  });
});

describe("Ed25519 instruction header", () => {
  it("accepts every message length the u16 offsets can address and nothing else", () => {
    expect(ed25519Header(0)).toHaveLength(16);
    expect(ed25519Header(0xffff)).toHaveLength(16);
    for (const bad of [-1, 0x10000, 1.5]) {
      expect(() => ed25519Header(bad)).toThrow(
        `an Ed25519 message of ${bad} bytes does not fit the instruction header`,
      );
    }
  });
});
