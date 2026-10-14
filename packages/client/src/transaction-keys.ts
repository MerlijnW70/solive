import type { Address } from "@solana/kit";
import type { TokenBalance, TokenHolding } from "./rpc-shapes.js";

export function keysAt(keys: readonly Address[], indices: ArrayLike<number>): Address[] {
  const found = Array.from(indices, (index) => keys[index]);
  return found.every((key): key is Address => key !== undefined) ? found : [];
}

export function holdingsOf(keys: readonly Address[], balances: readonly TokenBalance[]): TokenHolding[] {
  const held = new Map<Address, TokenHolding>();
  for (const { accountIndex, mint, owner } of balances) {
    const account = keys[accountIndex];
    if (account !== undefined && !held.has(account)) {
      held.set(account, { account, mint: mint as Address, ...(owner === undefined ? {} : { owner: owner as Address }) });
    }
  }
  return [...held.values()];
}

export const MEMO_PROGRAM_ADDRESS = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" as Address;

export function signersAmong(keys: readonly Address[], indices: readonly number[], signing: number): Address[] {
  return [...new Set(indices.filter((index) => index < signing).flatMap((index) => keys[index] ?? []))];
}
