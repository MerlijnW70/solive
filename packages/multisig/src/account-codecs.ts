import {
  addCodecSizePrefix,
  type Address,
  type Codec,
  fixCodecSize,
  getAddressCodec,
  getArrayCodec,
  getBytesCodec,
  getDiscriminatedUnionCodec,
  getI64Codec,
  getNullableCodec,
  getStructCodec,
  getU16Codec,
  getU32Codec,
  getU64Codec,
  getU8Codec,
  type ReadonlyUint8Array,
} from "@solana/kit";

const key = getAddressCodec();
const bytes = addCodecSizePrefix(getBytesCodec(), getU32Codec());
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

export type Period = { __kind: "OneTime" | "Day" | "Week" | "Month" };

export type ConfigAction =
  | { __kind: "AddMember"; newMember: Member }
  | { __kind: "RemoveMember"; oldMember: Address }
  | { __kind: "ChangeThreshold"; newThreshold: number }
  | { __kind: "SetTimeLock"; newTimeLock: number }
  | {
      __kind: "AddSpendingLimit";
      createKey: Address;
      vaultIndex: number;
      mint: Address;
      amount: bigint;
      period: Period;
      members: Address[];
      destinations: Address[];
    }
  | { __kind: "RemoveSpendingLimit"; spendingLimit: Address }
  | { __kind: "SetRentCollector"; newRentCollector: Address | null };

export type ConfigTransaction = {
  multisig: Address;
  creator: Address;
  index: bigint;
  bump: number;
  actions: ConfigAction[];
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

export const memberCodec: Codec<Member> = getStructCodec([
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

const periodCodec: Codec<Period> = getDiscriminatedUnionCodec([
  ["OneTime", getStructCodec([])],
  ["Day", getStructCodec([])],
  ["Week", getStructCodec([])],
  ["Month", getStructCodec([])],
]);

export const configActionCodec: Codec<ConfigAction> = getDiscriminatedUnionCodec([
  ["AddMember", getStructCodec([["newMember", memberCodec]])],
  ["RemoveMember", getStructCodec([["oldMember", key]])],
  ["ChangeThreshold", getStructCodec([["newThreshold", getU16Codec()]])],
  ["SetTimeLock", getStructCodec([["newTimeLock", getU32Codec()]])],
  [
    "AddSpendingLimit",
    getStructCodec([
      ["createKey", key],
      ["vaultIndex", getU8Codec()],
      ["mint", key],
      ["amount", getU64Codec()],
      ["period", periodCodec],
      ["members", getArrayCodec(key)],
      ["destinations", getArrayCodec(key)],
    ]),
  ],
  ["RemoveSpendingLimit", getStructCodec([["spendingLimit", key]])],
  ["SetRentCollector", getStructCodec([["newRentCollector", getNullableCodec(key)]])],
]);

export const configTransactionCodec: Codec<ConfigTransaction> = getStructCodec([
  ["multisig", key],
  ["creator", key],
  ["index", getU64Codec()],
  ["bump", getU8Codec()],
  ["actions", getArrayCodec(configActionCodec)],
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
