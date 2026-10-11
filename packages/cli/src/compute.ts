import {
  type Address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  type Instruction,
  isWritableRole,
  partiallySignTransactionMessageWithSigners,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
} from "@solana/kit";
import {
  COMPUTE_BUDGET_ADDRESS,
  computeUnitLimit,
  computeUnitPrice,
  headroom,
  MAX_COMPUTE_UNITS,
  UNIT_HEADROOM_DIVISOR,
  UNIT_HEADROOM_FLOOR,
} from "@intent-engine/solver";
import type { Transport } from "./transport.js";

export { headroom, UNIT_HEADROOM_DIVISOR, UNIT_HEADROOM_FLOOR };

export type Priority = bigint | "auto";

export const AUTO_PERCENTILE = 75n;
export const AUTO_PRICE_CAP = 10_000_000n;
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

export function percentile(fees: readonly bigint[], rank: bigint): bigint {
  const sorted = [...fees].sort((a, b) => Number(a - b));
  if (sorted.length === 0) {
    return 0n;
  }
  const at = (BigInt(sorted.length - 1) * rank) / 100n;
  return sorted[Number(at)] ?? 0n;
}

export function writableAccounts(instructions: readonly Instruction[]): Address[] {
  const seen = new Set<Address>();
  for (const ix of instructions) {
    for (const meta of ix.accounts ?? []) {
      if (isWritableRole(meta.role)) {
        seen.add(meta.address);
      }
    }
  }
  return [...seen];
}

export async function priceOf(transport: Transport, priority: Priority, instructions: readonly Instruction[]): Promise<bigint> {
  if (priority !== "auto") {
    return priority;
  }
  const suggested = percentile(await transport.recentFees(writableAccounts(instructions)), AUTO_PERCENTILE);
  return suggested < AUTO_PRICE_CAP ? suggested : AUTO_PRICE_CAP;
}

export async function unitsOf(
  transport: Transport,
  instructions: readonly Instruction[],
  feePayer: Address,
): Promise<bigint | null> {
  const latest = await transport.latestBlockhash();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const simulation = await transport.simulate(
    getBase64EncodedWireTransaction(await partiallySignTransactionMessageWithSigners(message)),
  );
  return simulation.err === null ? simulation.unitsConsumed : null;
}

export async function budgeted(
  transport: Transport,
  priority: Priority,
  instructions: readonly Instruction[],
  feePayer: Address,
): Promise<Instruction[]> {
  if (instructions.some((ix) => ix.programAddress === COMPUTE_BUDGET_ADDRESS)) {
    return [...instructions];
  }
  const price = await priceOf(transport, priority, instructions);
  const head = price > 0n ? [computeUnitPrice(price)] : [];
  const consumed = await unitsOf(transport, [computeUnitLimit(MAX_COMPUTE_UNITS), ...head, ...instructions], feePayer);
  return [computeUnitLimit(consumed === null ? MAX_COMPUTE_UNITS : headroom(consumed)), ...head, ...instructions];
}

export function withPriority(inner: Transport, priority: Priority): Transport {
  const budget = (instructions: readonly Instruction[], feePayer: Address) =>
    budgeted(inner, priority, instructions, feePayer);
  return {
    ...inner,
    budget,
    send: async (instructions, payer) => inner.send(await budget(instructions, payer.address), payer),
  };
}
