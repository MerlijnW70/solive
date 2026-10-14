import {
  AccountRole,
  type Address,
  address,
  getAddressDecoder,
  getAddressEncoder,
  getBase64Decoder,
  getBase64Encoder,
  getProgramDerivedAddress,
  type Instruction,
  isAddress,
  isSignerRole,
  isWritableRole,
  type KeyPairSigner,
  type ReadonlyUint8Array,
} from "@solana/kit";
import { INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core";
import type { Account, Chain } from "./chain.js";
import { engineSummary } from "./engine.js";
import {
  decodeAccount,
  isSignerIndex,
  isStaticWritableIndex,
  multisigCodec,
  multisigCreateV2,
  multisigPda,
  PERMISSION,
  programConfigCodec,
  programConfigPda,
  proposalApprove,
  proposalCodec,
  proposalCreate,
  proposalPda,
  SQUADS_PROGRAM,
  transactionPda,
  compileVaultMessage,
  type VaultMessage,
  type VaultTransaction,
  vaultPda,
  vaultTransactionCodec,
  vaultTransactionCreate,
  vaultTransactionExecute,
  type Multisig,
  type Proposal,
} from "./layout.js";

export { SQUADS_PROGRAM, type Multisig, type Proposal, type VaultTransaction };
export const LOADER = address("BPFLoaderUpgradeab1e11111111111111111111111");
export const ENGINE_PROGRAM: Address = INTENT_ENGINE_PROGRAM_ADDRESS;
export const COMPUTE_BUDGET = address("ComputeBudget111111111111111111111111111111");
export const SYSVAR_RENT = address("SysvarRent111111111111111111111111111111111");
export const SYSVAR_CLOCK = address("SysvarC1ock11111111111111111111111111111111");
export const DEFAULT_ADDRESS = address("11111111111111111111111111111111");
export const VAULT_INDEX = 0;
export const EXECUTE_UNITS = 1_400_000;
export const UPGRADE_TAG = 3;
export const SET_AUTHORITY_TAG = 4;
const SET_COMPUTE_UNIT_LIMIT = 2;

type PermissionName = keyof typeof PERMISSION;

const PERMISSIONS = Object.entries(PERMISSION) as [PermissionName, number][];

export class Refusal extends Error {}

export type Plan = {
  summary: string[];
  instructions: Instruction[];
  signers: KeyPairSigner[];
  details: Record<string, unknown>;
};

export const vaultOf = (multisig: Address): Promise<Address> => vaultPda(multisig, VAULT_INDEX);

export const programDataOf = async (program: Address): Promise<Address> =>
  (await getProgramDerivedAddress({ programAddress: LOADER, seeds: [getAddressEncoder().encode(program)] }))[0];

const owned = (info: Account | null, owner: Address): info is Account => info !== null && info.owner === owner;

const u32At = (data: ReadonlyUint8Array, at: number) => new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(at, true);

export async function readMultisig(chain: Chain, at: Address): Promise<Multisig> {
  const info = await chain.account(at);
  const multisig = owned(info, SQUADS_PROGRAM) ? decodeAccount("Multisig", multisigCodec, info.data) : null;
  if (multisig === null) {
    throw new Refusal(`${at} is not a Squads v4 multisig`);
  }
  return multisig;
}

export async function readProposal(chain: Chain, multisig: Address, index: bigint): Promise<Proposal | null> {
  const info = await chain.account(await proposalPda(multisig, index));
  return owned(info, SQUADS_PROGRAM) ? decodeAccount("Proposal", proposalCodec, info.data) : null;
}

export async function readVaultTransaction(chain: Chain, multisig: Address, index: bigint): Promise<VaultTransaction | null> {
  const info = await chain.account(await transactionPda(multisig, index));
  return owned(info, SQUADS_PROGRAM) ? decodeAccount("VaultTransaction", vaultTransactionCodec, info.data) : null;
}

export const permissionNames = (mask: number): PermissionName[] => PERMISSIONS.filter(([, bit]) => (mask & bit) !== 0).map(([name]) => name);

function requireMember(multisig: Multisig, at: Address, member: Address, permission: PermissionName, action: string): void {
  const found = multisig.members.find((m) => m.key === member);
  if (found === undefined) {
    throw new Refusal(`${member} is not a member of multisig ${at}, so it cannot ${action}`);
  }
  if (!permissionNames(found.permissions.mask).includes(permission)) {
    throw new Refusal(`${member} lacks the ${permission} permission on multisig ${at}, so it cannot ${action}`);
  }
}

export const statusOf = (proposal: Proposal | null): string => (proposal === null ? "no proposal" : proposal.status.__kind.toLowerCase());

export async function createMultisig(
  chain: Chain,
  input: { creator: Address; createKey: KeyPairSigner; members: Address[]; threshold: number; timeLock: number },
): Promise<Plan> {
  const keys = input.members;
  if (new Set(keys).size !== keys.length) {
    throw new Refusal("--members names the same key twice");
  }
  if (!Number.isInteger(input.threshold) || input.threshold < 1 || input.threshold > keys.length) {
    throw new Refusal(`--threshold must be between 1 and the ${keys.length} members`);
  }
  const multisig = await multisigPda(input.createKey.address);
  if ((await chain.account(multisig)) !== null) {
    throw new Refusal(`create key ${input.createKey.address} already made multisig ${multisig}; pass another --create-key`);
  }
  const programConfig = await programConfigPda();
  const info = await chain.account(programConfig);
  const config = owned(info, SQUADS_PROGRAM) ? decodeAccount("ProgramConfig", programConfigCodec, info.data) : null;
  if (config === null) {
    throw new Refusal(`the Squads v4 program config ${programConfig} is missing on this cluster`);
  }
  const vault = await vaultOf(multisig);
  return {
    summary: [
      `Creates a ${input.threshold}-of-${keys.length} Squads v4 multisig ${multisig} with no config authority`,
      `Members, each allowed to initiate, vote and execute: ${keys.join(", ")}`,
      input.timeLock === 0 ? "No time lock: an approved proposal executes at once" : `Time lock: an approved proposal waits ${input.timeLock} seconds`,
      `Vault ${VAULT_INDEX}: ${vault}`,
    ],
    instructions: [
      multisigCreateV2({
        programConfig,
        treasury: config.treasury,
        multisig,
        createKey: input.createKey.address,
        creator: input.creator,
        threshold: input.threshold,
        members: keys,
        timeLock: input.timeLock,
      }),
    ],
    signers: [input.createKey],
    details: {
      multisig,
      vault,
      create_key: input.createKey.address,
      members: keys,
      threshold: input.threshold,
      time_lock: input.timeLock,
    },
  };
}

async function propose(chain: Chain, at: Address, member: Address, instructions: Instruction[], summary: string[]): Promise<Plan> {
  const multisig = await readMultisig(chain, at);
  requireMember(multisig, at, member, "initiate", "propose");
  const index = multisig.transactionIndex + 1n;
  const vault = await vaultOf(at);
  const transaction = await transactionPda(at, index);
  const proposal = await proposalPda(at, index);
  return {
    summary: [`Proposes vault transaction ${index} on multisig ${at}; it runs once ${multisig.threshold} members approve`, ...summary],
    instructions: [
      vaultTransactionCreate({ multisig: at, transaction, creator: member, vaultIndex: VAULT_INDEX, message: compileVaultMessage(vault, instructions) }),
      proposalCreate({ multisig: at, proposal, creator: member, index }),
    ],
    signers: [],
    details: {
      multisig: at,
      vault,
      index: index.toString(),
      transaction,
      proposal,
      instructions: instructions.map(instructionView),
    },
  };
}

const meta = (at: Address, role: AccountRole) => ({ address: at, role });

export async function upgradeInstruction(input: { program: Address; buffer: Address; spill: Address; authority: Address }): Promise<Instruction> {
  return {
    programAddress: LOADER,
    accounts: [
      meta(await programDataOf(input.program), AccountRole.WRITABLE),
      meta(input.program, AccountRole.WRITABLE),
      meta(input.buffer, AccountRole.WRITABLE),
      meta(input.spill, AccountRole.WRITABLE),
      meta(SYSVAR_RENT, AccountRole.READONLY),
      meta(SYSVAR_CLOCK, AccountRole.READONLY),
      meta(input.authority, AccountRole.READONLY_SIGNER),
    ],
    data: new Uint8Array([UPGRADE_TAG, 0, 0, 0]),
  };
}

const optionalKey = (data: ReadonlyUint8Array, at: number): Address | null =>
  data[at] === 1 ? getAddressDecoder().decode(data.subarray(at + 1, at + 33)) : null;

const named = (key: Address | null) => (key === null ? "nobody, so it is immutable" : key);

export async function proposeUpgrade(chain: Chain, input: { multisig: Address; member: Address; program: Address; buffer: Address; spill: Address }): Promise<Plan> {
  const vault = await vaultOf(input.multisig);
  const buffer = await chain.account(input.buffer);
  if (!owned(buffer, LOADER) || buffer.data.length < 37 || u32At(buffer.data, 0) !== 1) {
    throw new Refusal(`${input.buffer} is not a program buffer`);
  }
  const bufferAuthority = optionalKey(buffer.data, 4);
  if (bufferAuthority !== vault) {
    throw new Refusal(
      `buffer ${input.buffer} is controlled by ${named(bufferAuthority)}, not the vault ${vault}; run solana program set-buffer-authority ${input.buffer} --new-buffer-authority ${vault}`,
    );
  }
  await requireUpgradedBy(chain, input.program, vault);
  const instruction = await upgradeInstruction({ program: input.program, buffer: input.buffer, spill: input.spill, authority: vault });
  return propose(chain, input.multisig, input.member, [instruction], [upgradeSummary(input.program, input.buffer, input.spill, vault)]);
}

async function requireUpgradedBy(chain: Chain, program: Address, vault: Address): Promise<void> {
  const programData = await chain.account(await programDataOf(program));
  if (!owned(programData, LOADER) || programData.data.length < 45 || u32At(programData.data, 0) !== 3) {
    throw new Refusal(`${program} is not an upgradeable program`);
  }
  const upgradeAuthority = optionalKey(programData.data, 12);
  if (upgradeAuthority !== vault) {
    throw new Refusal(`program ${program} is upgraded by ${named(upgradeAuthority)}, not the vault ${vault}; move its upgrade authority to the vault first`);
  }
}

export async function setAuthorityInstruction(input: { program: Address; authority: Address; next: Address }): Promise<Instruction> {
  return {
    programAddress: LOADER,
    accounts: [
      meta(await programDataOf(input.program), AccountRole.WRITABLE),
      meta(input.authority, AccountRole.READONLY_SIGNER),
      meta(input.next, AccountRole.READONLY),
    ],
    data: new Uint8Array([SET_AUTHORITY_TAG, 0, 0, 0]),
  };
}

export async function proposeAuthority(chain: Chain, input: { multisig: Address; member: Address; program: Address; next: Address }): Promise<Plan> {
  const vault = await vaultOf(input.multisig);
  if (input.next === vault) {
    throw new Refusal(`the vault ${vault} already holds the upgrade authority it would hand over`);
  }
  await requireUpgradedBy(chain, input.program, vault);
  const instruction = await setAuthorityInstruction({ program: input.program, authority: vault, next: input.next });
  return propose(chain, input.multisig, input.member, [instruction], [authoritySummary(`program ${input.program}`, vault, input.next)]);
}

const authoritySummary = (program: string, authority: Address, next: Address) => `Hands the upgrade authority of ${program} from ${authority} to ${next}`;

const upgradeSummary = (program: Address, buffer: Address, spill: Address, authority: Address) =>
  `Upgrades program ${program} to the code in buffer ${buffer}, signed by ${authority}; the buffer's rent goes to ${spill}`;

type PrintedInstruction = { program: string; accounts: { address: string; signer: boolean; writable: boolean }[]; data: string };

const NO_UNSIGNED = "the command printed no unsigned transaction; run an intent engine admin command with --authority <vault>";

function parsePrinted(stdout: string): PrintedInstruction[] {
  let printed: unknown;
  try {
    printed = JSON.parse(stdout);
  } catch {
    throw new Refusal(`${NO_UNSIGNED}; it printed: ${stdout.trim().slice(0, 200)}`);
  }
  const unsigned = (printed as { unsigned?: { instructions?: unknown } } | null)?.unsigned;
  const list = unsigned?.instructions;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Refusal(NO_UNSIGNED);
  }
  for (const item of list as PrintedInstruction[]) {
    if (typeof item?.program !== "string" || typeof item.data !== "string" || !Array.isArray(item.accounts)) {
      throw new Refusal(`${NO_UNSIGNED}; an instruction it printed is malformed`);
    }
  }
  return list as PrintedInstruction[];
}

