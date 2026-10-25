import type { Address, Instruction, MessagePartialSigner, Signature, TransactionSigner } from "@solana/kit";
import type { AttestedResultParams, CommitteeTerms, CommitteeVote, Config, EngineEvent, Intent, IntentParams, ProfileView } from "@intent-engine/core";
import type { Priority } from "./budget.js";
import type { ClaimsView } from "./client-claims.js";
import type { FeedbackInput, Reputation, ReputationOptions } from "./reputation.js";
import type { EngineError } from "./errors.js";
import type { AnnounceInput, Announced, AnnouncementPlan } from "./announce.js";
import type { AnnouncementList, AnnouncementView } from "./announcement-reads.js";
import type { ReclaimInput, ReclaimPlan, Reclaimed, RefuteInput, RefutePlan, Refuted } from "./announcement-sends.js";
import type { CreateIntentPlan } from "./client-create.js";
import type { CommitteeCreatePlan } from "./client-committee.js";
import type { IntentRef } from "./intent-ref.js";
import type { Plan } from "./plan.js";
import type { SettleSplitInput, SplitBallot, SplitBallotInput } from "./client-split.js";
import type { FirstOpening, FirstOpeningInput, Openings, OpeningsInput } from "./first-opening.js";
import type { Job, JobFilter, Spec, SpecFetch } from "./jobs.js";
import type { Lookup } from "./address-ranges.js";
import type { ClientHooks, DebugLog } from "./observe.js";
import type { SendStatus } from "./send-errors.js";
import type { IntentQuery, Notifications, Simulation, Transport } from "./transport.js";

export type ClientOptions = {
  url: string;
  transport?: Transport;
  notifications?: Notifications;
  priority?: Priority;
  pollMs?: number;
  resyncSeconds?: number;
  fetch?: SpecFetch;
  lookup?: Lookup;
  hooks?: ClientHooks;
  debug?: DebugLog;
};

export type IntentAccount = { address: Address; intent: Intent };

export type IntentFilter = IntentQuery;

export type WatchCallback = (changed: (IntentAccount & { slot?: bigint })[], closed: (IntentAccount & { slot?: bigint })[]) => void;

export type WatchOptions = { owner?: Address; onError?: (error: unknown) => void };

export type Mint = { decimals: number; tokenProgram: Address };

export type IntentPlacement = {
  signer: TransactionSigner;
  inputMint: Address;
  outputMint: Address;
  expiresIn?: bigint;
  expiresAt?: bigint;
  nonce?: bigint;
  payTo?: Address;
  partner?: Address;
  partnerBps?: number;
};

export type ParamsWithSpec = { params: AttestedResultParams; specUrl: string } | { params: IntentParams; specUrl?: undefined };

export type CreateIntentInput = IntentPlacement & ParamsWithSpec;

export type CreatedIntent = { signature: Signature; intent: Address; nonce: bigint };

export type MessageSigner = TransactionSigner & MessagePartialSigner;

export type ReleaseOpening = { sha256: string; salt: string };

export type SettleProofInput = {
  judge: MessageSigner;
  intent: IntentRef;
  announcement: Address;
  opening: ReleaseOpening;
  result: bigint;
  payer?: TransactionSigner;
};

export type CommitteeView = CommitteeTerms & { address: Address; id: Uint8Array; createdAt: bigint };

export type CreateCommitteeInput = CommitteeTerms & { payer: TransactionSigner };

export type CreatedCommittee = { committee: Address; signature: Signature | null };

