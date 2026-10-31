import type {
  Address,
  Base64EncodedWireTransaction,
  Blockhash,
  Instruction,
  ReadonlyUint8Array,
  Signature,
  TransactionSigner,
} from "@solana/kit";
import type { SendStatus } from "./send-errors.js";

export type AccountView = { owner: Address; data: Uint8Array; lamports: bigint; executable?: boolean };

export type ProgramAccount = { address: Address; data: Uint8Array };

export type EngineAccount = ProgramAccount & { lamports: bigint };

export type AccountMatch = { offset: number; address: Address } | { offset: number; bytes: ReadonlyUint8Array };

export type IntentQuery = {
  owner?: Address | undefined;
  status?: number | undefined;
  kind?: number | undefined;
  inputMint?: Address | undefined;
  outputMint?: Address | undefined;
  attestor?: Address | undefined;
};

export type EngineAccountFilter = { discriminator: ReadonlyUint8Array; dataSize?: number; match?: readonly AccountMatch[] };

export type TokenHolding = { account: Address; mint: Address; owner?: Address };

export type SolTransfer = { from: Address; to: Address; lamports: bigint };

export type EngineTransaction = {
  signature: Signature;
  slot: bigint;
  blockTime: bigint | null;
  failed: boolean;
  emitted: Uint8Array[];
  emittedAccounts?: Address[][];
  memos?: string[];
  memoSigners?: Address[][];
  feePayer?: Address;
  called?: Uint8Array[];
  calledAccounts?: Address[][];
  tokens?: TokenHolding[];
  transfers?: SolTransfer[];
  unread?: true;
};

export type ListedSignature = { signature: Signature; slot: bigint; blockTime: bigint | null; failed: boolean; memo: string | null };

export type Latest = { blockhash: Blockhash; lastValidBlockHeight: bigint };

export type IntentRead = { minContextSlot?: bigint; onSlot?: (slot: bigint) => void };

export type LookupTables = Readonly<Record<Address, Address[]>>;

export type SignatureLanding = "landed" | "failed";

export type FinalizedBlock = { slot: bigint; blockhash: string };

export type Simulation = { err: string | null; logs: string[]; unitsConsumed: bigint | null; accounts: (Uint8Array | null)[] };

export interface Transport {
  readonly offline?: boolean;
  getAccount(address: Address): Promise<AccountView | null>;
  getAccounts(addresses: readonly Address[]): Promise<(AccountView | null)[]>;
  warm?(addresses: readonly Address[]): Promise<void>;
  send(instructions: readonly Instruction[], payer: TransactionSigner): Promise<Signature>;
  latestBlockhash(): Promise<Latest>;
  sendWire(wire: Base64EncodedWireTransaction, latest: Latest): Promise<Signature>;
  submitWire(wire: Base64EncodedWireTransaction): Promise<Signature>;
  simulate(wire: Base64EncodedWireTransaction, watch?: readonly Address[]): Promise<Simulation>;
  genesisHash(): Promise<string>;
  intents(query?: IntentQuery, read?: IntentRead): Promise<ProgramAccount[]>;
  engineAccounts?(filter?: EngineAccountFilter): Promise<EngineAccount[]>;
  engineTransactions(limit: number, of?: Address, memo?: string): Promise<EngineTransaction[]>;
  signaturesOf?(of: Address, limit: number, before?: string, until?: string): Promise<ListedSignature[]>;
  transactionsOf?(listed: readonly ListedSignature[]): Promise<EngineTransaction[]>;
  transactionOf?(signature: string): Promise<EngineTransaction | null>;
  signatureStatuses?(signatures: readonly string[]): Promise<(SignatureLanding | null)[]>;
  sendStatus?(signature: string, lastValidBlockHeight?: bigint): Promise<SendStatus>;
  firstAvailableSlot?(): Promise<bigint>;
  finalizedBlock?(from: bigint): Promise<FinalizedBlock | null>;
  recentFees(accounts: readonly Address[]): Promise<bigint[]>;
  budget(instructions: readonly Instruction[], feePayer: Address, tables?: LookupTables): Promise<Instruction[]>;
  airdrop(address: Address, lamports: bigint): Promise<Signature>;
}

export type Pending<T> = { send(): Promise<T> };

export type RawAccount = { owner: Address; data: readonly [string, string]; lamports: bigint; executable: boolean };

