import {
  AccountRole,
  type Address,
  addCodecSizePrefix,
  address,
  type Codec,
  fixCodecSize,
  getAddressCodec,
  getAddressEncoder,
  getArrayCodec,
  getBooleanCodec,
  getBytesCodec,
  getDiscriminatedUnionCodec,
  getI64Codec,
  getNullableCodec,
  getProgramDerivedAddress,
  getStructCodec,
  getU16Codec,
  getU32Codec,
  getU64Codec,
  getU64Encoder,
  getU8Codec,
  getUtf8Codec,
  type Instruction,
  isSignerRole,
  isWritableRole,
  type ReadonlyUint8Array,
} from "@solana/kit";

export const SQUADS_PROGRAM = address("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf");
export const SYSTEM_PROGRAM = address("11111111111111111111111111111111");

export const DISCRIMINATORS = {
  multisigCreateV2: [50, 221, 199, 93, 40, 245, 139, 233],
  vaultTransactionCreate: [48, 250, 78, 168, 208, 226, 218, 211],
  proposalCreate: [220, 60, 73, 224, 30, 108, 79, 159],
  proposalApprove: [144, 37, 164, 136, 188, 216, 42, 248],
  vaultTransactionExecute: [194, 8, 161, 87, 153, 164, 25, 171],
  Multisig: [224, 116, 121, 186, 68, 161, 79, 236],
  Proposal: [26, 94, 189, 187, 116, 136, 53, 33],
  VaultTransaction: [168, 250, 162, 100, 81, 14, 162, 207],
  ProgramConfig: [196, 210, 90, 231, 144, 149, 140, 63],
} as const;

export const PERMISSION = { initiate: 1, vote: 2, execute: 4 } as const;
export const ALL_PERMISSIONS = PERMISSION.initiate | PERMISSION.vote | PERMISSION.execute;

const key = getAddressCodec();
const bytes = addCodecSizePrefix(getBytesCodec(), getU32Codec());
const memo = getNullableCodec(addCodecSizePrefix(getUtf8Codec(), getU32Codec()));
const timestamped = getStructCodec([["timestamp", getI64Codec()]]);

export type Member = { key: Address; permissions: { mask: number } };

export type ProgramConfig = { authority: Address; multisigCreationFee: bigint; treasury: Address; reserved: ReadonlyUint8Array };

export type Multisig = {
  createKey: Address;
  configAuthority: Address;
  threshold: number;
  timeLock: number;
  transactionIndex: bigint;
  staleTransactionIndex: bigint;
  rentCollector: Address | null;
  bump: number;
  members: Member[];
};

export type ProposalStatus =
  | { __kind: "Draft" | "Active" | "Rejected" | "Approved" | "Executed" | "Cancelled"; timestamp: bigint }
  | { __kind: "Executing" };

export type Proposal = {
  multisig: Address;
  transactionIndex: bigint;
  status: ProposalStatus;
  bump: number;
  approved: Address[];
  rejected: Address[];
  cancelled: Address[];
};

export type VaultMessage = {
  numSigners: number;
  numWritableSigners: number;
  numWritableNonSigners: number;
  accountKeys: Address[];
  instructions: { programIdIndex: number; accountIndexes: ReadonlyUint8Array; data: ReadonlyUint8Array }[];
  addressTableLookups: { accountKey: Address; writableIndexes: ReadonlyUint8Array; readonlyIndexes: ReadonlyUint8Array }[];
};

export type VaultTransaction = {
  multisig: Address;
  creator: Address;
  index: bigint;
  bump: number;
  vaultIndex: number;
  vaultBump: number;
  ephemeralSignerBumps: ReadonlyUint8Array;
  message: VaultMessage;
};

const memberCodec: Codec<Member> = getStructCodec([
  ["key", key],
  ["permissions", getStructCodec([["mask", getU8Codec()]])],
]);

export const programConfigCodec: Codec<ProgramConfig> = getStructCodec([
  ["authority", key],
  ["multisigCreationFee", getU64Codec()],
  ["treasury", key],
  ["reserved", fixCodecSize(getBytesCodec(), 64)],
]);

export const multisigCodec: Codec<Multisig> = getStructCodec([
  ["createKey", key],
  ["configAuthority", key],
  ["threshold", getU16Codec()],
  ["timeLock", getU32Codec()],
  ["transactionIndex", getU64Codec()],
  ["staleTransactionIndex", getU64Codec()],
  ["rentCollector", getNullableCodec(key)],
  ["bump", getU8Codec()],
  ["members", getArrayCodec(memberCodec)],
]);

