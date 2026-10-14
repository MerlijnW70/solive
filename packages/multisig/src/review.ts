import { createHash } from "node:crypto";
import {
  AccountRole,
  type Address,
  address,
  getAddressDecoder,
  getAddressEncoder,
  getBase64Decoder,
  getProgramDerivedAddress,
  type Instruction,
  isSignerRole,
  isWritableRole,
  type ReadonlyUint8Array,
} from "@solana/kit";
import { INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core";
import type { Account, Chain } from "./chain.js";
import { engineSummary } from "./engine.js";
import {
  type ConfigAction,
  configTransactionCodec,
  decodeAccount,
  DISCRIMINATORS,
  ephemeralSignerPda,
  isSignerIndex,
  isStaticWritableIndex,
  type Multisig,
  PERMISSION,
  SQUADS_PROGRAM,
  transactionPda,
  type VaultMessage,
  vaultPda,
  vaultTransactionCodec,
} from "./layout.js";

export const LOADER = address("BPFLoaderUpgradeab1e11111111111111111111111");
export const ENGINE_PROGRAM: Address = INTENT_ENGINE_PROGRAM_ADDRESS;
export const SYSVAR_RENT = address("SysvarRent111111111111111111111111111111111");
export const SYSVAR_CLOCK = address("SysvarC1ock11111111111111111111111111111111");
export const DEFAULT_ADDRESS = address("11111111111111111111111111111111");
export const UPGRADE_TAG = 3;
export const SET_AUTHORITY_TAG = 4;
export const SET_AUTHORITY_CHECKED_TAG = 7;
export const BUFFER_HEADER = 37;
export const PROGRAM_DATA_HEADER = 45;
export const SQUADS_APP = "https://app.squads.so";

const BUFFER_STATE = 1;
const PROGRAM_DATA_STATE = 3;
const UPGRADE_ACCOUNTS = 7;

const LOADER_NAMES: Record<number, string> = {
  0: "InitializeBuffer",
  1: "Write",
  2: "DeployWithMaxDataLen",
  5: "Close",
  6: "ExtendProgram",
  8: "Migrate",
  9: "ExtendProgramChecked",
};

export const programDataOf = async (program: Address): Promise<Address> =>
  (await getProgramDerivedAddress({ programAddress: LOADER, seeds: [getAddressEncoder().encode(program)] }))[0];

const u32At =(data: ReadonlyUint8Array, at: number) => new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(at, true);

const optionalKey =(data: ReadonlyUint8Array, at: number): Address | null =>
  data[at] === 1 ? getAddressDecoder().decode(data.subarray(at + 1, at + 33)) : null;

export const named = (key: Address | null) => (key === null ? "nobody, so it is immutable" : key);

export type LoaderState = { kind: "buffer" | "program data"; authority: Address | null; data: ReadonlyUint8Array } | { kind: "missing" | "other" };

export function loaderState(info: Account | null): LoaderState {
  if (info === null) {
    return { kind: "missing" };
  }
  if (info.owner !== LOADER || info.data.length < 4) {
    return { kind: "other" };
  }
  const tag = u32At(info.data, 0);
  if (tag === BUFFER_STATE && info.data.length >= BUFFER_HEADER) {
    return { kind: "buffer", authority: optionalKey(info.data, 4), data: info.data };
  }
  if (tag === PROGRAM_DATA_STATE && info.data.length >= PROGRAM_DATA_HEADER) {
    return { kind: "program data", authority: optionalKey(info.data, 12), data: info.data };
  }
  return { kind: "other" };
}

export function bufferHash(data: ReadonlyUint8Array): string {
  let end = data.length;
  while (end > BUFFER_HEADER && data[end - 1] === 0) {
    end -= 1;
  }
  return createHash("sha256").update(data.subarray(BUFFER_HEADER, end)).digest("hex");
}

export type InstructionView = { program: string; accounts: { address: string; signer: boolean; writable: boolean }[]; data: string };

export function instructionView(ix: Instruction): InstructionView {
  return {
    program: ix.programAddress,
    accounts: (ix.accounts ?? []).map((k) => ({ address: k.address, signer: isSignerRole(k.role), writable: isWritableRole(k.role) })),
    data: getBase64Decoder().decode(ix.data ?? new Uint8Array()),
  };
}

export const roleOf = (signer: boolean, writable: boolean): AccountRole =>
  signer ? (writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : writable ? AccountRole.WRITABLE : AccountRole.READONLY;

export function messageInstructions(message: VaultMessage): Instruction[] {
  const keyAt = (at: number) => {
    const found = message.accountKeys[at];
    if (found === undefined) {
      throw new Error(`instruction names account ${at}, beyond the message's ${message.accountKeys.length} keys`);
    }
    return found;
  };
  return message.instructions.map((ix) => ({
    programAddress: keyAt(ix.programIdIndex),
    accounts: Array.from(ix.accountIndexes, (at) => ({ address: keyAt(at), role: roleOf(isSignerIndex(message, at), isStaticWritableIndex(message, at)) })),
    data: new Uint8Array(ix.data),
  }));
}

export type BufferCheck = { buffer: Address; authority: Address | null; hash: string | null };

export type Decoded = InstructionView & { summary: string };

type Described = { summary: string; buffer?: BufferCheck };

const signersOf = (ix: Instruction) => (ix.accounts ?? []).filter((k) => isSignerRole(k.role)).map((k) => k.address);

const raw = (label: string, ix: Instruction) =>
  `${label} with ${(ix.accounts ?? []).length} accounts and ${(ix.data ?? new Uint8Array()).length} bytes of data, signed by ${signersOf(ix).join(", ") || "nobody"}`;

const refusedUnless = (signs: boolean, key: Address) => (signs ? "" : `; ${key} does not sign, so the loader refuses it`);

async function target(chain: Chain, at: Address, engineData: Address): Promise<{ state: LoaderState; label: string }> {
  const state = loaderState(await chain.account(at));
  if (state.kind === "buffer") {
    return { state, label: `buffer ${at}` };
  }
  if (state.kind === "program data") {
    return { state, label: engineData === at ? `program ${ENGINE_PROGRAM}` : `the program whose data is ${at}` };
  }
  return { state, label: `account ${at}, which is neither a buffer nor program data, so the loader refuses it` };
}

const extraText = (extra: number) => (extra === 0 ? "" : `; the instruction carries ${extra} more bytes of data, which the loader ignores`);

async function describeUpgrade(chain: Chain, ix: Instruction, extra: number): Promise<Described> {
  const accounts = ix.accounts ?? [];
  const trailing = extraText(extra);
  const [programData, program, buffer, spill, , , authority] = accounts;
  if (programData === undefined || program === undefined || buffer === undefined || spill === undefined || authority === undefined) {
    return { summary: `Loader Upgrade with only ${accounts.length} of its ${UPGRADE_ACCOUNTS} accounts, so the loader refuses it${trailing}` };
  }
  const by = isSignerRole(authority.role)
    ? `signed by ${authority.address}`
    : `naming ${authority.address} as authority without its signature, so the loader refuses it`;
  const head = `Upgrades program ${program.address} to the code in buffer ${buffer.address}, ${by}; the buffer's rent goes to ${spill.address}`;
  const wrongData = (await programDataOf(program.address)) === programData.address ? "" : `; ${programData.address} is not that program's data, so the loader refuses it`;
  const state = loaderState(await chain.account(buffer.address));
  if (state.kind !== "buffer") {
    const why = state.kind === "missing" ? "does not exist" : "is not a program buffer";
    return { summary: `${head}${wrongData}${trailing}; the buffer ${why}`, buffer: { buffer: buffer.address, authority: null, hash: null } };
  }
  const hash = bufferHash(state.data);
  return {
    summary: `${head}${wrongData}${trailing}; the buffer hashes to ${hash} and is controlled by ${named(state.authority)}`,
    buffer: { buffer: buffer.address, authority: state.authority, hash },
  };
}

async function describeAuthority(chain: Chain, ix: Instruction, engineData: Address, checked: boolean, extra: number): Promise<Described> {
  const accounts = ix.accounts ?? [];
  const trailing = extraText(extra);
  const [first, current, next] = accounts;
  const name = checked ? "SetAuthorityChecked" : "SetAuthority";
  if (first === undefined || current === undefined || (checked && next === undefined)) {
    return { summary: `Loader ${name} with only ${accounts.length} accounts, so the loader refuses it${trailing}` };
  }
  const { state, label } = await target(chain, first.address, engineData);
  const what = state.kind === "buffer" ? `the authority of ${label}` : `the upgrade authority of ${label}`;
  const signs = refusedUnless(isSignerRole(current.role), current.address);
  if (next === undefined) {
    return state.kind === "buffer"
      ? { summary: `Removes the authority of ${label}, which the loader refuses for a buffer${signs}${trailing}` }
      : { summary: `Makes ${label} immutable: removes the upgrade authority ${current.address} for good${signs}${trailing}` };
  }
  const both = checked ? `; both sign${refusedUnless(isSignerRole(next.role), next.address)}` : "";
  return { summary: `Hands ${what} from ${current.address} to ${next.address}${signs}${both}${trailing}` };
}

async function describe(chain: Chain, ix: Instruction, engineData: Address): Promise<Described> {
  const data = ix.data ?? new Uint8Array();
  if (ix.programAddress === ENGINE_PROGRAM) {
    return { summary: engineSummary(ix) };
  }
  if (ix.programAddress !== LOADER) {
    return { summary: raw(`Runs program ${ix.programAddress}`, ix) };
  }
  if (data.length < 4) {
    return { summary: raw("Loader instruction that this version cannot decode", ix) };
  }
  const tag = u32At(data, 0);
  if (tag === UPGRADE_TAG) {
    return describeUpgrade(chain, ix, data.length - 4);
  }
  if (tag === SET_AUTHORITY_TAG || tag === SET_AUTHORITY_CHECKED_TAG) {
    return describeAuthority(chain, ix, engineData, tag === SET_AUTHORITY_CHECKED_TAG, data.length - 4);
  }
  return { summary: raw(`Loader ${LOADER_NAMES[tag] ?? `instruction ${tag}`}`, ix) };
}

export async function describeInstructions(chain: Chain, instructions: readonly Instruction[]): Promise<{ decoded: Decoded[]; buffers: BufferCheck[] }> {
  const engineData = await programDataOf(ENGINE_PROGRAM);
  const decoded: Decoded[] = [];
  const buffers: BufferCheck[] = [];
  for (const ix of instructions) {
    const described = await describe(chain, ix, engineData);
    decoded.push({ ...instructionView(ix), summary: described.summary });
    if (described.buffer !== undefined) {
      buffers.push(described.buffer);
    }
  }
  return { decoded, buffers };
}

export async function decodeMessage(chain: Chain, message: VaultMessage): Promise<Decoded[]> {
  return (await describeInstructions(chain, messageInstructions(message))).decoded;
}

export type Review = {
  kind: "vault" | "config" | "other" | "none";
  creator: Address | null;
  summary: string[];
  instructions: Decoded[];
  actions: ConfigAction[];
  buffers: BufferCheck[];
  problems: string[];
};

const permissionText = (mask: number) =>
  (Object.entries(PERMISSION) as [string, number][])
    .filter(([, bit]) => (mask & bit) !== 0)
    .map(([name]) => name)
    .join(", ") || "no permissions";

function actionText(action: ConfigAction, multisig: Multisig): string {
  switch (action.__kind) {
    case "AddMember":
      return `Adds member ${action.newMember.key} with ${permissionText(action.newMember.permissions.mask)}`;
    case "RemoveMember":
      return `Removes member ${action.oldMember}`;
    case "ChangeThreshold":
      return `Changes the threshold from ${multisig.threshold} to ${action.newThreshold}`;
    case "SetTimeLock":
      return `Changes the time lock from ${multisig.timeLock} to ${action.newTimeLock} seconds`;
    case "AddSpendingLimit":
      return `Adds spending limit ${action.createKey}: ${action.members.join(", ") || "no member"} may move ${action.amount} of mint ${action.mint} from vault ${action.vaultIndex} ${action.period.__kind === "OneTime" ? "once" : `every ${action.period.__kind.toLowerCase()}`}, to ${action.destinations.join(", ") || "any address"}, without a proposal`;
    case "RemoveSpendingLimit":
      return `Removes spending limit ${action.spendingLimit}`;
    case "SetRentCollector":
      return action.newRentCollector === null ? "Stops collecting the rent of closed transactions" : `Sends the rent of closed transactions to ${action.newRentCollector}`;
  }
}

function afterConfig(actions: ConfigAction[], multisig: Multisig): string {
  let members = multisig.members.map((m) => m.key);
  let threshold = multisig.threshold;
  let timeLock = multisig.timeLock;
  for (const action of actions) {
    if (action.__kind === "AddMember") {
      members = [...members, action.newMember.key];
    } else if (action.__kind === "RemoveMember") {
      members = members.filter((m) => m !== action.oldMember);
    } else if (action.__kind === "ChangeThreshold") {
      threshold = action.newThreshold;
    } else if (action.__kind === "SetTimeLock") {
      timeLock = action.newTimeLock;
    }
  }
  return `After it runs: members ${members.join(", ")}; threshold ${threshold} of ${members.length}; time lock ${timeLock} seconds`;
}

const hasDiscriminator = (data: ReadonlyUint8Array, discriminator: readonly number[]) => discriminator.every((b, i) => data[i] === b);

const empty = (kind: Review["kind"], summary: string, problem: string): Review => ({
  kind,
  creator: null,
  summary: [summary],
  instructions: [],
  actions: [],
  buffers: [],
  problems: [problem],
});

async function reviewVault(chain: Chain, at: Address, index: bigint, data: ReadonlyUint8Array): Promise<Review> {
  const stored = decodeAccount("VaultTransaction", vaultTransactionCodec, data);
  if (stored === null) {
    return empty("other", "A vault transaction this tool cannot decode", "its vault transaction does not decode");
  }
  const base = { kind: "vault" as const, creator: stored.creator, actions: [] };
  const { message } = stored;
  if (message.addressTableLookups.length > 0) {
    const tables = message.addressTableLookups.map((t) => t.accountKey).join(", ");
    return {
      ...base,
      summary: [`Undecodable: the message loads accounts from address lookup tables ${tables}, which this tool does not read, so it cannot show every account`],
      instructions: [],
      buffers: [],
      problems: ["it uses address lookup tables, so this tool cannot show every account it touches"],
    };
  }
  let instructions: Instruction[];
  try {
    instructions = messageInstructions(message);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    return { ...base, summary: [`Undecodable: ${why}`], instructions: [], buffers: [], problems: [`its message is malformed: ${why}`] };
  }
  const vault = await vaultPda(at, stored.vaultIndex);
  const transaction = await transactionPda(at, index);
  const ephemeral = await Promise.all(Array.from(stored.ephemeralSignerBumps, (_, i) => ephemeralSignerPda(transaction, i)));
  const { decoded, buffers } = await describeInstructions(chain, instructions);
  const problems: string[] = [];
  for (const [i, key] of message.accountKeys.entries()) {
    if (isSignerIndex(message, i) && key !== vault && !ephemeral.includes(key)) {
      problems.push(`it asks ${key} to sign, but only the vault ${vault} and the transaction's ephemeral signers may; executing it would lend ${key}'s signature to it`);
    }
  }
  for (const check of buffers) {
    if (check.hash === null) {
      problems.push(`buffer ${check.buffer} is missing or not a program buffer`);
    } else if (check.authority !== vault) {
      problems.push(`buffer ${check.buffer} is controlled by ${named(check.authority)}, not the vault ${vault}, so its code can change after approval`);
    }
  }
  return { ...base, summary: decoded.map((d) => d.summary), instructions: decoded, buffers, problems };
}

export async function review(chain: Chain, at: Address, index: bigint, multisig: Multisig): Promise<Review> {
  const info = await chain.account(await transactionPda(at, index));
  if (info === null) {
    return empty("none", "No transaction at this index: it was closed or never created", "it has no transaction account");
  }
  if (info.owner !== SQUADS_PROGRAM) {
    return empty("other", "The transaction account is not owned by Squads", "its transaction account is not owned by Squads");
  }
  if (hasDiscriminator(info.data, DISCRIMINATORS.VaultTransaction)) {
    return reviewVault(chain, at, index, info.data);
  }
  if (hasDiscriminator(info.data, DISCRIMINATORS.ConfigTransaction)) {
    const config = decodeAccount("ConfigTransaction", configTransactionCodec, info.data);
    if (config !== null) {
      return {
        kind: "config",
        creator: config.creator,
        summary: [
          `Config transaction: changes multisig ${at} itself`,
          ...config.actions.map((action) => actionText(action, multisig)),
          afterConfig(config.actions, multisig),
        ],
        instructions: [],
        actions: config.actions,
        buffers: [],
        problems: [],
      };
    }
  }
  return empty("other", "A batch or other Squads transaction this tool cannot decode", "it is a batch or another transaction this tool cannot decode");
}

export const reviewView = (seen: Review) => ({
  kind: seen.kind,
  summary: seen.summary,
  ...(seen.kind === "config" ? { actions: seen.actions } : { instructions: seen.instructions }),
  ...(seen.buffers.length > 0 ? { buffers: seen.buffers } : {}),
  ...(seen.problems.length > 0 ? { problems: seen.problems } : {}),
});
