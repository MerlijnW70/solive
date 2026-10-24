import { type Address, getAddressDecoder, getAddressEncoder } from "@solana/kit";
import { IntentCoreError, InvalidInput } from "./errors.js";
import { mulDivCeil, mulDivFloor, U64_MAX } from "./math.js";

export const PARAMS_LEN = 128;
export const I64_MIN = -(1n << 63n);
export const I64_MAX = (1n << 63n) - 1n;
const ZERO_KEY = "11111111111111111111111111111111" as Address;

export enum Kind {
  SwapExactIn = 1,
  LimitOrder = 2,
  DutchAuction = 3,
  AttestedResult = 4,
}

export const ALL_KINDS_MASK = (1n << 1n) | (1n << 2n) | (1n << 3n) | (1n << 4n);

export function kindBit(kind: Kind): bigint {
  return 1n << BigInt(kind);
}

export type SwapExactInParams = { kind: Kind.SwapExactIn; amountIn: bigint; minOut: bigint };
export type LimitOrderParams = { kind: Kind.LimitOrder; makeAmount: bigint; takeAmount: bigint };
export type DutchAuctionParams = {
  kind: Kind.DutchAuction;
  amountIn: bigint;
  startOut: bigint;
  endOut: bigint;
  startTs: bigint;
  endTs: bigint;
};
export type AttestedResultParams = {
  kind: Kind.AttestedResult;
  amountIn: bigint;
  minResult: bigint;
  maxResult: bigint;
  attestor: Address;
  specHash: Uint8Array;
  judgeFee: bigint;
};
export type IntentParams =
  | SwapExactInParams
  | LimitOrderParams
  | DutchAuctionParams
  | AttestedResultParams;

type Field =
  | { type: "u64"; value: bigint }
  | { type: "i64"; value: bigint }
  | { type: "key"; value: Address }
  | { type: "bytes32"; value: Uint8Array };

const u64 = (value: bigint): Field => ({ type: "u64", value });
const i64 = (value: bigint): Field => ({ type: "i64", value });

function fields(intent: IntentParams): readonly Field[] {
  switch (intent.kind) {
    case Kind.SwapExactIn:
      return [u64(intent.amountIn), u64(intent.minOut)];
    case Kind.LimitOrder:
      return [u64(intent.makeAmount), u64(intent.takeAmount)];
    case Kind.DutchAuction:
      return [
        u64(intent.amountIn),
        u64(intent.startOut),
        u64(intent.endOut),
        i64(intent.startTs),
        i64(intent.endTs),
      ];
    case Kind.AttestedResult:
      return [
        u64(intent.amountIn),
        u64(intent.minResult),
        u64(intent.maxResult),
        { type: "key", value: intent.attestor },
        { type: "bytes32", value: intent.specHash },
        u64(intent.judgeFee),
      ];
  }
}

const width = (f: Field) => (f.type === "key" || f.type === "bytes32" ? 32 : 8);

export function validate(intent: IntentParams): IntentParams {
  const bad = (() => {
    switch (intent.kind) {
      case Kind.SwapExactIn:
        return intent.amountIn === 0n || intent.minOut === 0n;
      case Kind.LimitOrder:
        return intent.makeAmount === 0n || intent.takeAmount === 0n;
      case Kind.DutchAuction:
        return (
          intent.amountIn === 0n ||
          intent.endOut === 0n ||
          intent.startOut < intent.endOut ||
          intent.startTs >= intent.endTs
        );
      case Kind.AttestedResult:
        return (
          intent.amountIn === 0n ||
          intent.minResult > intent.maxResult ||
          intent.attestor === ZERO_KEY ||
          (intent.specHash.every((b) => b === 0)
            ? intent.judgeFee !== 0n
            : intent.judgeFee >= intent.amountIn)
        );
    }
  })();
  if (bad) {
    throw new IntentCoreError("InvalidParams");
  }
  return intent;
}

export function encodeParams(intent: IntentParams): Uint8Array {
  const out = new Uint8Array(PARAMS_LEN);
  const view = new DataView(out.buffer);
  let at = 0;
  fields(intent).forEach((field, i) => {
    if (field.type === "key") {
      out.set(getAddressEncoder().encode(field.value), at);
    } else if (field.type === "bytes32") {
      if (field.value.length !== 32) {
        throw new InvalidInput("params", "length", `params field ${i} must be 32 bytes`);
      }
      out.set(field.value, at);
    } else {
      const [lo, hi] = field.type === "i64" ? [I64_MIN, I64_MAX] : [0n, U64_MAX];
      if (field.value < lo || field.value > hi) {
        throw new InvalidInput("params", "range", `params field ${i} is outside [${lo}, ${hi}]`);
      }
      view.setBigUint64(at, BigInt.asUintN(64, field.value), true);
    }
    at += width(field);
  });
  return out;
}

function kindOf(code: number): Kind {
  switch (code) {
    case 1:
      return Kind.SwapExactIn;
    case 2:
      return Kind.LimitOrder;
    case 3:
      return Kind.DutchAuction;
    case 4:
      return Kind.AttestedResult;
    default:
      throw new IntentCoreError("UnknownKind");
  }
}

