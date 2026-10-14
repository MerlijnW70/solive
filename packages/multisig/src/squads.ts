import {
  type AccountInfo,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SYSVAR_CLOCK_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
  TransactionMessage,
} from "@solana/web3.js";
import * as squads from "@sqds/multisig";
import { INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core";
import { asConnection, type Chain } from "./chain.js";
import { engineSummary } from "./engine.js";

export const SQUADS_PROGRAM = new PublicKey("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");
export const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
export const ENGINE_PROGRAM = new PublicKey(INTENT_ENGINE_PROGRAM_ADDRESS);
export const VAULT_INDEX = 0;
export const EXECUTE_UNITS = 1_400_000;
export const UPGRADE_TAG = 3;
export const SET_AUTHORITY_TAG = 4;

const PERMISSIONS = [
  ["initiate", squads.types.Permission.Initiate],
  ["vote", squads.types.Permission.Vote],
  ["execute", squads.types.Permission.Execute],
] as const;

type PermissionName = (typeof PERMISSIONS)[number][0];

export class Refusal extends Error {}

export type Plan = {
  summary: string[];
  instructions: TransactionInstruction[];
  signers: Keypair[];
  details: Record<string, unknown>;
};

export type Multisig = squads.accounts.Multisig;
export type Proposal = squads.accounts.Proposal;

export const vaultOf = (multisig: PublicKey): PublicKey =>
  squads.getVaultPda({ multisigPda: multisig, index: VAULT_INDEX, programId: SQUADS_PROGRAM })[0];

export const programDataOf = (program: PublicKey): PublicKey => PublicKey.findProgramAddressSync([program.toBuffer()], LOADER)[0];

const owned = (info: AccountInfo<Buffer> | null, owner: PublicKey): info is AccountInfo<Buffer> => info !== null && info.owner.equals(owner);

export async function readMultisig(chain: Chain, address: PublicKey): Promise<Multisig> {
  const info = await chain.account(address);
  if (!owned(info, SQUADS_PROGRAM)) {
    throw new Refusal(`${address.toBase58()} is not a Squads v4 multisig`);
  }
  try {
    return squads.accounts.Multisig.fromAccountInfo(info)[0];
  } catch {
    throw new Refusal(`${address.toBase58()} is not a Squads v4 multisig`);
  }
}

export async function readProposal(chain: Chain, multisig: PublicKey, index: bigint): Promise<Proposal | null> {
  const [address] = squads.getProposalPda({ multisigPda: multisig, transactionIndex: index, programId: SQUADS_PROGRAM });
  const info = await chain.account(address);
  return owned(info, SQUADS_PROGRAM) ? squads.accounts.Proposal.fromAccountInfo(info)[0] : null;
}

export async function readVaultTransaction(chain: Chain, multisig: PublicKey, index: bigint): Promise<squads.accounts.VaultTransaction | null> {
  const [address] = squads.getTransactionPda({ multisigPda: multisig, index, programId: SQUADS_PROGRAM });
  const info = await chain.account(address);
  if (!owned(info, SQUADS_PROGRAM)) {
    return null;
  }
  try {
    return squads.accounts.VaultTransaction.fromAccountInfo(info)[0];
  } catch {
    return null;
  }
}

export const permissionNames = (mask: number): PermissionName[] =>
  PERMISSIONS.filter(([, bit]) => (mask & bit) !== 0).map(([name]) => name);

function requireMember(multisig: Multisig, address: PublicKey, key: PublicKey, permission: PermissionName, action: string): void {
  const member = multisig.members.find((m) => m.key.equals(key));
  if (member === undefined) {
    throw new Refusal(`${key.toBase58()} is not a member of multisig ${address.toBase58()}, so it cannot ${action}`);
  }
  if (!permissionNames(member.permissions.mask).includes(permission)) {
    throw new Refusal(`${key.toBase58()} lacks the ${permission} permission on multisig ${address.toBase58()}, so it cannot ${action}`);
  }
}

export const statusOf = (proposal: Proposal | null): string => (proposal === null ? "no proposal" : proposal.status.__kind.toLowerCase());

const indexOf = (multisig: Multisig): bigint => BigInt(squads.utils.toBigInt(multisig.transactionIndex));

export async function createMultisig(
  chain: Chain,
  input: { creator: PublicKey; createKey: Keypair; members: PublicKey[]; threshold: number; timeLock: number },
): Promise<Plan> {
  const keys = input.members.map((m) => m.toBase58());
  if (new Set(keys).size !== keys.length) {
    throw new Refusal("--members names the same key twice");
  }
  if (!Number.isInteger(input.threshold) || input.threshold < 1 || input.threshold > keys.length) {
    throw new Refusal(`--threshold must be between 1 and the ${keys.length} members`);
  }
  const [multisig] = squads.getMultisigPda({ createKey: input.createKey.publicKey, programId: SQUADS_PROGRAM });
  if ((await chain.account(multisig)) !== null) {
    throw new Refusal(`create key ${input.createKey.publicKey.toBase58()} already made multisig ${multisig.toBase58()}; pass another --create-key`);
  }
  const [programConfig] = squads.getProgramConfigPda({ programId: SQUADS_PROGRAM });
  const config = await chain.account(programConfig);
  if (!owned(config, SQUADS_PROGRAM)) {
    throw new Refusal(`the Squads v4 program config ${programConfig.toBase58()} is missing on this cluster`);
  }
  const { treasury } = squads.accounts.ProgramConfig.fromAccountInfo(config)[0];
  const vault = vaultOf(multisig);
  return {
    summary: [
      `Creates a ${input.threshold}-of-${keys.length} Squads v4 multisig ${multisig.toBase58()} with no config authority`,
      `Members, each allowed to initiate, vote and execute: ${keys.join(", ")}`,
      input.timeLock === 0 ? "No time lock: an approved proposal executes at once" : `Time lock: an approved proposal waits ${input.timeLock} seconds`,
      `Vault ${VAULT_INDEX}: ${vault.toBase58()}`,
    ],
    instructions: [
      squads.instructions.multisigCreateV2({
        treasury,
        creator: input.creator,
        multisigPda: multisig,
        configAuthority: null,
        threshold: input.threshold,
        members: input.members.map((key) => ({ key, permissions: squads.types.Permissions.all() })),
        timeLock: input.timeLock,
        createKey: input.createKey.publicKey,
        rentCollector: null,
        programId: SQUADS_PROGRAM,
      }),
    ],
    signers: [input.createKey],
    details: {
      multisig: multisig.toBase58(),
      vault: vault.toBase58(),
      create_key: input.createKey.publicKey.toBase58(),
      members: keys,
      threshold: input.threshold,
      time_lock: input.timeLock,
    },
  };
}

async function propose(chain: Chain, address: PublicKey, member: PublicKey, instructions: TransactionInstruction[], summary: string[]): Promise<Plan> {
  const multisig = await readMultisig(chain, address);
  requireMember(multisig, address, member, "initiate", "propose");
  const index = indexOf(multisig) + 1n;
  const vault = vaultOf(address);
  const transactionMessage = new TransactionMessage({ payerKey: vault, recentBlockhash: PublicKey.default.toBase58(), instructions });
  const [transaction] = squads.getTransactionPda({ multisigPda: address, index, programId: SQUADS_PROGRAM });
  const [proposal] = squads.getProposalPda({ multisigPda: address, transactionIndex: index, programId: SQUADS_PROGRAM });
  return {
    summary: [`Proposes vault transaction ${index} on multisig ${address.toBase58()}; it runs once ${multisig.threshold} members approve`, ...summary],
    instructions: [
      squads.instructions.vaultTransactionCreate({
        multisigPda: address,
        transactionIndex: index,
        creator: member,
        vaultIndex: VAULT_INDEX,
        ephemeralSigners: 0,
        transactionMessage,
        programId: SQUADS_PROGRAM,
      }),
      squads.instructions.proposalCreate({ multisigPda: address, creator: member, transactionIndex: index, programId: SQUADS_PROGRAM }),
    ],
    signers: [],
    details: {
      multisig: address.toBase58(),
      vault: vault.toBase58(),
      index: index.toString(),
      transaction: transaction.toBase58(),
      proposal: proposal.toBase58(),
      instructions: instructions.map(instructionView),
    },
  };
}

export function upgradeInstruction(input: { program: PublicKey; buffer: PublicKey; spill: PublicKey; authority: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: LOADER,
    keys: [
      { pubkey: programDataOf(input.program), isSigner: false, isWritable: true },
      { pubkey: input.program, isSigner: false, isWritable: true },
      { pubkey: input.buffer, isSigner: false, isWritable: true },
      { pubkey: input.spill, isSigner: false, isWritable: true },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_CLOCK_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: input.authority, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([UPGRADE_TAG, 0, 0, 0]),
  });
}

const optionalKey = (data: Buffer, at: number): PublicKey | null => (data[at] === 1 ? new PublicKey(data.subarray(at + 1, at + 33)) : null);

const named = (key: PublicKey | null) => (key === null ? "nobody, so it is immutable" : key.toBase58());

export async function proposeUpgrade(
  chain: Chain,
  input: { multisig: PublicKey; member: PublicKey; program: PublicKey; buffer: PublicKey; spill: PublicKey },
): Promise<Plan> {
  const vault = vaultOf(input.multisig);
  const buffer = await chain.account(input.buffer);
  if (!owned(buffer, LOADER) || buffer.data.length < 37 || buffer.data.readUInt32LE(0) !== 1) {
    throw new Refusal(`${input.buffer.toBase58()} is not a program buffer`);
  }
  const bufferAuthority = optionalKey(buffer.data, 4);
  if (bufferAuthority === null || !bufferAuthority.equals(vault)) {
    throw new Refusal(
      `buffer ${input.buffer.toBase58()} is controlled by ${named(bufferAuthority)}, not the vault ${vault.toBase58()}; run solana program set-buffer-authority ${input.buffer.toBase58()} --new-buffer-authority ${vault.toBase58()}`,
    );
  }
  await requireUpgradedBy(chain, input.program, vault);
  const instruction = upgradeInstruction({ program: input.program, buffer: input.buffer, spill: input.spill, authority: vault });
  return propose(chain, input.multisig, input.member, [instruction], [upgradeSummary(input.program, input.buffer, input.spill, vault)]);
}

async function requireUpgradedBy(chain: Chain, program: PublicKey, vault: PublicKey): Promise<void> {
  const programData = await chain.account(programDataOf(program));
  if (!owned(programData, LOADER) || programData.data.length < 45 || programData.data.readUInt32LE(0) !== 3) {
    throw new Refusal(`${program.toBase58()} is not an upgradeable program`);
  }
  const upgradeAuthority = optionalKey(programData.data, 12);
  if (upgradeAuthority === null || !upgradeAuthority.equals(vault)) {
    throw new Refusal(
      `program ${program.toBase58()} is upgraded by ${named(upgradeAuthority)}, not the vault ${vault.toBase58()}; move its upgrade authority to the vault first`,
    );
  }
}

export function setAuthorityInstruction(input: { program: PublicKey; authority: PublicKey; next: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: LOADER,
    keys: [
      { pubkey: programDataOf(input.program), isSigner: false, isWritable: true },
      { pubkey: input.authority, isSigner: true, isWritable: false },
      { pubkey: input.next, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([SET_AUTHORITY_TAG, 0, 0, 0]),
  });
}

export async function proposeAuthority(
  chain: Chain,
  input: { multisig: PublicKey; member: PublicKey; program: PublicKey; next: PublicKey },
): Promise<Plan> {
  const vault = vaultOf(input.multisig);
  if (input.next.equals(vault)) {
    throw new Refusal(`the vault ${vault.toBase58()} already holds the upgrade authority it would hand over`);
  }
  await requireUpgradedBy(chain, input.program, vault);
  const instruction = setAuthorityInstruction({ program: input.program, authority: vault, next: input.next });
  return propose(chain, input.multisig, input.member, [instruction], [authoritySummary(`program ${input.program.toBase58()}`, vault, input.next)]);
}

const authoritySummary = (program: string, authority: PublicKey, next: PublicKey) =>
  `Hands the upgrade authority of ${program} from ${authority.toBase58()} to ${next.toBase58()}`;

const upgradeSummary = (program: PublicKey, buffer: PublicKey, spill: PublicKey, authority: PublicKey) =>
  `Upgrades program ${program.toBase58()} to the code in buffer ${buffer.toBase58()}, signed by ${authority.toBase58()}; the buffer's rent goes to ${spill.toBase58()}`;

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

export function wrapPrinted(stdout: string, vault: PublicKey): TransactionInstruction[] {
  return parsePrinted(stdout).map((item, at) => {
    const keys = item.accounts.map((meta) => {
      const pubkey = new PublicKey(meta.address);
      if (meta.signer && !pubkey.equals(vault)) {
        throw new Refusal(`instruction ${at} needs a signature from ${meta.address}, but only the vault ${vault.toBase58()} signs; pass --authority ${vault.toBase58()} to the command`);
      }
      return { pubkey, isSigner: meta.signer === true, isWritable: meta.writable === true };
    });
    return new TransactionInstruction({ programId: new PublicKey(item.program), keys, data: Buffer.from(item.data, "base64") });
  });
}

export async function proposeInstructions(chain: Chain, input: { multisig: PublicKey; member: PublicKey; stdout: string }): Promise<Plan> {
  const instructions = wrapPrinted(input.stdout, vaultOf(input.multisig));
  return propose(chain, input.multisig, input.member, instructions, printedSummary(input.stdout));
}

async function activeProposal(chain: Chain, address: PublicKey, index: bigint): Promise<Proposal> {
  const proposal = await readProposal(chain, address, index);
  if (proposal === null) {
    throw new Refusal(`multisig ${address.toBase58()} has no proposal ${index}`);
  }
  return proposal;
}

export async function approve(chain: Chain, input: { multisig: PublicKey; member: PublicKey; index: bigint }): Promise<Plan> {
  const multisig = await readMultisig(chain, input.multisig);
  requireMember(multisig, input.multisig, input.member, "vote", "approve");
  const proposal = await activeProposal(chain, input.multisig, input.index);
  if (proposal.status.__kind !== "Active") {
    throw new Refusal(`proposal ${input.index} is ${statusOf(proposal)}, so it takes no more approvals`);
  }
  if (proposal.approved.some((k) => k.equals(input.member))) {
    throw new Refusal(`${input.member.toBase58()} already approved proposal ${input.index}`);
  }
  const after = proposal.approved.length + 1;
  return {
    summary: [
      `Approves proposal ${input.index} on multisig ${input.multisig.toBase58()} as ${input.member.toBase58()}`,
      after >= multisig.threshold ? `This is approval ${after} of ${multisig.threshold}; the proposal can then execute` : `This is approval ${after} of ${multisig.threshold}`,
    ],
    instructions: [
      squads.instructions.proposalApprove({ multisigPda: input.multisig, transactionIndex: input.index, member: input.member, programId: SQUADS_PROGRAM }),
    ],
    signers: [],
    details: { multisig: input.multisig.toBase58(), index: input.index.toString(), approvals: after, threshold: multisig.threshold },
  };
}

async function clockSeconds(chain: Chain): Promise<bigint> {
  const clock = await chain.account(SYSVAR_CLOCK_PUBKEY);
  if (clock === null) {
    throw new Error("the cluster returned no clock");
  }
  return clock.data.readBigInt64LE(32);
}

export async function execute(chain: Chain, input: { multisig: PublicKey; member: PublicKey; index: bigint }): Promise<Plan> {
  const multisig = await readMultisig(chain, input.multisig);
  requireMember(multisig, input.multisig, input.member, "execute", "execute");
  const proposal = await activeProposal(chain, input.multisig, input.index);
  const status = proposal.status;
  if (status.__kind === "Active" || status.__kind === "Draft") {
    const missing = multisig.threshold - proposal.approved.length;
    throw new Refusal(
      `proposal ${input.index} has ${proposal.approved.length} of ${multisig.threshold} approvals; it needs ${missing} more before it can execute`,
    );
  }
  if (status.__kind !== "Approved") {
    throw new Refusal(`proposal ${input.index} is ${statusOf(proposal)}, so it cannot execute`);
  }
  const ready = BigInt(squads.utils.toBigInt(status.timestamp)) + BigInt(multisig.timeLock);
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
  const { instruction } = await squads.instructions.vaultTransactionExecute({
    connection: asConnection(chain),
    multisigPda: input.multisig,
    transactionIndex: input.index,
    member: input.member,
    programId: SQUADS_PROGRAM,
  });
  return {
    summary: [`Executes proposal ${input.index} on multisig ${input.multisig.toBase58()}`, ...decodeMessage(transaction.message).map((d) => d.summary)],
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: EXECUTE_UNITS }), instruction],
    signers: [],
    details: { multisig: input.multisig.toBase58(), index: input.index.toString() },
  };
}

