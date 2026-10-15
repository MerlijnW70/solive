import { AccountRole, type Address, getBase64Encoder, type Instruction, isAddress } from "@solana/kit";
import type { Chain } from "./chain.js";
import { compileVaultMessage, proposalCreate, proposalPda, transactionPda, vaultTransactionCreate } from "./layout.js";
import { type Plan, readMultisig, Refusal, requireMember, VAULT_INDEX, vaultOf } from "./multisig-state.js";
import {
  describeInstructions,
  instructionView,
  LOADER,
  loaderState,
  named,
  programDataOf,
  roleOf,
  SET_AUTHORITY_TAG,
  SYSVAR_CLOCK,
  SYSVAR_RENT,
  UPGRADE_TAG,
} from "./review.js";

async function propose(chain: Chain, at: Address, member: Address, instructions: Instruction[]): Promise<Plan> {
  const multisig = await readMultisig(chain, at);
  requireMember(multisig, at, member, "initiate", "propose");
  const index = multisig.transactionIndex + 1n;
  const vault = await vaultOf(at);
  const transaction = await transactionPda(at, index);
  const proposal = await proposalPda(at, index);
  const { decoded } = await describeInstructions(chain, instructions);
  return {
    summary: [`Proposes vault transaction ${index} on multisig ${at}; it runs once ${multisig.threshold} members approve`, ...decoded.map((d) => d.summary)],
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

export async function proposeUpgrade(chain: Chain, input: { multisig: Address; member: Address; program: Address; buffer: Address; spill: Address }): Promise<Plan> {
  const vault = await vaultOf(input.multisig);
  const buffer = loaderState(await chain.account(input.buffer));
  if (buffer.kind !== "buffer") {
    throw new Refusal(`${input.buffer} is not a program buffer`);
  }
  const bufferAuthority = buffer.authority;
  if (bufferAuthority !== vault) {
    throw new Refusal(
      `buffer ${input.buffer} is controlled by ${named(bufferAuthority)}, not the vault ${vault}; run solana program set-buffer-authority ${input.buffer} --new-buffer-authority ${vault}`,
    );
  }
  await requireUpgradedBy(chain, input.program, vault);
  const instruction = await upgradeInstruction({ program: input.program, buffer: input.buffer, spill: input.spill, authority: vault });
  return propose(chain, input.multisig, input.member, [instruction]);
}

async function requireUpgradedBy(chain: Chain, program: Address, vault: Address): Promise<void> {
  const programData = loaderState(await chain.account(await programDataOf(program)));
  if (programData.kind !== "program data") {
    throw new Refusal(`${program} is not an upgradeable program`);
  }
  const upgradeAuthority = programData.authority;
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
  return propose(chain, input.multisig, input.member, [instruction]);
}

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
  return propose(chain, input.multisig, input.member, instructions);
}
