import type { Address } from "@solana/kit";
import { NATIVE_MINT } from "@intent-engine/core";
import type { OpenEscrow } from "./chain.js";
import { COST_STEP_BYTES, MAX_OWNER_BYTES, MIN_ESCROW_UNITS } from "./limits.js";
import type { SpecStore } from "./store.js";

export const OWNER_PREFIX = "owners/";
export const IDLE_PREFIX = "idle/";
export const COST_MINT = NATIVE_MINT;

const OWNER_MARK = /^owners\/([1-9A-HJ-NP-Za-km-z]{32,44})\/([0-9a-f]{64})\.(0|[1-9]\d{0,15})$/;

export const ownerMark = (owner: Address, hex: string, size: number): string => `${OWNER_PREFIX}${owner}/${hex}.${size}`;
export type Grace = "paid" | "unpaid";
export const idleMark = (hex: string, grace: Grace): string => `${IDLE_PREFIX}${hex}.${grace}`;
export const idleMarks = (hex: string): string[] => [idleMark(hex, "paid"), idleMark(hex, "unpaid")];

export type OwnerMark = { readonly owner: string; readonly hex: string; readonly size: number };

export function parseOwnerMark(pathname: string): OwnerMark {
  const found = OWNER_MARK.exec(pathname);
  if (found === null) throw new Error("the store holds an owner mark it cannot read");
  const size = Number(found[3]);
  if (!Number.isSafeInteger(size)) throw new Error("the store holds an owner mark it cannot read");
  return { owner: found[1] as string, hex: found[2] as string, size };
}

export const costOf = (size: number): bigint => MIN_ESCROW_UNITS * BigInt(Math.max(1, Math.ceil(size / COST_STEP_BYTES)));

export const counted = (escrows: readonly OpenEscrow[]): OpenEscrow[] => escrows.filter((escrow) => escrow.inputMint === COST_MINT && escrow.escrowed > 0n);

export const lockedBy = (escrows: readonly OpenEscrow[]): bigint => counted(escrows).reduce((sum, escrow) => sum + escrow.escrowed, 0n);

export const backs = (locked: bigint, size: number): boolean => locked >= costOf(size);

export async function ownerHolds(store: SpecStore, owner: Address): Promise<number> {
  const marks = await store.list(`${OWNER_PREFIX}${owner}/`);
  const sizes = new Map<string, number>();
  for (const listed of marks) {
    const mark = parseOwnerMark(listed.pathname);
    if (mark.owner !== owner) throw new Error("the store listed an owner mark under another owner");
    sizes.set(mark.hex, mark.size);
  }
  let sum = 0;
  for (const size of sizes.values()) sum += size;
  return sum;
}

export async function payerOf(store: SpecStore, escrows: readonly OpenEscrow[], size: number): Promise<Address | null> {
  const owners = [...new Set(escrows.map((escrow) => escrow.owner))].sort();
  for (const owner of owners) {
    if ((await ownerHolds(store, owner)) + size <= MAX_OWNER_BYTES) return owner;
  }
  return null;
}
