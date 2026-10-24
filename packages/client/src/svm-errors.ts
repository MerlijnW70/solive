import type { FailedTransactionMetadata } from "litesvm";

export const TRANSACTION_ERRORS = [
  "AccountInUse",
  "AccountLoadedTwice",
  "AccountNotFound",
  "ProgramAccountNotFound",
  "InsufficientFundsForFee",
  "InvalidAccountForFee",
  "AlreadyProcessed",
  "BlockhashNotFound",
  "CallChainTooDeep",
  "MissingSignatureForFee",
  "InvalidAccountIndex",
  "SignatureFailure",
  "InvalidProgramForExecution",
  "SanitizeFailure",
  "ClusterMaintenance",
  "AccountBorrowOutstanding",
  "WouldExceedMaxBlockCostLimit",
  "UnsupportedVersion",
  "InvalidWritableAccount",
  "WouldExceedMaxAccountCostLimit",
  "WouldExceedAccountDataBlockLimit",
  "TooManyAccountLocks",
  "AddressLookupTableNotFound",
  "InvalidAddressLookupTableOwner",
  "InvalidAddressLookupTableData",
  "InvalidAddressLookupTableIndex",
  "InvalidRentPayingAccount",
  "WouldExceedMaxVoteCostLimit",
  "WouldExceedAccountDataTotalLimit",
  "MaxLoadedAccountsDataSizeExceeded",
  "ResanitizationNeeded",
  "InvalidLoadedAccountsDataSizeLimit",
  "UnbalancedTransaction",
  "ProgramCacheHitMaxLimit",
  "CommitCancelled",
] as const;

export type TransactionErrorName = (typeof TRANSACTION_ERRORS)[number];

export const ALREADY_PROCESSED: TransactionErrorName = "AlreadyProcessed";
export const BLOCKHASH_NOT_FOUND: TransactionErrorName = "BlockhashNotFound";

export function fieldlessOf(failed: FailedTransactionMetadata): TransactionErrorName | null {
  const err: unknown = failed.err();
  return typeof err === "number" ? (TRANSACTION_ERRORS[err] ?? null) : null;
}

export function errOf(failed: FailedTransactionMetadata): unknown {
  const fieldless = fieldlessOf(failed);
  if (fieldless !== null) {
    return fieldless;
  }
  const err: unknown = failed.err();
  const { index, err: detailOf } = err as { index?: unknown; err?: unknown };
  if (typeof index !== "number" || typeof detailOf !== "function") {
    return String(err);
  }
  const detail: unknown = (detailOf as () => unknown).call(err);
  const code = (detail as { code?: unknown }).code;
  return { InstructionError: [index, typeof code === "number" ? { Custom: code } : String(detail)] };
}
