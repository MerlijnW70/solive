import {
  AccountRole,
  type Address,
  addCodecSizePrefix,
  getAddressCodec,
  getArrayCodec,
  getBooleanCodec,
  getBytesCodec,
  getNullableCodec,
  getStructCodec,
  getU16Codec,
  getU32Codec,
  getU64Codec,
  getU8Codec,
  getUtf8Codec,
  type Instruction,
  isSignerRole,
  isWritableRole,
  type ReadonlyUint8Array,
} from "@solana/kit";
import { memberCodec, type VaultMessage, type VaultTransaction } from "./account-codecs.js";
import { ALL_PERMISSIONS, DISCRIMINATORS, discriminated, ephemeralSignerPda, SQUADS_PROGRAM, SYSTEM_PROGRAM, vaultPda } from "./squads-addresses.js";

export {
  type ConfigAction,
  configActionCodec,
  type ConfigTransaction,
  configTransactionCodec,
  type Member,
  type Multisig,
  multisigCodec,
  type Period,
  type ProgramConfig,
  programConfigCodec,
  type Proposal,
  proposalCodec,
  type ProposalStatus,
  type VaultMessage,
  vaultMessageCodec,
  type VaultTransaction,
  vaultTransactionCodec,
} from "./account-codecs.js";
export {
  ALL_PERMISSIONS,
  decodeAccount,
  DISCRIMINATORS,
  encodeAccount,
  ephemeralSignerPda,
  multisigPda,
  PERMISSION,
  programConfigPda,
  proposalPda,
  SQUADS_PROGRAM,
  SYSTEM_PROGRAM,
  transactionPda,
  vaultPda,
} from "./squads-addresses.js";

const key = getAddressCodec();
const bytes = addCodecSizePrefix(getBytesCodec(), getU32Codec());
const memo = getNullableCodec(addCodecSizePrefix(getUtf8Codec(), getU32Codec()));

const small = getU8Codec();

const compactMessageCodec = getStructCodec([
  ["numSigners", getU8Codec()],
  ["numWritableSigners", getU8Codec()],
  ["numWritableNonSigners", getU8Codec()],
  ["accountKeys", getArrayCodec(key, { size: small })],
  [
    "instructions",
    getArrayCodec(
      getStructCodec([
        ["programIdIndex", getU8Codec()],
        ["accountIndexes", addCodecSizePrefix(getBytesCodec(), small)],
        ["data", addCodecSizePrefix(getBytesCodec(), getU16Codec())],
      ]),
      { size: small },
    ),
  ],
  [
    "addressTableLookups",
    getArrayCodec(
      getStructCodec([
        ["accountKey", key],
        ["writableIndexes", addCodecSizePrefix(getBytesCodec(), small)],
        ["readonlyIndexes", addCodecSizePrefix(getBytesCodec(), small)],
      ]),
      { size: small },
    ),
  ],
]);

const multisigCreateArgs = getStructCodec([
  ["configAuthority", getNullableCodec(key)],
  ["threshold", getU16Codec()],
  ["members", getArrayCodec(memberCodec)],
  ["timeLock", getU32Codec()],
  ["rentCollector", getNullableCodec(key)],
  ["memo", memo],
]);

const vaultTransactionCreateArgs = getStructCodec([
  ["vaultIndex", getU8Codec()],
  ["ephemeralSigners", getU8Codec()],
  ["transactionMessage", bytes],
  ["memo", memo],
]);

const proposalCreateArgs = getStructCodec([
  ["transactionIndex", getU64Codec()],
  ["draft", getBooleanCodec()],
]);

const proposalVoteArgs = getStructCodec([["memo", memo]]);


const meta = (at: Address, role: AccountRole) => ({ address: at, role });

const build = (name: keyof typeof DISCRIMINATORS, accounts: Instruction["accounts"], body: ReadonlyUint8Array = new Uint8Array()): Instruction => ({
  programAddress: SQUADS_PROGRAM,
  accounts: accounts ?? [],
  data: discriminated(DISCRIMINATORS[name], body),
});

