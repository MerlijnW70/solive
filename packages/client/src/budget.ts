import {
  type Address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  type Instruction,
  isWritableRole,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type SignatureBytes,
} from "@solana/kit";
import { COMPUTE_BUDGET_ADDRESS, computeUnitLimit, computeUnitPrice, headroom, MAX_COMPUTE_UNITS } from "@intent-engine/core";
import { boundMembers, type Simulation, type Transport } from "./transport.js";

export type Priority = bigint | "auto";

export const AUTO_PERCENTILE = 75n;
export const AUTO_PRICE_CAP = 10_000_000n;

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

export async function simulated(
  transport: Transport,
  instructions: readonly Instruction[],
  feePayer: Address,
): Promise<Simulation> {
  const latest = await transport.latestBlockhash();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const compiled = compileTransaction(message);
  const signatures = Object.fromEntries(
    Object.keys(compiled.signatures).map((signer) => [signer, new Uint8Array(64) as SignatureBytes]),
  ) as typeof compiled.signatures;
  return transport.simulate(getBase64EncodedWireTransaction({ ...compiled, signatures }));
}

export async function unitsOf(
  transport: Transport,
  instructions: readonly Instruction[],
  feePayer: Address,
): Promise<bigint | null> {
  const simulation = await simulated(transport, instructions, feePayer);
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
  const consumed = await unitsOf(transport, [...instructions, computeUnitLimit(MAX_COMPUTE_UNITS), ...head], feePayer);
  return [...instructions, computeUnitLimit(consumed === null ? MAX_COMPUTE_UNITS : headroom(consumed)), ...head];
}

export function withPriority(inner: Transport, priority: Priority): Transport {
  const budget = (instructions: readonly Instruction[], feePayer: Address) =>
    budgeted(inner, priority, instructions, feePayer);
  return {
    ...boundMembers(inner),
    budget,
    send: async (instructions, payer) => inner.send(await budget(instructions, payer.address), payer),
  };
}
