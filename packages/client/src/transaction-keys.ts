import type { Address } from "@solana/kit";
import { SYSTEM_PROGRAM_ADDRESS } from "./accounts.js";
import type { SolTransfer, TokenBalance, TokenHolding } from "./rpc-shapes.js";

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

const SYSTEM_TRANSFER = 2;
const SYSTEM_TRANSFER_WITH_SEED = 11;
const TRANSFER_DATA = 12;

export type CalledInstruction = { program: Address | undefined; accounts: readonly number[]; data: Uint8Array };

export function solTransfersOf(keys: readonly Address[], instructions: readonly CalledInstruction[]): SolTransfer[] {
  return instructions.flatMap(({ program, accounts, data }) => {
    if (program !== SYSTEM_PROGRAM_ADDRESS || data.length < TRANSFER_DATA) {
      return [];
    }
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const kind = view.getUint32(0, true);
    const to = kind === SYSTEM_TRANSFER ? 1 : kind === SYSTEM_TRANSFER_WITH_SEED ? 2 : -1;
    const from = keys[accounts[0] ?? -1];
    const into = keys[accounts[to] ?? -1];
    return from === undefined || into === undefined ? [] : [{ from, to: into, lamports: view.getBigUint64(4, true) }];
  });
}
