import {
  type Address,
  AccountRole,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import {
  getMintCapDecoder,
  getMintCapSize,
  getSetCapsRequiredInstruction,
  getSetMintCapInstructionAsync,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  MINT_CAP_DISCRIMINATOR,
  type MintCap,
} from "../generated/client/index.js";
import { events } from "./builder-accounts.js";
import { U64_MAX } from "./math.js";
import { checkAccountVersion } from "./versions.js";
import { InvalidInput, NotAnEngineAccount } from "./errors.js";

export const MIN_CAP_WINDOW_SECS = 60;

export function isMintCapData(data: Uint8Array): boolean {
  return data.length >= getMintCapSize() && MINT_CAP_DISCRIMINATOR.every((b, i) => data[i] === b);
}

export function decodeMintCapData(data: Uint8Array): MintCap {
  if (!isMintCapData(data)) {
    throw new NotAnEngineAccount(null, "not a mint cap account");
  }
  return getMintCapDecoder().decode(checkAccountVersion(data));
}

export type CapWindow = { start: bigint; ends: bigint; used: bigint; left: bigint };

export function capWindow(cap: Pick<MintCap, "windowStart" | "windowUsed" | "windowSecs" | "windowCap">, now: bigint): CapWindow {
  const ends = cap.windowStart + BigInt(cap.windowSecs);
  const rolled = now >= ends;
  const used = rolled ? 0n : cap.windowUsed;
  return {
    start: rolled ? now : cap.windowStart,
    ends: rolled ? now + BigInt(cap.windowSecs) : ends,
    used,
    left: cap.windowCap > used ? cap.windowCap - used : 0n,
  };
}

export type MintCapLimits = { maxPerOrder: bigint; windowCap: bigint; windowSecs: number; totalLimit?: bigint };

export function checkMintCapLimits(limits: MintCapLimits): MintCapLimits {
  if (limits.maxPerOrder <= 0n) {
    throw new InvalidInput("maxPerOrder", "range", "the per-order cap must be above zero");
  }
  if (limits.windowCap < limits.maxPerOrder) {
    throw new InvalidInput("windowCap", "range", "the window cap must be at least the per-order cap");
  }
  if (!Number.isInteger(limits.windowSecs) || limits.windowSecs < MIN_CAP_WINDOW_SECS || limits.windowSecs > 0xffff_ffff) {
    throw new InvalidInput("windowSecs", "range", `the window must last ${MIN_CAP_WINDOW_SECS} to 4294967295 seconds`);
  }
  if (limits.totalLimit !== undefined && (limits.totalLimit < 0n || limits.totalLimit > U64_MAX)) {
    throw new InvalidInput("totalLimit", "range", "the total limit must be zero, meaning none, or a raw amount");
  }
  return limits;
}

export async function findMintCapAddress(mint: Address): Promise<Address> {
  const [address] = await getProgramDerivedAddress({
    programAddress: INTENT_ENGINE_PROGRAM_ADDRESS,
    seeds: [new TextEncoder().encode("mint_cap"), getAddressEncoder().encode(mint)],
  });
  return address;
}

export async function buildSetMintCap(input: MintCapLimits & { totalLimit: bigint; admin: TransactionSigner; payer?: TransactionSigner; mint: Address }) {
  if (typeof input.totalLimit !== "bigint") {
    throw new InvalidInput("totalLimit", "missing", "name the total limit: zero for none, or the current one to keep it");
  }
  const limits = checkMintCapLimits(input);
  return getSetMintCapInstructionAsync({
    admin: input.admin,
    payer: input.payer ?? input.admin,
    mint: input.mint,
    maxPerOrder: limits.maxPerOrder,
    windowCap: limits.windowCap,
    windowSecs: limits.windowSecs,
    totalLimit: input.totalLimit,
    ...(await events()),
  });
}

export async function buildSetCapsRequired(input: { admin: TransactionSigner; required: boolean }) {
  return getSetCapsRequiredInstruction({ admin: input.admin, required: input.required, ...(await events()) });
}

export async function capAccount(inputMint: Address, capped: bigint | undefined): Promise<{ mintCap?: Address }> {
  return capped === undefined || capped === 0n ? {} : { mintCap: await findMintCapAddress(inputMint) };
}

const MINT_CAP_FROM_END = 3;

export function mintCapSlot(mintCap: Address | undefined): Address {
  return mintCap ?? INTENT_ENGINE_PROGRAM_ADDRESS;
}

export function withMintCap<T extends Instruction>(ix: T, mintCap: Address | undefined): T {
  const accounts = [...(ix.accounts ?? [])];
  const at = accounts.length - MINT_CAP_FROM_END;
  accounts[at] =
    mintCap === undefined
      ? { address: INTENT_ENGINE_PROGRAM_ADDRESS, role: AccountRole.READONLY }
      : { address: mintCap, role: AccountRole.WRITABLE };
  return { ...ix, accounts } as T;
}