export const printedSummary = (stdout: string): string[] => {
  const summary = (JSON.parse(stdout) as { summary?: unknown }).summary;
  return Array.isArray(summary) ? summary.map(String) : [];
};

function printedAddress(text: unknown, at: number): Address {
  if (typeof text !== "string" || !isAddress(text)) {
    throw new Refusal(`${NO_UNSIGNED}; instruction ${at} names ${String(text)}, which is not an address`);
  }
  return text;
}

export function wrapPrinted(stdout: string, vault: Address): Instruction[] {
  return parsePrinted(stdout).map((item, at) => {
    const accounts = item.accounts.map((account) => {
      const key = printedAddress(account.address, at);
      if (account.signer && key !== vault) {
        throw new Refusal(`instruction ${at} needs a signature from ${account.address}, but only the vault ${vault} signs; pass --authority ${vault} to the command`);
      }
      return meta(key, roleOf(account.signer === true, account.writable === true));
    });
    return { programAddress: printedAddress(item.program, at), accounts, data: new Uint8Array(getBase64Encoder().encode(item.data)) };
  });
}

export async function proposeInstructions(chain: Chain, input: { multisig: Address; member: Address; stdout: string }): Promise<Plan> {
  const instructions = wrapPrinted(input.stdout, await vaultOf(input.multisig));
  return propose(chain, input.multisig, input.member, instructions, printedSummary(input.stdout));
}

