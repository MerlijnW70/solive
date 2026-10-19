import type { Address } from "@solana/kit";
import { spendable, type Stock, stockLeft } from "./inventory.js";

export const ALLOWANCE_SPENT = "the inventory owner's allowance to the solver no longer covers this fill";

export const INVENTORY_ONLY = "with an inventory owner the solver fills only from that owner's inventory, through no route";

export const NO_ALLOWANCE_READER = "an inventory owner needs a chain that reads token allowances";

export const OWNER_IS_SOLVER = "the inventory owner must be another key than the solver";

export const ALLOWANCE_LOW = "the allowance left is below the largest fill it was asked to cover; approve more with solver float";

export const OWN_INTENT = "the intent's owner or receiver is the inventory owner, so a fill would pay the owner from its own float; fill it without --inventory-owner";

export function ownIntent(owner: Address | undefined, intent: { owner: Address; receiver: Address }, ownerOutput: Address): string | null {
  return owner !== undefined && (intent.owner === owner || intent.receiver === ownerOutput) ? OWN_INTENT : null;
}

export type Low = { account: Address; left: bigint; needed: bigint; warning: string };

export type Floats = Map<Address, { live: bigint; needed: bigint }>;

export type AllowanceReader = { allowance?(account: Address, delegate: Address): Promise<bigint> };

export function floatFits(owner: Address | undefined, solver: Address, chain: AllowanceReader): string | null {
  if (owner === undefined) {
    return null;
  }
  if (owner === solver) {
    return OWNER_IS_SOLVER;
  }
  return chain.allowance === undefined ? NO_ALLOWANCE_READER : null;
}

export async function liveStock(chain: AllowanceReader, owner: Address | undefined, solver: Address, account: Address, balance: bigint): Promise<bigint> {
  if (owner === undefined) {
    return balance;
  }
  if (chain.allowance === undefined) {
    throw new RangeError(NO_ALLOWANCE_READER);
  }
  return spendable(balance, await chain.allowance(account, solver));
}

export function asked(floats: Floats | undefined, account: Address, live: bigint, needed: bigint): void {
  if (floats === undefined) {
    return;
  }
  const seen = floats.get(account);
  floats.set(account, { live, needed: seen === undefined || needed > seen.needed ? needed : seen.needed });
}

export function lows(floats: Floats, stock: Stock): Low[] {
  const low: Low[] = [];
  for (const [account, { live, needed }] of floats) {
    const left = stockLeft(stock, account, live);
    if (left < needed) {
      low.push({ account, left, needed, warning: `${ALLOWANCE_LOW}: ${left} left, ${needed} needed` });
    }
  }
  return low;
}

export function lowOf(floats: Floats | undefined, stock: Stock): { low?: Low[] } {
  const low = floats === undefined ? [] : lows(floats, stock);
  return low.length === 0 ? {} : { low };
}