export type InstructionView = { program: string; accounts: { address: string; signer: boolean; writable: boolean }[]; data: string };

export function instructionView(ix: TransactionInstruction): InstructionView {
  return {
    program: ix.programId.toBase58(),
    accounts: ix.keys.map((k) => ({ address: k.pubkey.toBase58(), signer: k.isSigner, writable: k.isWritable })),
    data: ix.data.toString("base64"),
  };
}

export function messageInstructions(message: squads.generated.VaultTransactionMessage): TransactionInstruction[] {
  return message.instructions.map((ix) => {
    const program = message.accountKeys[ix.programIdIndex];
    if (program === undefined) {
      throw new Error(`instruction names account ${ix.programIdIndex}, beyond the message's ${message.accountKeys.length} keys`);
    }
    return new TransactionInstruction({
      programId: program,
      keys: Array.from(ix.accountIndexes, (at) => {
        const pubkey = message.accountKeys[at];
        if (pubkey === undefined) {
          throw new Error(`instruction names account ${at}, beyond the message's ${message.accountKeys.length} keys`);
        }
        return { pubkey, isSigner: squads.utils.isSignerIndex(message, at), isWritable: squads.utils.isStaticWritableIndex(message, at) };
      }),
      data: Buffer.from(ix.data),
    });
  });
}