async function activeProposal(chain: Chain, at: Address, index: bigint): Promise<Proposal> {
  const proposal = await readProposal(chain, at, index);
  if (proposal === null) {
    throw new Refusal(`multisig ${at} has no proposal ${index}`);
  }
  return proposal;
}

export async function approve(chain: Chain, input: { multisig: Address; member: Address; index: bigint }): Promise<Plan> {
  const multisig = await readMultisig(chain, input.multisig);
  requireMember(multisig, input.multisig, input.member, "vote", "approve");
  const proposal = await activeProposal(chain, input.multisig, input.index);
  if (proposal.status.__kind !== "Active") {
    throw new Refusal(`proposal ${input.index} is ${statusOf(proposal)}, so it takes no more approvals`);
  }
  if (proposal.approved.includes(input.member)) {
    throw new Refusal(`${input.member} already approved proposal ${input.index}`);
  }
  const after = proposal.approved.length + 1;
  return {
    summary: [
      `Approves proposal ${input.index} on multisig ${input.multisig} as ${input.member}`,
      after >= multisig.threshold ? `This is approval ${after} of ${multisig.threshold}; the proposal can then execute` : `This is approval ${after} of ${multisig.threshold}`,
    ],
    instructions: [proposalApprove({ multisig: input.multisig, proposal: await proposalPda(input.multisig, input.index), member: input.member })],
    signers: [],
    details: { multisig: input.multisig, index: input.index.toString(), approvals: after, threshold: multisig.threshold },
  };
}

