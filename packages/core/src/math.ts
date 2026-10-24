import { IntentCoreError, InvalidInput } from "./errors.js";

export const U64_MAX = (1n << 64n) - 1n;

export function checkU64(value: bigint, name = "amount"): bigint {
  if (value < 0n || value > U64_MAX) {
    throw new InvalidInput(name, "range", `${name} ${String(value)} is not between 0 and ${U64_MAX}`);
  }
  return value;
}

function quotient(a: bigint, b: bigint, d: bigint): bigint {
  checkU64(a, "operand");
  checkU64(b, "operand");
  checkU64(d, "divisor");
  if (d === 0n) {
    throw new IntentCoreError("DivideByZero");
  }
  return (a * b) / d;
}

function fitU64(v: bigint): bigint {
  if (v > U64_MAX) {
    throw new IntentCoreError("Overflow");
  }
  return v;
}

export function mulDivFloor(a: bigint, b: bigint, d: bigint): bigint {
  return fitU64(quotient(a, b, d));
}

export function mulDivCeil(a: bigint, b: bigint, d: bigint): bigint {
  const q = quotient(a, b, d);
  return fitU64(q * d === a * b ? q : q + 1n);
}
