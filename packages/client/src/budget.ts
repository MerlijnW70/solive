import {
  type Address,
  appendTransactionMessageInstructions,
  compileTransaction,
  compressTransactionMessageUsingAddressLookupTables,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getTransactionEncoder,
  type Instruction,
  isWritableRole,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type SignatureBytes,
} from "@solana/kit";
import { COMPUTE_BUDGET_ADDRESS, computeUnitLimit, computeUnitPrice, headroom, MAX_COMPUTE_UNITS } from "@intent-engine/core/internal";
import { boundMembers, type LookupTables, type Simulation, type Transport } from "./transport.js";

export type Priority = bigint | "auto";

export const AUTO_PERCENTILE = 75n;
export const AUTO_PRICE_CAP = 10_000_000n;
export const PACKET_DATA_SIZE = 1_232;

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

async function compiled(transport: Transport, instructions: readonly Instruction[], feePayer: Address, tables?: LookupTables) {
  const latest = await transport.latestBlockhash();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const compressed =
    tables === undefined || Object.keys(tables).length === 0 ? message : compressTransactionMessageUsingAddressLookupTables(message, tables);
  const built = compileTransaction(compressed);
  const signatures = Object.fromEntries(
    Object.keys(built.signatures).map((signer) => [signer, new Uint8Array(64) as SignatureBytes]),
  ) as typeof built.signatures;
  return { ...built, signatures };
}

export async function transactionBytes(
  transport: Transport,
  instructions: readonly Instruction[],
  feePayer: Address,
  tables?: LookupTables,
): Promise<number> {
  return getTransactionEncoder().encode(await compiled(transport, instructions, feePayer, tables)).length;
}

export async function simulated(
  transport: Transport,
  instructions: readonly Instruction[],
  feePayer: Address,
  tables?: LookupTables,
): Promise<Simulation> {
  return transport.simulate(getBase64EncodedWireTransaction(await compiled(transport, instructions, feePayer, tables)));
}

export async function unitsOf(
  transport: Transport,
  instructions: readonly Instruction[],
  feePayer: Address,
  tables?: LookupTables,
): Promise<bigint | null> {
  const simulation = await simulated(transport, instructions, feePayer, tables);
  return simulation.err === null ? simulation.unitsConsumed : null;
}

export async function budgeted(
  transport: Transport,
  priority: Priority,
  instructions: readonly Instruction[],
  feePayer: Address,
  tables?: LookupTables,
): Promise<Instruction[]> {
  if (instructions.some((ix) => ix.programAddress === COMPUTE_BUDGET_ADDRESS)) {
    return [...instructions];
  }
  const price = await priceOf(transport, priority, instructions);
  const head = price > 0n ? [computeUnitPrice(price)] : [];
  const trial = [...instructions, computeUnitLimit(MAX_COMPUTE_UNITS), ...head];
  if ((await transactionBytes(transport, trial, feePayer, tables)) > PACKET_DATA_SIZE) {
    return trial;
  }
  const consumed = await unitsOf(transport, trial, feePayer, tables);
  return [...instructions, computeUnitLimit(consumed === null ? MAX_COMPUTE_UNITS : headroom(consumed)), ...head];
}

export function withPriority(inner: Transport, priority: Priority): Transport {
  const budget = (instructions: readonly Instruction[], feePayer: Address, tables?: LookupTables) =>
    budgeted(inner, priority, instructions, feePayer, tables);
  return {
    ...boundMembers(inner),
    budget,
    send: async (instructions, payer) => inner.send(await budget(instructions, payer.address), payer),
  };
}
