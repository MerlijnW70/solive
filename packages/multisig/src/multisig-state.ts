import type { Address, Instruction, TransactionPartialSigner } from "@solana/kit";
import type { Account, Chain } from "./chain.js";
import {
  decodeAccount,
  type Multisig,
  multisigCodec,
  PERMISSION,
  type Proposal,
  proposalCodec,
  proposalPda,
  SQUADS_PROGRAM,
  transactionPda,
  type VaultTransaction,
  vaultPda,
  vaultTransactionCodec,
} from "./layout.js";

export const VAULT_INDEX = 0;

type PermissionName = keyof typeof PERMISSION;

const PERMISSIONS = Object.entries(PERMISSION) as [PermissionName, number][];

export class Refusal extends Error {
  constructor(
    message: string,
    readonly shown?: object,
  ) {
    super(message);
  }
}

export type Plan = {
  summary: string[];
  instructions: Instruction[];
  signers: TransactionPartialSigner[];
  details: Record<string, unknown>;
  recheck?: () => Promise<void>;
};

export const vaultOf = (multisig: Address): Promise<Address> => vaultPda(multisig, VAULT_INDEX);

export const owned = (info: Account | null, owner: Address): info is Account => info !== null && info.owner === owner;

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

export function requireMember(multisig: Multisig, at: Address, member: Address, permission: PermissionName, action: string): void {
  const found = multisig.members.find((m) => m.key === member);
  if (found === undefined) {
    throw new Refusal(`${member} is not a member of multisig ${at}, so it cannot ${action}`);
  }
  if (!permissionNames(found.permissions.mask).includes(permission)) {
    throw new Refusal(`${member} lacks the ${permission} permission on multisig ${at}, so it cannot ${action}`);
  }
}

export const statusOf = (proposal: Proposal | null): string => (proposal === null ? "no proposal" : proposal.status.__kind.toLowerCase());