export function multisigCreateV2(input: {
  programConfig: Address;
  treasury: Address;
  multisig: Address;
  createKey: Address;
  creator: Address;
  threshold: number;
  members: Address[];
  timeLock: number;
}): Instruction {
  return build(
    "multisigCreateV2",
    [
      meta(input.programConfig, AccountRole.READONLY),
      meta(input.treasury, AccountRole.WRITABLE),
      meta(input.multisig, AccountRole.WRITABLE),
      meta(input.createKey, AccountRole.READONLY_SIGNER),
      meta(input.creator, AccountRole.WRITABLE_SIGNER),
      meta(SYSTEM_PROGRAM, AccountRole.READONLY),
    ],
    multisigCreateArgs.encode({
      configAuthority: null,
      threshold: input.threshold,
      members: input.members.map((member) => ({ key: member, permissions: { mask: ALL_PERMISSIONS } })),
      timeLock: input.timeLock,
      rentCollector: null,
      memo: null,
    }),
  );
}

export const MAX_ACCOUNT_KEYS = 255;

export function compileVaultMessage(vault: Address, instructions: readonly Instruction[]): ReadonlyUint8Array {
  const metas = new Map<Address, { signer: boolean; writable: boolean }>();
  const entry = (at: Address) => {
    const found = metas.get(at) ?? { signer: false, writable: false };
    metas.set(at, found);
    return found;
  };
  Object.assign(entry(vault), { signer: true, writable: true });
  for (const ix of instructions) {
    entry(ix.programAddress);
    for (const account of ix.accounts ?? []) {
      const found = entry(account.address);
      found.signer ||= isSignerRole(account.role);
      found.writable ||= isWritableRole(account.role);
    }
  }
  const all = [...metas];
  const pick = (signer: boolean, writable: boolean) => all.filter(([, m]) => m.signer === signer && m.writable === writable).map(([at]) => at);
  const groups = [pick(true, true), pick(true, false), pick(false, true), pick(false, false)] as const;
  const accountKeys = groups.flat();
  if (accountKeys.length > MAX_ACCOUNT_KEYS) {
    throw new Error(`the proposal names ${accountKeys.length} accounts, more than the ${MAX_ACCOUNT_KEYS} a vault transaction holds`);
  }
  const indexOf = (at: Address) => accountKeys.indexOf(at);
  return compactMessageCodec.encode({
    numSigners: groups[0].length + groups[1].length,
    numWritableSigners: groups[0].length,
    numWritableNonSigners: groups[2].length,
    accountKeys,
    instructions: instructions.map((ix) => ({
      programIdIndex: indexOf(ix.programAddress),
      accountIndexes: new Uint8Array((ix.accounts ?? []).map((account) => indexOf(account.address))),
      data: ix.data ?? new Uint8Array(),
    })),
    addressTableLookups: [],
  });
}

export function vaultTransactionCreate(input: {
  multisig: Address;
  transaction: Address;
  creator: Address;
  vaultIndex: number;
  message: ReadonlyUint8Array;
}): Instruction {
  return build(
    "vaultTransactionCreate",
    [
      meta(input.multisig, AccountRole.WRITABLE),
      meta(input.transaction, AccountRole.WRITABLE),
      meta(input.creator, AccountRole.READONLY_SIGNER),
      meta(input.creator, AccountRole.WRITABLE_SIGNER),
      meta(SYSTEM_PROGRAM, AccountRole.READONLY),
    ],
    vaultTransactionCreateArgs.encode({ vaultIndex: input.vaultIndex, ephemeralSigners: 0, transactionMessage: input.message, memo: null }),
  );
}

export function proposalCreate(input: { multisig: Address; proposal: Address; creator: Address; index: bigint }): Instruction {
  return build(
    "proposalCreate",
    [
      meta(input.multisig, AccountRole.READONLY),
      meta(input.proposal, AccountRole.WRITABLE),
      meta(input.creator, AccountRole.READONLY_SIGNER),
      meta(input.creator, AccountRole.WRITABLE_SIGNER),
      meta(SYSTEM_PROGRAM, AccountRole.READONLY),
    ],
    proposalCreateArgs.encode({ transactionIndex: input.index, draft: false }),
  );
}