export type BallotInput = {
  intent: IntentRef;
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

export type CommitteePlan = Plan & {
  intent: Address;
  committee: CommitteeView;
  payee: Address;
  voters: Address[];
};

export type HistoryEvent = EngineEvent & { signature: Signature; slot: bigint; blockTime: bigint | null; deliveredSha256?: string; deliveredSalt?: string };

export type HistoryOptions = { limit?: number; before?: string };

export type HistoryPage = { events: HistoryEvent[]; next: string | null };

export type FillInput = {
  solver: TransactionSigner;
  intent: IntentRef;
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

export type ClientPlans = {
  createIntent(input: CreateIntentInput): Promise<CreateIntentPlan>;
  cancel(signer: TransactionSigner, intent: IntentRef): Promise<Plan>;
  fill(input: FillInput): Promise<Plan>;
  expire(cranker: TransactionSigner, intent: IntentRef): Promise<Plan>;
  close(cranker: TransactionSigner, intent: IntentRef): Promise<Plan>;
  settleProof(input: SettleProofInput): Promise<Plan>;
  settleCommittee(input: SettleCommitteeInput): Promise<CommitteePlan>;
  settleSplit(input: SettleSplitInput): Promise<Plan>;
  announce(input: AnnounceInput): Promise<AnnouncementPlan>;
  refute(input: RefuteInput): Promise<RefutePlan>;
  reclaim(input: ReclaimInput): Promise<ReclaimPlan>;
  closeBook(intent: IntentRef, by: TransactionSigner): Promise<Plan>;
  feedback(input: FeedbackInput): Promise<Plan>;
  createCommittee(input: CreateCommitteeInput): Promise<CommitteeCreatePlan>;
  unwrap(signer: TransactionSigner): Promise<Plan>;
};

export type Client = {
  readonly url: string;
  readonly transport: Transport;
  readonly plan: ClientPlans;
  config(): Promise<Config>;
  intent(intent: IntentRef): Promise<IntentAccount | null>;
  intents(filter?: IntentFilter): Promise<IntentAccount[]>;
  history(intent: IntentRef, options?: HistoryOptions): Promise<HistoryPage>;
  nextNonce(owner: Address): Promise<bigint>;
  simulate(instructions: readonly Instruction[], signer: TransactionSigner): Promise<Simulation>;
  send(instructions: readonly Instruction[], signer: TransactionSigner): Promise<Signature>;
  status(signature: Signature, lastValidBlockHeight?: bigint): Promise<SendStatus>;
  watch(onChange: WatchCallback, signal: AbortSignal, filter?: WatchOptions): Promise<void>;
  explain(error: unknown): EngineError | null;
  mint(address: Address): Promise<Mint>;
  amount(mint: Address, text: string): Promise<bigint>;
  format(mint: Address, amount: bigint): Promise<string>;
  chainTime(): Promise<bigint>;
  createIntent(input: CreateIntentInput): Promise<CreatedIntent>;
  cancel(signer: TransactionSigner, intent: IntentRef): Promise<Signature>;
  unwrap(signer: TransactionSigner): Promise<Signature | null>;
  settleProof(input: SettleProofInput): Promise<Signature>;
  proofBallot(input: BallotInput): Promise<ProofBallot>;
  committee(address: Address): Promise<CommitteeView | null>;
  createCommittee(input: CreateCommitteeInput): Promise<CreatedCommittee>;
  committeeBallot(input: BallotInput): Promise<CommitteeBallot>;
  settleCommittee(input: SettleCommitteeInput): Promise<Signature>;
  claims(intent: IntentRef): Promise<ClaimsView | null>;
  profile(wallet: Address): Promise<ProfileView | null>;
  reputation(wallet: Address, options?: ReputationOptions): Promise<Reputation>;
  feedback(input: FeedbackInput): Promise<Signature>;
  fill(input: FillInput): Promise<Signature>;
  fillOf(intent: IntentRef): Promise<Fill | null>;
  expire(cranker: TransactionSigner, intent: IntentRef): Promise<Signature>;
  close(cranker: TransactionSigner, intent: IntentRef): Promise<Signature>;
  balances(owner: Address, mints: readonly Address[]): Promise<Balances>;
  jobs(filter?: JobFilter): Promise<Job[]>;
  spec(intent: IntentRef, keypair?: Uint8Array): Promise<Spec | null>;
  announce(input: AnnounceInput): Promise<Announced>;
  announcements(intent: IntentRef): Promise<AnnouncementList>;
  announcementsTo(attestor: Address): Promise<AnnouncementView[]>;
  announcementsBy(worker: Address): Promise<AnnouncementView[]>;
  firstOpening(input: FirstOpeningInput): Promise<FirstOpening>;
  openings(input: OpeningsInput): Promise<Openings>;
  splitBallot(input: SplitBallotInput): Promise<SplitBallot>;
  settleSplit(input: SettleSplitInput): Promise<Signature>;
  refute(input: RefuteInput): Promise<Refuted>;
  reclaim(input: ReclaimInput): Promise<Reclaimed>;
  closeBook(intent: IntentRef, by: TransactionSigner): Promise<Signature>;
};

export const SPEC_URL_NEEDS_PROOF = "specUrl needs an AttestedResult intent with a non-zero specHash";

export const DEFAULT_EXPIRES_IN = 3_600n;
export const MIN_EXPIRES_IN = 60n;
export const MAX_EXPIRES_IN = 31_536_000n;
export const EXPIRES_IN_RANGE = `expiresIn must be from ${MIN_EXPIRES_IN} to ${MAX_EXPIRES_IN} seconds`;
export const HISTORY_LIMIT = 100;
export const HISTORY_LIMIT_MAX = 1_000;

export const WATCH_POLL_MS = 2_000;
export const WATCH_WAIT_SECONDS = 10;

export type ClientContext = {
  transport: Transport;
  send(instructions: readonly Instruction[], signer: TransactionSigner): Promise<Signature>;
  mint(address: Address): Promise<Mint>;
  config(): Promise<Config>;
};