async function clockSeconds(chain: Chain): Promise<bigint> {
  const clock = await chain.account(SYSVAR_CLOCK);
  if (clock === null) {
    throw new Error("the cluster returned no clock");
  }
  return new DataView(clock.data.buffer, clock.data.byteOffset, clock.data.byteLength).getBigInt64(32, true);
}

export function computeUnitLimit(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = SET_COMPUTE_UNIT_LIMIT;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET, data };
}

export async function executeInstruction(chain: Chain, input: { multisig: Address; member: Address; index: bigint }): Promise<Instruction> {
  const transaction = await transactionPda(input.multisig, input.index);
  const stored = await readVaultTransaction(chain, input.multisig, input.index);
  if (stored === null) {
    throw new Refusal(`proposal ${input.index} has no vault transaction to execute`);
  }
  return vaultTransactionExecute({
    multisig: input.multisig,
    proposal: await proposalPda(input.multisig, input.index),
    transaction,
    member: input.member,
    stored,
  });
}

export async function execute(chain: Chain, input: { multisig: Address; member: Address; index: bigint }): Promise<Plan> {
  const multisig = await readMultisig(chain, input.multisig);
  requireMember(multisig, input.multisig, input.member, "execute", "execute");
  const proposal = await activeProposal(chain, input.multisig, input.index);
  const status = proposal.status;
  if (status.__kind === "Active" || status.__kind === "Draft") {
    const missing = multisig.threshold - proposal.approved.length;
    throw new Refusal(`proposal ${input.index} has ${proposal.approved.length} of ${multisig.threshold} approvals; it needs ${missing} more before it can execute`);
  }
  if (status.__kind !== "Approved") {
    throw new Refusal(`proposal ${input.index} is ${statusOf(proposal)}, so it cannot execute`);
  }
  const ready = status.timestamp + BigInt(multisig.timeLock);
  const now = await clockSeconds(chain);
  if (now < ready) {
    throw new Refusal(`proposal ${input.index} is time locked for ${ready - now} more seconds, until ${new Date(Number(ready) * 1000).toISOString()}`);
  }
  const transaction = await readVaultTransaction(chain, input.multisig, input.index);
  if (transaction === null) {
    throw new Refusal(`proposal ${input.index} has no vault transaction to execute`);
  }
  if (transaction.message.addressTableLookups.length > 0) {
    throw new Refusal(`vault transaction ${input.index} uses address lookup tables, which this tool does not load`);
  }
  const instruction = await executeInstruction(chain, input);
  return {
    summary: [`Executes proposal ${input.index} on multisig ${input.multisig}`, ...(await decodeMessage(transaction.message)).map((d) => d.summary)],
    instructions: [computeUnitLimit(EXECUTE_UNITS), instruction],
    signers: [],
    details: { multisig: input.multisig, index: input.index.toString() },
  };
}