export function proposalApprove(input: { multisig: Address; proposal: Address; member: Address }): Instruction {
  return build(
    "proposalApprove",
    [meta(input.multisig, AccountRole.READONLY), meta(input.member, AccountRole.WRITABLE_SIGNER), meta(input.proposal, AccountRole.WRITABLE)],
    proposalVoteArgs.encode({ memo: null }),
  );
}

export function proposalReject(input: { multisig: Address; proposal: Address; member: Address }): Instruction {
  return build(
    "proposalReject",
    [meta(input.multisig, AccountRole.READONLY), meta(input.member, AccountRole.WRITABLE_SIGNER), meta(input.proposal, AccountRole.WRITABLE)],
    proposalVoteArgs.encode({ memo: null }),
  );
}

export function proposalCancelV2(input: { multisig: Address; proposal: Address; member: Address }): Instruction {
  return build(
    "proposalCancelV2",
    [
      meta(input.multisig, AccountRole.READONLY),
      meta(input.member, AccountRole.WRITABLE_SIGNER),
      meta(input.proposal, AccountRole.WRITABLE),
      meta(SYSTEM_PROGRAM, AccountRole.READONLY),
    ],
    proposalVoteArgs.encode({ memo: null }),
  );
}

export function configTransactionExecute(input: { multisig: Address; proposal: Address; transaction: Address; member: Address }): Instruction {
  return build("configTransactionExecute", [
    meta(input.multisig, AccountRole.WRITABLE),
    meta(input.member, AccountRole.READONLY_SIGNER),
    meta(input.proposal, AccountRole.WRITABLE),
    meta(input.transaction, AccountRole.READONLY),
    meta(input.member, AccountRole.WRITABLE_SIGNER),
    meta(SYSTEM_PROGRAM, AccountRole.READONLY),
  ]);
}

export const isSignerIndex = (message: VaultMessage, index: number): boolean => index < message.numSigners;

export function isStaticWritableIndex(message: VaultMessage, index: number): boolean {
  if (index >= message.accountKeys.length) {
    return false;
  }
  if (index < message.numWritableSigners) {
    return true;
  }
  return index >= message.numSigners && index - message.numSigners < message.numWritableNonSigners;
}

const roleOf = (signer: boolean, writable: boolean): AccountRole =>
  signer ? (writable ? AccountRole.WRITABLE_SIGNER : AccountRole.READONLY_SIGNER) : writable ? AccountRole.WRITABLE : AccountRole.READONLY;

export async function vaultTransactionExecute(input: {
  multisig: Address;
  proposal: Address;
  transaction: Address;
  member: Address;
  stored: VaultTransaction;
}): Promise<Instruction> {
  const { message } = input.stored;
  if (message.addressTableLookups.length > 0) {
    throw new Error("the vault transaction uses address lookup tables, which this tool does not load");
  }
  const vault = await vaultPda(input.multisig, input.stored.vaultIndex);
  const ephemeral = await Promise.all(Array.from(input.stored.ephemeralSignerBumps, (_, at) => ephemeralSignerPda(input.transaction, at)));
  const foreign = message.accountKeys.filter((at, index) => isSignerIndex(message, index) && at !== vault && !ephemeral.includes(at));
  if (foreign.length > 0) {
    throw new Error(`the vault transaction asks ${foreign.join(", ")} to sign, but only the vault and its ephemeral signers may`);
  }
  const remaining = message.accountKeys.map((at, index) => meta(at, roleOf(false, isStaticWritableIndex(message, index))));
  return build("vaultTransactionExecute", [
    meta(input.multisig, AccountRole.READONLY),
    meta(input.proposal, AccountRole.WRITABLE),
    meta(input.transaction, AccountRole.READONLY),
    meta(input.member, AccountRole.READONLY_SIGNER),
    ...remaining,
  ]);
}
