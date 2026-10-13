import type { Instruction } from "@solana/kit";
import { COMPUTE_BUDGET_ADDRESS, headroom, MAX_COMPUTE_UNITS, UNIT_HEADROOM_DIVISOR, UNIT_HEADROOM_FLOOR } from "@intent-engine/core";

export { headroom, UNIT_HEADROOM_DIVISOR, UNIT_HEADROOM_FLOOR };
export {
  AUTO_PERCENTILE,
  AUTO_PRICE_CAP,
  budgeted,
  percentile,
  type Priority,
  priceOf,
  unitsOf,
  withPriority,
  writableAccounts,
} from "@intent-engine/client";

export const MAX_PRIORITY_PRICE = 100_000_000n;
const MICRO_LAMPORTS_PER_LAMPORT = 1_000_000n;
const DEFAULT_UNITS_PER_INSTRUCTION = 200_000n;
const SET_UNIT_LIMIT = 2;
const SET_UNIT_PRICE = 3;

export function priorityLamports(instructions: readonly Instruction[]): bigint {
  let limit: bigint | null = null;
  let price = 0n;
  let others = 0n;
  for (const ix of instructions) {
    const data = ix.data;
    if (ix.programAddress !== COMPUTE_BUDGET_ADDRESS || data === undefined) {
      others++;
      continue;
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    if (data[0] === SET_UNIT_LIMIT && data.length === 5) {
      limit = BigInt(view.getUint32(1, true));
    } else if (data[0] === SET_UNIT_PRICE && data.length === 9) {
      price = view.getBigUint64(1, true);
    }
  }
  const units = limit ?? BigInt(Math.min(Number(others * DEFAULT_UNITS_PER_INSTRUCTION), MAX_COMPUTE_UNITS));
  return (price * units + MICRO_LAMPORTS_PER_LAMPORT - 1n) / MICRO_LAMPORTS_PER_LAMPORT;
}