export type InstructionView = { program: string; accounts: { address: string; signer: boolean; writable: boolean }[]; data: string };

export function instructionView(ix: Instruction): InstructionView {
  return {
    program: ix.programAddress,
    accounts: (ix.accounts ?? []).map((k) => ({ address: k.address, signer: isSignerRole(k.role), writable: isWritableRole(k.role) })),
    data: getBase64Decoder().decode(ix.data ?? new Uint8Array()),
  };
}

const roleOf = (signer: boolean, writable: boolean): AccountRole =>
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
    accounts: Array.from(ix.accountIndexes, (at) => meta(keyAt(at), roleOf(isSignerIndex(message, at), isStaticWritableIndex(message, at)))),
    data: new Uint8Array(ix.data),
  }));
}

export type Decoded = InstructionView & { summary: string };

export async function decodeMessage(message: VaultMessage): Promise<Decoded[]> {
  const engineData = await programDataOf(ENGINE_PROGRAM);
  return messageInstructions(message).map((ix) => ({ ...instructionView(ix), summary: summarize(ix, engineData) }));
}

const signersOf = (ix: Instruction) => (ix.accounts ?? []).filter((k) => isSignerRole(k.role)).map((k) => k.address);

function summarize(ix: Instruction, engineData: Address): string {
  const accounts = ix.accounts ?? [];
  const data = ix.data ?? new Uint8Array();
  const at = (i: number) => accounts[i]?.address ?? DEFAULT_ADDRESS;
  const tag = data.length === 4 ? u32At(data, 0) : -1;
  if (ix.programAddress === LOADER && tag === UPGRADE_TAG) {
    return upgradeSummary(at(1), at(2), at(3), at(6));
  }
  if (ix.programAddress === LOADER && tag === SET_AUTHORITY_TAG && accounts.length === 3) {
    const program = engineData === at(0) ? `program ${ENGINE_PROGRAM}` : `the program whose data is ${at(0)}`;
    return authoritySummary(program, at(1), at(2));
  }
  if (ix.programAddress === ENGINE_PROGRAM) {
    return engineSummary(ix);
  }
  return `Runs program ${ix.programAddress} with ${accounts.length} accounts and ${data.length} bytes of data, signed by ${signersOf(ix).join(", ") || "nobody"}`;
}