export function decodeParams(code: number, params: Uint8Array): IntentParams {
  if (params.length !== PARAMS_LEN) {
    throw new InvalidInput("params", "length", `params must be ${PARAMS_LEN} bytes, got ${params.length}`);
  }
  const kind = kindOf(code);
  const view = new DataView(params.buffer, params.byteOffset, params.byteLength);
  const u = (i: number) => view.getBigUint64(i * 8, true);
  const s = (i: number) => view.getBigInt64(i * 8, true);
  const intent: IntentParams = (() => {
    switch (kind) {
      case Kind.SwapExactIn:
        return { kind, amountIn: u(0), minOut: u(1) };
      case Kind.LimitOrder:
        return { kind, makeAmount: u(0), takeAmount: u(1) };
      case Kind.DutchAuction:
        return {
          kind,
          amountIn: u(0),
          startOut: u(1),
          endOut: u(2),
          startTs: s(3),
          endTs: s(4),
        };
      case Kind.AttestedResult:
        return {
          kind,
          amountIn: u(0),
          minResult: u(1),
          maxResult: u(2),
          attestor: getAddressDecoder().decode(params.subarray(24, 56)),
          specHash: params.slice(56, 88),
          judgeFee: u(11),
        };
    }
  })();
  const used = fields(intent).reduce((n, f) => n + width(f), 0);
  if (params.subarray(used).some((b) => b !== 0)) {
    throw new IntentCoreError("NonCanonical");
  }
  return validate(intent);
}

export type UnknownParams = { kind: number; unknown: true; raw: Uint8Array; reason: string };

export function decodeParamsLoose(code: number, params: Uint8Array): IntentParams | UnknownParams {
  try {
    return decodeParams(code, params);
  } catch (error) {
    if (error instanceof IntentCoreError) {
      return { kind: code, unknown: true, raw: params.slice(), reason: error.engineError };
    }
    throw error;
  }
}

export function escrowAmount(intent: IntentParams): bigint {
  switch (intent.kind) {
    case Kind.SwapExactIn:
      return intent.amountIn;
    case Kind.LimitOrder:
      return intent.makeAmount;
    case Kind.DutchAuction:
      return intent.amountIn;
    case Kind.AttestedResult:
      return intent.amountIn;
  }
}

export function fitsExpiry(intent: IntentParams, expiresAt: bigint): boolean {
  return intent.kind !== Kind.DutchAuction || intent.endTs <= expiresAt;
}

export function requiredOut(intent: IntentParams, amountIn: bigint, now: bigint): bigint {
  switch (intent.kind) {
    case Kind.SwapExactIn:
      if (amountIn !== intent.amountIn) {
        throw new IntentCoreError("AmountMismatch");
      }
      return intent.minOut;
    case Kind.LimitOrder:
      if (amountIn === 0n || amountIn > intent.makeAmount) {
        throw new IntentCoreError("AmountMismatch");
      }
      return mulDivCeil(intent.takeAmount, amountIn, intent.makeAmount);
    case Kind.DutchAuction: {
      if (amountIn !== intent.amountIn) {
        throw new IntentCoreError("AmountMismatch");
      }
      const t = now < intent.startTs ? intent.startTs : now > intent.endTs ? intent.endTs : now;
      const decay = mulDivFloor(
        intent.startOut - intent.endOut,
        t - intent.startTs,
        intent.endTs - intent.startTs,
      );
      return intent.startOut - decay;
    }
    case Kind.AttestedResult:
      throw new IntentCoreError("KindMismatch");
  }
}

export function checkAttested(intent: IntentParams, amountIn: bigint, result: bigint): Address {
  if (intent.kind !== Kind.AttestedResult) {
    throw new IntentCoreError("KindMismatch");
  }
  if (amountIn !== intent.amountIn) {
    throw new IntentCoreError("AmountMismatch");
  }
  if (result < intent.minResult || result > intent.maxResult) {
    throw new IntentCoreError("ResultOutOfBounds");
  }
  return intent.attestor;
}

export type KindName = keyof typeof Kind;

export function kindName(kind: number): KindName | undefined {
  const name: unknown = Kind[kind];
  return typeof name === "string" ? (name as KindName) : undefined;
}

export type Terms = {
  kind: Kind;
  kindName: KindName;
  params: IntentParams;
  sells: bigint;
  receivesAtLeast: bigint | null;
};

export function termsOf(
  intent: { kind: number; params: ArrayLike<number> },
  now: bigint = BigInt(Math.floor(Date.now() / 1000)),
): Terms {
  const params = decodeParams(intent.kind, Uint8Array.from(intent.params));
  const sells = escrowAmount(params);
  return {
    kind: params.kind,
    kindName: Kind[params.kind] as KindName,
    params,
    sells,
    receivesAtLeast: params.kind === Kind.AttestedResult ? null : requiredOut(params, sells, now),
  };
}