export type AtLeast = { minContextSlot?: bigint };

export type ProgramEntry = { pubkey: Address; account: { data: readonly [string, string]; lamports?: bigint } };

export type Status = { err: unknown; confirmationStatus: string | null; slot?: bigint };

export type RpcLike = {
  getMultipleAccounts(addresses: Address[], config: { encoding: "base64" } & AtLeast): Pending<{ value: (RawAccount | null)[] }>;
  getAccountInfo(
    address: Address,
    config: { encoding: "base64" } & AtLeast,
  ): Pending<{ value: { owner: Address; data: readonly [string, string]; lamports: bigint; executable: boolean } | null }>;
  getLatestBlockhash(): Pending<{ value: { blockhash: Blockhash; lastValidBlockHeight: bigint } }>;
  sendTransaction(
    wire: Base64EncodedWireTransaction,
    config: { encoding: "base64"; skipPreflight?: boolean },
  ): Pending<string>;
  simulateTransaction(
    wire: Base64EncodedWireTransaction,
    config: {
      encoding: "base64";
      sigVerify: false;
      replaceRecentBlockhash: true;
      accounts?: { addresses: Address[]; encoding: "base64" };
    },
  ): Pending<{
    value: {
      err: unknown;
      logs: readonly string[] | null;
      unitsConsumed?: bigint | undefined;
      accounts?: readonly ({ data: readonly [string, string] } | null)[] | null;
    };
  }>;
  getSignatureStatuses(
    signatures: Signature[],
    config?: { searchTransactionHistory: boolean },
  ): Pending<{ context: { slot: bigint }; value: readonly (Status | null)[] }>;
  getEpochInfo(): Pending<{ blockHeight: bigint; absoluteSlot: bigint }>;
  getFirstAvailableBlock?(): Pending<bigint>;
  getBlocksWithLimit?(start: bigint, limit: number, config: { commitment: "finalized" }): Pending<readonly bigint[]>;
  getBlock?(
    slot: bigint,
    config: { commitment: "finalized"; encoding: "json"; transactionDetails: "none"; rewards: false; maxSupportedTransactionVersion: 0 },
  ): Pending<{ blockhash: string } | null>;
  requestAirdrop(address: Address, lamports: bigint): Pending<string>;
  getRecentPrioritizationFees(addresses: readonly Address[]): Pending<readonly { prioritizationFee: bigint }[]>;
  getGenesisHash(): Pending<string>;
  getProgramAccounts(
    program: Address,
    config: {
      encoding: "base64";
      commitment: "confirmed";
      filters: readonly (
        | { dataSize: bigint }
        | { memcmp: { offset: bigint; bytes: string; encoding: "base58" } }
      )[];
      withContext?: true;
    } & AtLeast,
  ): Pending<readonly ProgramEntry[] | { context: { slot: bigint }; value: readonly ProgramEntry[] }>;
  getSignaturesForAddress(
    address: Address,
    config: { limit: number; before?: Signature; until?: Signature } & AtLeast,
  ): Pending<readonly { signature: string; slot: bigint; blockTime: bigint | null; err: unknown; memo?: string | null }[]>;
  getTransaction(
    signature: Signature,
    config: { encoding: "json"; maxSupportedTransactionVersion: 0; commitment: "confirmed" },
  ): Pending<{
    slot?: bigint;
    blockTime?: bigint | null;
    transaction: {
      signatures: readonly string[];
      message: {
        accountKeys: readonly Address[];
        header?: { numRequiredSignatures: number };
        instructions?: readonly { programIdIndex: number; accounts?: readonly number[]; data: string }[];
      };
    };
    meta: {
      err?: unknown;
      logMessages?: readonly string[] | null;
      loadedAddresses?: { writable: readonly Address[]; readonly: readonly Address[] };
      innerInstructions?: readonly { instructions: readonly { programIdIndex: number; accounts?: readonly number[]; data: string }[] }[] | null;
      preBalances?: readonly (bigint | number)[];
      postBalances?: readonly (bigint | number)[];
      preTokenBalances?: readonly TokenBalance[] | null;
      postTokenBalances?: readonly TokenBalance[] | null;
    } | null;
  } | null>;
};

export type TokenBalance = { accountIndex: number; mint: string; owner?: string };
