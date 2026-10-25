import { type Address, getAddressDecoder, getBase58Encoder } from "@solana/kit";
import { type Config, NotAnEngineAccount, SdkError, TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import {
  checkAccountVersion,
  decodeConfigAccount,
  decodeIntentAccount,
  decodeMintCapData,
  decodeUserStateAccount,
  findConfigPda,
  findIntentPda,
  findMintCapAddress,
  findUserStatePda,
  getConfigDiscriminatorBytes,
  getIntentDiscriminatorBytes,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  isMintCapData,
  type MintCap,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@intent-engine/core/internal";
import type { IntentAccount } from "./client-types.js";
import type { AccountView, Transport } from "./transport.js";

export const SYSTEM_PROGRAM_ADDRESS = "11111111111111111111111111111111" as Address;

export function createdView(view: AccountView | null): AccountView | null {
  return view === null || (view.owner === SYSTEM_PROGRAM_ADDRESS && view.data.length === 0) ? null : view;
}

export async function createdAccount(transport: Transport, address: Address): Promise<AccountView | null> {
  return createdView(await transport.getAccount(address));
}

export class MissingAccount extends SdkError {
  readonly code = "missing-account";
  override readonly name = "MissingAccount";
  readonly address: Address;

  constructor(what: string, address: Address, message = `${what} ${address} does not exist`) {
    super(message);
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
    throw new NotAnEngineAccount(address, `${address} is not an engine ${what}`);
  }
  return checkAccountVersion(view.data);
}

export async function loadIntent(transport: Transport, owner: Address, nonce: bigint): Promise<IntentAccount> {
  const [address] = await findIntentPda({ owner, nonce });
  const data = await engineAccount(transport, address, getIntentDiscriminatorBytes(), "intent");
  return { address, intent: decodeIntentAccount(data) };
}

export class NotAMint extends SdkError {
  readonly code = "not-a-mint";
  override readonly name = "NotAMint";
  readonly address: Address;

  constructor(address: Address) {
    super(`${address} is not a token mint`);
    this.address = address;
  }
}

export type ConfigAccount = { address: Address; config: Config };

export async function loadConfig(transport: Transport): Promise<ConfigAccount> {
  const [address] = await findConfigPda();
  const data = await engineAccount(transport, address, getConfigDiscriminatorBytes(), "config");
  return { address, config: decodeConfigAccount(data) };
}

export type MintCapAccount = { address: Address; cap: MintCap };

export async function loadMintCap(transport: Transport, mint: Address): Promise<MintCapAccount | null> {
  const address = await findMintCapAddress(mint);
  const view = await createdAccount(transport, address);
  if (view === null) {
    return null;
  }
  if (view.owner !== INTENT_ENGINE_PROGRAM_ADDRESS || !isMintCapData(view.data)) {
    throw new NotAnEngineAccount(address, `${address} is not an engine mint cap`);
  }
  return { address, cap: decodeMintCapData(view.data) };
}

export async function mintCapOf(transport: Transport, mint: Address): Promise<Address | undefined> {
  return (await loadMintCap(transport, mint))?.address;
}

export type NonceWindow ={ nonceBase: bigint; nonceBitmap: readonly bigint[]; epoch: bigint };

export async function loadUser(transport: Transport, owner: Address): Promise<NonceWindow | null> {
  const [address] = await findUserStatePda({ owner });
  const view = await createdAccount(transport, address);
  if (view === null) {
    return null;
  }
  if (view.owner !== INTENT_ENGINE_PROGRAM_ADDRESS) {
    throw new NotAnEngineAccount(address, `${address} is not an engine user account`);
  }
  return decodeUserStateAccount(view.data);
}

export async function tokenProgramOf(transport: Transport, mint: Address): Promise<Address> {
  const view: AccountView | null = await createdAccount(transport, mint);
  if (view === null) {
    throw new MissingAccount("mint", mint);
  }
  return view.owner;
}

const MINT_DECIMALS_OFFSET = 44;
export const MINT_FREEZE_TAG_OFFSET = 46;
export const MINT_FREEZE_AUTHORITY_OFFSET = 50;
export const MINT_BASE_SIZE = 82;
export const TOKEN_PROGRAMS: Address[] = [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS];

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

export function freezeAuthorityOf(data: Uint8Array): Address | null {
  if (data.length < MINT_BASE_SIZE) {
    return null;
  }
  const tag = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(MINT_FREEZE_TAG_OFFSET, true);
  return tag === 1 ? getAddressDecoder().decode(data.subarray(MINT_FREEZE_AUTHORITY_OFFSET, MINT_BASE_SIZE)) : null;
}

export type MintView = { tokenProgram: Address; decimals: number; scaled: boolean; freezeAuthority: Address | null };

export async function mintOf(transport: Transport, mint: Address): Promise<MintView> {
  const view = await transport.getAccount(mint);
  if (view === null) {
    throw new MissingAccount("mint", mint);
  }
  if (!TOKEN_PROGRAMS.includes(view.owner) || !isMintData(view.data)) {
    throw new NotAMint(mint);
  }
  return {
    tokenProgram: view.owner,
    decimals: view.data[MINT_DECIMALS_OFFSET] as number,
    scaled: scalesDisplay(view.data),
    freezeAuthority: freezeAuthorityOf(view.data),
  };
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
  return clockTime(await transport.getAccount(CLOCK_SYSVAR));
}

export function clockTime(view: AccountView | null): bigint {
  if (view === null) {
    throw new MissingAccount("the clock sysvar", CLOCK_SYSVAR, "the clock sysvar is missing");
  }
  return new DataView(view.data.buffer, view.data.byteOffset).getBigInt64(CLOCK_UNIX_TIMESTAMP, true);
}

const RENT_SYSVAR = "SysvarRent111111111111111111111111111111111" as Address;
const ACCOUNT_STORAGE_OVERHEAD = 128n;
const RENT_THRESHOLD_OFFSET = 8;

export type RentSysvar = { perByteYear: bigint; threshold: number };

export async function rentSysvar(transport: Transport): Promise<RentSysvar> {
  const view = await transport.getAccount(RENT_SYSVAR);
  if (view === null) {
    throw new MissingAccount("the rent sysvar", RENT_SYSVAR, "the rent sysvar is missing");
  }
  const rent = new DataView(view.data.buffer, view.data.byteOffset);
  return { perByteYear: rent.getBigUint64(0, true), threshold: rent.getFloat64(RENT_THRESHOLD_OFFSET, true) };
}

export const rentExemptFor = (rent: RentSysvar, dataLength: number): bigint =>
  BigInt(Math.floor(Number(rent.perByteYear * (ACCOUNT_STORAGE_OVERHEAD + BigInt(dataLength))) * rent.threshold));

export async function rentExemptMinimum(transport: Transport, dataLength: number): Promise<bigint> {
  return rentExemptFor(await rentSysvar(transport), dataLength);
}

export async function clusterDomain(transport: Transport): Promise<Uint8Array> {
  return Uint8Array.from(getBase58Encoder().encode(await transport.genesisHash()));
}
