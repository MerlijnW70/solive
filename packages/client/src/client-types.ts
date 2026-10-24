import type { Address, Instruction, MessagePartialSigner, Signature, TransactionSigner } from "@solana/kit";
import type { CommitteeTerms, CommitteeVote, Config, EngineEvent, Intent, IntentParams, ProfileView } from "@intent-engine/core";
import type { Priority } from "./budget.js";
import type { ClaimsView } from "./client-claims.js";
import type { FeedbackInput, Reputation, ReputationOptions } from "./reputation.js";
import type { EngineError } from "./errors.js";
import type { AnnounceInput, Announced, AnnouncementPlan } from "./announce.js";
import type { AnnouncementList, AnnouncementView } from "./announcement-reads.js";
import type { ReclaimInput, Reclaimed, RefuteInput, Refuted } from "./announcement-sends.js";
import type { SettleSplitInput, SplitBallot, SplitBallotInput } from "./client-split.js";
import type { FirstOpening, FirstOpeningInput } from "./first-opening.js";
import type { Job, Spec } from "./jobs.js";
import type { CheckedFetch } from "./pinned-fetch.js";
import type { Notifications, Simulation, Transport } from "./transport.js";

export type ClientOptions = {
  url: string;
  transport?: Transport;
  notifications?: Notifications;
  priority?: Priority;
  pollMs?: number;
  resyncSeconds?: number;
  fetch?: CheckedFetch;
};

export type IntentAccount = { address: Address; intent: Intent };

export type IntentFilter = { owner?: Address; status?: number };

export type WatchCallback = (changed: (IntentAccount & { slot?: bigint })[], closed: (IntentAccount & { slot?: bigint })[]) => void;

export type WatchOptions = { owner?: Address; onError?: (error: unknown) => void };

export type Mint = { decimals: number; tokenProgram: Address };

export type CreateIntentInput = {
  signer: TransactionSigner;
  params: IntentParams;
  inputMint: Address;
  outputMint: Address;
  expiresIn?: bigint;
  expiresAt?: bigint;
  nonce?: bigint;
  receiver?: Address;
  specUrl?: string;
};

export type CreatedIntent = { signature: Signature; intent: Address; nonce: bigint };

export type MessageSigner = TransactionSigner & MessagePartialSigner;

export type ReleaseOpening = { sha256: string; salt: string };

export type SettleProofInput = {
  judge: MessageSigner;
  owner: Address;
  nonce: bigint;
  announcement: Address;
  opening: ReleaseOpening;
  result: bigint;
  payer?: TransactionSigner;
};

export type CommitteeView = CommitteeTerms & { address: Address; id: Uint8Array; createdAt: bigint };

export type CreateCommitteeInput = CommitteeTerms & { payer: TransactionSigner };

export type CreatedCommittee = { committee: Address; signature: Signature | null };

export type BallotInput = {
  owner: Address;
  nonce: bigint;
  announcement: Address;
  opening: ReleaseOpening;
  result: bigint;
};

export type CommitteeBallot = {
  intent: Address;
  committee: CommitteeView;
  payee: Address;
  digest: Uint8Array;
};

export type ProofBallot = {
  intent: Address;
  attestor: Address;
  payee: Address;
  digest: Uint8Array;
  message: Uint8Array;
};

export type SettleCommitteeInput = BallotInput & {
  solver: TransactionSigner;
  votes: readonly CommitteeVote[];
  payer?: TransactionSigner;
};

export type CommitteeRelease = {
  intent: Address;
  committee: CommitteeView;
  payee: Address;
  signers: Address[];
  payer: TransactionSigner;
  setup: Instruction[];
  instructions: Instruction[];
};

export type HistoryEvent = EngineEvent & { signature: Signature; slot: bigint; blockTime: bigint | null; deliveredSha256?: string; deliveredSalt?: string };

export type FillInput = {
  solver: TransactionSigner;
  owner: Address;
  nonce: bigint;
  amountIn?: bigint;
  amountOut?: bigint;
  route?: readonly Instruction[];
};

export type Fill = {
  steps: 1 | 2;
  solver: Address;
  delivered: bigint;
  required: bigint;
  fee: bigint;
  net: bigint;
  signature: Signature;
  slot: bigint;
  blockTime: bigint | null;
};

