import type { Address, Instruction } from "@solana/kit";
import { InvalidInput } from "./errors.js";

export const COMPUTE_BUDGET_ADDRESS = "ComputeBudget111111111111111111111111111111" as Address;
export const MAX_COMPUTE_UNITS = 1_400_000;

export function computeUnitLimit(units: number): Instruction {
  if (!Number.isInteger(units) || units < 1 || units > MAX_COMPUTE_UNITS) {
    throw new InvalidInput("units", "range", `a compute unit limit must be 1 to ${MAX_COMPUTE_UNITS}, got ${units}`);
  }
  const data = new Uint8Array(5);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET_ADDRESS, data };
}

export const UNIT_HEADROOM_DIVISOR = 10n;
export const UNIT_HEADROOM_FLOOR = 1_000n;

export function headroom(consumed: bigint): number {
  const padded = consumed + consumed / UNIT_HEADROOM_DIVISOR + UNIT_HEADROOM_FLOOR;
  return Math.min(Number(padded), MAX_COMPUTE_UNITS);
}

export const MAX_MICRO_LAMPORTS = (1n << 64n) - 1n;

export function computeUnitPrice(microLamports: bigint): Instruction {
  if (microLamports < 0n || microLamports > MAX_MICRO_LAMPORTS) {
    throw new InvalidInput("microLamports", "range", `a compute unit price must be 0 to ${MAX_MICRO_LAMPORTS} micro-lamports, got ${microLamports}`);
  }
  const data = new Uint8Array(9);
  data[0] = 3;
  new DataView(data.buffer).setBigUint64(1, microLamports, true);
  return { programAddress: COMPUTE_BUDGET_ADDRESS, data };
}
