import { type Address, getBase58Encoder } from "@solana/kit";
import {
  findConfigPda,
  findIntentPda,
  findUserStatePda,
  getConfigDecoder,
  getConfigDiscriminatorBytes,
  getIntentDecoder,
  getIntentDiscriminatorBytes,
  getUserStateDecoder,
  INTENT_ENGINE_PROGRAM_ADDRESS,
} from "@intent-engine/core";
import type { AccountView, Transport } from "./transport.js";

export const SYSTEM_PROGRAM_ADDRESS = "11111111111111111111111111111111" as Address;

export async function createdAccount(transport: Transport, address: Address): Promise<AccountView | null> {
  const view = await transport.getAccount(address);
  return view === null || (view.owner === SYSTEM_PROGRAM_ADDRESS && view.data.length === 0) ? null : view;
}

export class MissingAccount extends Error {
  readonly address: Address;

  constructor(what: string, address: Address) {
    super(`${what} ${address} does not exist`);
    this.name = "MissingAccount";
    this.address = address;
  }
}

export async function engineAccount(
  transport: Transport,
  address: Address,
  discriminator: ArrayLike<number>,
  what: string,
): Promise<Uint8Array> {
  const view = await createdAccount(transport, address);
  if (view === null) {
    throw new MissingAccount(what, address);
  }
  const head = view.data.subarray(0, discriminator.length);
  if (view.owner !== INTENT_ENGINE_PROGRAM_ADDRESS || !head.every((b, i) => b === discriminator[i])) {
    throw new Error(`${address} is not an engine ${what}`);
  }
  return view.data;
}

export async function loadIntent(transport: Transport, owner: Address, nonce: bigint) {
  const [address] = await findIntentPda({ owner, nonce });
  const data = await engineAccount(transport, address, getIntentDiscriminatorBytes(), "intent");
  return { address, intent: getIntentDecoder().decode(data) };
}

export class NotAMint extends Error {
  readonly address: Address;

  constructor(address: Address) {
    super(`${address} is not a token mint`);
    this.name = "NotAMint";
    this.address = address;
  }
}

export async function loadConfig(transport: Transport) {
  const [address] = await findConfigPda();
  const data = await engineAccount(transport, address, getConfigDiscriminatorBytes(), "config");
  return { address, config: getConfigDecoder().decode(data) };
}

export type NonceWindow = { nonceBase: bigint; nonceBitmap: readonly bigint[]; epoch: bigint };

export async function loadUser(transport: Transport, owner: Address): Promise<NonceWindow | null> {
  const [address] = await findUserStatePda({ owner });
  const view = await createdAccount(transport, address);
  if (view === null) {
    return null;
  }
  if (view.owner !== INTENT_ENGINE_PROGRAM_ADDRESS) {
    throw new Error(`${address} is not an engine user account`);
  }
  return getUserStateDecoder().decode(view.data);
}

export async function tokenProgramOf(transport: Transport, mint: Address): Promise<Address> {
  const view: AccountView | null = await createdAccount(transport, mint);
  if (view === null) {
    throw new MissingAccount("mint", mint);
  }
  return view.owner;
}

const MINT_DECIMALS_OFFSET = 44;
export const MINT_BASE_SIZE = 82;
export const TOKEN_PROGRAMS = [
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
] as Address[];

export const SCALING_EXTENSIONS = [10, 25];
export const EXTENSIONS_OFFSET = 166;

export function scalesDisplay(data: Uint8Array): boolean {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let at = EXTENSIONS_OFFSET; at + 4 <= data.length; at += 4 + view.getUint16(at + 2, true)) {
    if (SCALING_EXTENSIONS.includes(view.getUint16(at, true))) {
      return true;
    }
  }
  return false;
}

export async function mintOf(
  transport: Transport,
  mint: Address,
): Promise<{ tokenProgram: Address; decimals: number; scaled: boolean }> {
  const view = await transport.getAccount(mint);
  if (view === null) {
    throw new MissingAccount("mint", mint);
  }
  if (!TOKEN_PROGRAMS.includes(view.owner) || !isMintData(view.data)) {
    throw new NotAMint(mint);
  }
  return { tokenProgram: view.owner, decimals: view.data[MINT_DECIMALS_OFFSET] as number, scaled: scalesDisplay(view.data) };
}

export const EXTENDED_TYPE_OFFSET = 165;
export const EXTENDED_MINT_TYPE = 1;

function isMintData(data: Uint8Array): boolean {
  return data.length === MINT_BASE_SIZE || data[EXTENDED_TYPE_OFFSET] === EXTENDED_MINT_TYPE;
}

export const CLOCK_SYSVAR = "SysvarC1ock11111111111111111111111111111111" as Address;
const CLOCK_UNIX_TIMESTAMP = 32;

const TOKEN_AMOUNT_OFFSET = 64;

export function tokenAmountOf(data: Uint8Array | null): bigint | null {
  if (data === null || data.length < TOKEN_AMOUNT_OFFSET + 8) {
    return null;
  }
  return new DataView(data.buffer, data.byteOffset).getBigUint64(TOKEN_AMOUNT_OFFSET, true);
}

export async function chainTime(transport: Transport): Promise<bigint> {
  const view = await transport.getAccount(CLOCK_SYSVAR);
  if (view === null) {
    throw new Error("the clock sysvar is missing");
  }
  return new DataView(view.data.buffer, view.data.byteOffset).getBigInt64(CLOCK_UNIX_TIMESTAMP, true);
}

const RENT_SYSVAR = "SysvarRent111111111111111111111111111111111" as Address;
const ACCOUNT_STORAGE_OVERHEAD = 128n;
const RENT_THRESHOLD_OFFSET = 8;

export async function rentExemptMinimum(transport: Transport, dataLength: number): Promise<bigint> {
  const view = await transport.getAccount(RENT_SYSVAR);
  if (view === null) {
    throw new Error("the rent sysvar is missing");
  }
  const rent = new DataView(view.data.buffer, view.data.byteOffset);
  const perYear = rent.getBigUint64(0, true) * (ACCOUNT_STORAGE_OVERHEAD + BigInt(dataLength));
  return BigInt(Math.floor(Number(perYear) * rent.getFloat64(RENT_THRESHOLD_OFFSET, true)));
}

export async function clusterDomain(transport: Transport): Promise<Uint8Array> {
  return Uint8Array.from(getBase58Encoder().encode(await transport.genesisHash()));
}