export type Decoded = InstructionView & { summary: string };

export function decodeMessage(message: squads.generated.VaultTransactionMessage): Decoded[] {
  return messageInstructions(message).map((ix) => ({ ...instructionView(ix), summary: summarize(ix) }));
}

const signersOf = (ix: TransactionInstruction) => ix.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58());

function summarize(ix: TransactionInstruction): string {
  const at = (i: number) => ix.keys[i]?.pubkey ?? PublicKey.default;
  if (ix.programId.equals(LOADER) && ix.data.length === 4 && ix.data.readUInt32LE(0) === UPGRADE_TAG) {
    return upgradeSummary(at(1), at(2), at(3), at(6));
  }
  if (ix.programId.equals(LOADER) && ix.data.length === 4 && ix.data.readUInt32LE(0) === SET_AUTHORITY_TAG && ix.keys.length === 3) {
    const program = programDataOf(ENGINE_PROGRAM).equals(at(0)) ? `program ${ENGINE_PROGRAM.toBase58()}` : `the program whose data is ${at(0).toBase58()}`;
    return authoritySummary(program, at(1), at(2));
  }
  if (ix.programId.equals(ENGINE_PROGRAM)) {
    return engineSummary(ix);
  }
  return `Runs program ${ix.programId.toBase58()} with ${ix.keys.length} accounts and ${ix.data.length} bytes of data, signed by ${signersOf(ix).join(", ") || "nobody"}`;
}
