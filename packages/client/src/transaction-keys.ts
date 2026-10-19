import type { Address } from "@solana/kit";
import { SYSTEM_PROGRAM_ADDRESS, TOKEN_PROGRAMS } from "./accounts.js";
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

const SYSTEM_CREATE_ACCOUNT = 0;
const SYSTEM_TRANSFER = 2;
const SYSTEM_CREATE_ACCOUNT_WITH_SEED = 3;
const SYSTEM_WITHDRAW_NONCE = 5;
const SYSTEM_TRANSFER_WITH_SEED = 11;
const TOKEN_CLOSE_ACCOUNT = 9;
const TOKEN_WITHDRAW_EXCESS_LAMPORTS = 38;
const LAMPORTS_AT = 4;
const SEED_LENGTH_AT = 36;
const SEED_AT = 44;

export type CalledInstruction = { program: Address | undefined; accounts: readonly number[]; data: Uint8Array };

export type Balances = { before: readonly bigint[]; after: readonly bigint[] };

type Moved = { from: number; to: number; lamports: bigint | null };

const lamportsAt = (view: DataView, at: number): bigint | null => (view.byteLength >= at + 8 ? view.getBigUint64(at, true) : null);

function systemMove(accounts: readonly number[], view: DataView): Moved | null {
  if (view.byteLength < 4) {
    return null;
  }
  const at = (i: number) => accounts[i] ?? -1;
  switch (view.getUint32(0, true)) {
    case SYSTEM_CREATE_ACCOUNT:
    case SYSTEM_TRANSFER:
      return { from: at(0), to: at(1), lamports: lamportsAt(view, LAMPORTS_AT) };
    case SYSTEM_CREATE_ACCOUNT_WITH_SEED: {
      const seed = lamportsAt(view, SEED_LENGTH_AT);
      return seed === null || seed > BigInt(view.byteLength) ? null : { from: at(0), to: at(1), lamports: lamportsAt(view, SEED_AT + Number(seed)) };
    }
    case SYSTEM_WITHDRAW_NONCE:
      return { from: at(4), to: at(1), lamports: lamportsAt(view, LAMPORTS_AT) };
    case SYSTEM_TRANSFER_WITH_SEED:
      return { from: at(1), to: at(2), lamports: lamportsAt(view, LAMPORTS_AT) };
    default:
      return null;
  }
}

function tokenMove(accounts: readonly number[], data: Uint8Array, balances: Balances | undefined): Moved | null {
  const kind = data[0];
  if (kind !== TOKEN_CLOSE_ACCOUNT && kind !== TOKEN_WITHDRAW_EXCESS_LAMPORTS) {
    return null;
  }
  const [source = -1, to = -1, from = -1] = accounts;
  const before = balances?.before[source];
  const after = balances?.after[source];
  return { from, to, lamports: before === undefined || after === undefined ? null : before - after };
}

function moveOf({ program, accounts, data }: CalledInstruction, balances: Balances | undefined): Moved | null {
  if (program === SYSTEM_PROGRAM_ADDRESS) {
    return systemMove(accounts, new DataView(data.buffer, data.byteOffset, data.byteLength));
  }
  return program !== undefined && TOKEN_PROGRAMS.includes(program) ? tokenMove(accounts, data, balances) : null;
}

export function solTransfersOf(keys: readonly Address[], instructions: readonly CalledInstruction[], balances?: Balances): SolTransfer[] {
  const found: SolTransfer[] = [];
  for (const instruction of instructions) {
    const moved = moveOf(instruction, balances);
    const from = keys[moved?.from ?? -1];
    const to = keys[moved?.to ?? -1];
    if (moved !== null && moved.lamports !== null && from !== undefined && to !== undefined) {
      found.push({ from, to, lamports: moved.lamports });
    }
  }
  const payer = keys[0];
  if (balances === undefined || payer === undefined) {
    return found;
  }
  for (const [index, into] of keys.entries()) {
    const rise = (balances.after[index] ?? 0n) - (balances.before[index] ?? 0n);
    if (into !== undefined && into !== payer && rise > 0n && !found.some(({ to, lamports }) => to === into && lamports > 0n)) {
      found.push({ from: payer, to: into, lamports: rise });
    }
  }
  return found;
}