export const proposalCodec: Codec<Proposal> = getStructCodec([
  ["multisig", key],
  ["transactionIndex", getU64Codec()],
  [
    "status",
    getDiscriminatedUnionCodec([
      ["Draft", timestamped],
      ["Active", timestamped],
      ["Rejected", timestamped],
      ["Approved", timestamped],
      ["Executing", getStructCodec([])],
      ["Executed", timestamped],
      ["Cancelled", timestamped],
    ]),
  ],
  ["bump", getU8Codec()],
  ["approved", getArrayCodec(key)],
  ["rejected", getArrayCodec(key)],
  ["cancelled", getArrayCodec(key)],
]);

export const vaultMessageCodec: Codec<VaultMessage> = getStructCodec([
  ["numSigners", getU8Codec()],
  ["numWritableSigners", getU8Codec()],
  ["numWritableNonSigners", getU8Codec()],
  ["accountKeys", getArrayCodec(key)],
  [
    "instructions",
    getArrayCodec(
      getStructCodec([
        ["programIdIndex", getU8Codec()],
        ["accountIndexes", bytes],
        ["data", bytes],
      ]),
    ),
  ],
  [
    "addressTableLookups",
    getArrayCodec(
      getStructCodec([
        ["accountKey", key],
        ["writableIndexes", bytes],
        ["readonlyIndexes", bytes],
      ]),
    ),
  ],
]);

export const vaultTransactionCodec: Codec<VaultTransaction> = getStructCodec([
  ["multisig", key],
  ["creator", key],
  ["index", getU64Codec()],
  ["bump", getU8Codec()],
  ["vaultIndex", getU8Codec()],
  ["vaultBump", getU8Codec()],
  ["ephemeralSignerBumps", bytes],
  ["message", vaultMessageCodec],
]);

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

type AccountName = "Multisig" | "Proposal" | "VaultTransaction" | "ProgramConfig";

const discriminated = (discriminator: readonly number[], body: ReadonlyUint8Array): Uint8Array => {
  const out = new Uint8Array(discriminator.length + body.length);
  out.set(discriminator);
  out.set(body, discriminator.length);
  return out;
};

export function decodeAccount<T extends object>(name: AccountName, codec: Codec<T>, data: ReadonlyUint8Array): T | null {
  const discriminator = DISCRIMINATORS[name];
  if (data.length < discriminator.length || discriminator.some((b, i) => data[i] !== b)) {
    return null;
  }
  try {
    return codec.decode(data, discriminator.length);
  } catch {
    return null;
  }
}

export const encodeAccount = <T extends object>(name: AccountName, codec: Codec<T>, value: T): Uint8Array =>
  discriminated(DISCRIMINATORS[name], codec.encode(value));

const seedOf = (value: Address) => getAddressEncoder().encode(value);

const pda = async (seeds: (string | ReadonlyUint8Array)[]): Promise<Address> =>
  (await getProgramDerivedAddress({ programAddress: SQUADS_PROGRAM, seeds: ["multisig", ...seeds] }))[0];

export const programConfigPda = () => pda(["program_config"]);
export const multisigPda = (createKey: Address) => pda(["multisig", seedOf(createKey)]);
export const vaultPda = (multisig: Address, index: number) => pda([seedOf(multisig), "vault", new Uint8Array([index])]);
export const transactionPda = (multisig: Address, index: bigint) => pda([seedOf(multisig), "transaction", getU64Encoder().encode(index)]);
export const proposalPda = (multisig: Address, index: bigint) => pda([seedOf(multisig), "transaction", getU64Encoder().encode(index), "proposal"]);
export const ephemeralSignerPda = (transaction: Address, index: number) => pda([seedOf(transaction), "ephemeral_signer", new Uint8Array([index])]);

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
  if (accountKeys.length > 256) {
    throw new Error(`the proposal names ${accountKeys.length} accounts, more than the 256 a vault transaction holds`);
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
  const remaining = message.accountKeys.map((at, index) =>
    meta(at, roleOf(isSignerIndex(message, index) && at !== vault && !ephemeral.includes(at), isStaticWritableIndex(message, index))),
  );
  return build("vaultTransactionExecute", [
    meta(input.multisig, AccountRole.READONLY),
    meta(input.proposal, AccountRole.WRITABLE),
    meta(input.transaction, AccountRole.READONLY),
    meta(input.member, AccountRole.READONLY_SIGNER),
    ...remaining,
  ]);
}