export type TokenBalance = { mint: Address; name: string | undefined; account: Address; amount: bigint; decimals: number };

export type Balances = { sol: bigint; tokens: TokenBalance[] };

export type Client = {
  readonly url: string;
  readonly transport: Transport;
  config(): Promise<Config>;
  intent(owner: Address, nonce: bigint): Promise<IntentAccount | null>;
  intents(filter?: IntentFilter): Promise<IntentAccount[]>;
  history(intent: Address, limit?: number): Promise<HistoryEvent[]>;
  nextNonce(owner: Address): Promise<bigint>;
  simulate(instructions: readonly Instruction[], signer: TransactionSigner): Promise<Simulation>;
  send(instructions: readonly Instruction[], signer: TransactionSigner): Promise<Signature>;
  watch(onChange: WatchCallback, signal: AbortSignal, filter?: WatchOptions): Promise<void>;
  explain(error: unknown): EngineError | null;
  mint(address: Address): Promise<Mint>;
  chainTime(): Promise<bigint>;
  createIntent(input: CreateIntentInput): Promise<CreatedIntent>;
  cancel(signer: TransactionSigner, nonce: bigint): Promise<Signature>;
  unwrap(signer: TransactionSigner): Promise<Signature | null>;
  settleProof(input: SettleProofInput): Promise<Signature>;
  proofBallot(input: BallotInput): Promise<ProofBallot>;
  committee(address: Address): Promise<CommitteeView | null>;
  createCommittee(input: CreateCommitteeInput): Promise<CreatedCommittee>;
  committeeBallot(input: BallotInput): Promise<CommitteeBallot>;
  prepareCommitteeRelease(input: SettleCommitteeInput): Promise<CommitteeRelease>;
  settleCommittee(input: SettleCommitteeInput): Promise<Signature>;
  claims(owner: Address, nonce: bigint): Promise<ClaimsView | null>;
  profile(wallet: Address): Promise<ProfileView | null>;
  reputation(wallet: Address, options?: ReputationOptions): Promise<Reputation>;
  feedback(input: FeedbackInput): Promise<Signature>;
  fill(input: FillInput): Promise<Signature>;
  fillOf(intent: Address): Promise<Fill | null>;
  expire(cranker: TransactionSigner, owner: Address, nonce: bigint): Promise<Signature>;
  close(cranker: TransactionSigner, owner: Address, nonce: bigint): Promise<Signature>;
  balances(owner: Address, mints: readonly Address[]): Promise<Balances>;
  jobs(filter?: { attestor?: Address; mint?: Address; minSells?: bigint }): Promise<Job[]>;
  spec(intent: Address, keypair?: Uint8Array): Promise<Spec | null>;
  announce(input: AnnounceInput): Promise<Announced>;
  prepareAnnouncement(input: AnnounceInput): Promise<AnnouncementPlan>;
  announcements(intent: Address): Promise<AnnouncementList>;
  announcementsTo(attestor: Address): Promise<AnnouncementView[]>;
  announcementsBy(worker: Address): Promise<AnnouncementView[]>;
  firstOpening(input: FirstOpeningInput): Promise<FirstOpening>;
  splitBallot(input: SplitBallotInput): Promise<SplitBallot>;
  settleSplit(input: SettleSplitInput): Promise<Signature>;
  refute(input: RefuteInput): Promise<Refuted>;
  reclaim(input: ReclaimInput): Promise<Reclaimed>;
  closeBook(intent: Address, by: TransactionSigner): Promise<Signature>;
};

export const SPEC_URL_NEEDS_PROOF = "specUrl needs an AttestedResult intent with a non-zero specHash";

export const DEFAULT_EXPIRES_IN = 3_600n;
export const MIN_EXPIRES_IN = 60n;
export const MAX_EXPIRES_IN = 31_536_000n;
export const EXPIRES_IN_RANGE = `expiresIn must be from ${MIN_EXPIRES_IN} to ${MAX_EXPIRES_IN} seconds`;
export const HISTORY_LIMIT = 100;

export const WATCH_POLL_MS = 2_000;
export const WATCH_WAIT_SECONDS = 10;

export type ClientContext = {
  transport: Transport;
  send(instructions: readonly Instruction[], signer: TransactionSigner): Promise<Signature>;
  mint(address: Address): Promise<Mint>;
  config(): Promise<Config>;
};
