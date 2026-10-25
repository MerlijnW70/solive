import { type Address, createSolanaRpc, type Instruction, type Signature, type TransactionSigner } from "@solana/kit";
import { isSdkError } from "@intent-engine/core";
import { readIntentAccounts } from "@intent-engine/core/internal";
import { chainTime, loadConfig, loadUser, mintOf } from "./accounts.js";
import { budgeted, simulated } from "./budget.js";
import { nonceAfter } from "./client-create.js";
import { clientPlans, planWrites } from "./client-plans.js";
import { clientReads } from "./client-reads.js";
import { loadCommittee } from "./client-committee.js";
import { loadClaims, loadProfile } from "./client-claims.js";
import { reputationOf } from "./reputation.js";
export { type CommitteeCreatePlan, type EscrowCommittee, escrowCommittee, loadCommittee } from "./client-committee.js";
export { type CancelClaims, cancelClaims, type ClaimListView, type ClaimsView, releaseClaims, type ReleaseClaims, type JobClaim, jobClaimOf, type LineEntry, lineHandover, loadClaims, loadClaimsOf, loadLine, loadProfile } from "./client-claims.js";
import { committeeSettlement, proofBallotOf } from "./client-settle.js";
import { TransportLacks } from "./client-errors.js";
export { committeeJudged } from "./client-settle.js";
import { type Client, type ClientOptions, type Mint, WATCH_POLL_MS, WATCH_WAIT_SECONDS } from "./client-types.js";
import { watchIntents } from "./client-watch.js";
import { explain } from "./errors.js";
import { jobsOf, readSpec, webFetch } from "./job-specs.js";
import { announcing } from "./announce.js";
import { announcementsBy, announcementsOf, announcementsTo } from "./announcement-reads.js";
import { splitSettlement } from "./client-split.js";
import { intentMatchesQuery } from "./intent-filters.js";
import { intentAddress, loadIntentRef } from "./intent-ref.js";
import { amountShown, amountText } from "./simple-tokens.js";
import { firstOpening, openings } from "./first-opening.js";
import { heldSharesOf } from "./held-shares.js";
import { observerOf } from "./observe.js";
import { observedFetch, observedTransport } from "./observe-transport.js";
import { intentNotifications, type RpcLike, rpcTransport, signatureWatch } from "./transport.js";

export type {
  Balances,
  BallotInput,
  Client,
  ClientOptions,
  ClientPlans,
  CommitteeBallot,
  CommitteePlan,
  CommitteeView,
  CreateCommitteeInput,
  CreatedCommittee,
  CreatedIntent,
  CreateIntentInput,
  Fill,
  FillInput,
  HistoryEvent,
  HistoryOptions,
  HistoryPage,
  IntentAccount,
  IntentFilter,
  IntentList,
  IntentPlacement,
  MessageSigner,
  Mint,
  ParamsWithSpec,
  ProofBallot,
  ReleaseOpening,
  SettleCommitteeInput,
  SettleProofInput,
  TokenBalance,
  WatchCallback,
  WatchOptions,
} from "./client-types.js";
export {
  DEFAULT_EXPIRES_IN,
  EXPIRES_IN_RANGE,
  HISTORY_LIMIT,
  HISTORY_LIMIT_MAX,
  MAX_EXPIRES_IN,
  MIN_EXPIRES_IN,
  SPEC_URL_NEEDS_PROOF,
  WATCH_POLL_MS,
  WATCH_WAIT_SECONDS,
} from "./client-types.js";
export {
  ClaimHeldBy,
  CommitteeNeeded,
  CosignRejected,
  EscrowExpired,
  IntentUnreadable,
  NoFreeNonce,
  NoHeldShare,
  type NoHeldShareReason,
  NotFillable,
  type NotFillableReason,
  NotSettleable,
  type NotSettleableReason,
  PayeeMoved,
  PayToNotWallet,
  PreviewRefused,
  StaleRead,
  TransportLacks,
  VoteRejected,
} from "./client-errors.js";

export function createClient(options: ClientOptions): Client {
  const { url, priority = 0n, pollMs = WATCH_POLL_MS, resyncSeconds = WATCH_WAIT_SECONDS } = options;
  const observer = observerOf(options.hooks, options.debug);
  const transport =
    options.transport === undefined
      ? rpcTransport(createSolanaRpc(url) as unknown as RpcLike, undefined, signatureWatch(url), observer)
      : observedTransport(options.transport, observer);
  const specFetch = observedFetch(options.fetch ?? webFetch, observer);
  const lookup = options.lookup ?? null;
  const notifications = options.notifications ?? (options.transport === undefined ? intentNotifications(url) : undefined);

  const watch = watchIntents(transport, notifications, pollMs, resyncSeconds);

  const config = async () => (await loadConfig(transport)).config;
  const send = async (instructions: readonly Instruction[], signer: TransactionSigner) =>
    (await transport.send(await budgeted(transport, priority, instructions, signer.address), signer)) as Signature;

  const mints = new Map<Address, Promise<Mint>>();
  const mint = (address: Address) => {
    const known = mints.get(address);
    if (known !== undefined) {
      return known;
    }
    const loading = mintOf(transport, address).then(({ decimals, tokenProgram }) => ({ decimals, tokenProgram }));
    mints.set(address, loading);
    loading.catch(() => mints.delete(address));
    return loading;
  };

  const context = { transport, send, mint, config };
  const plan = clientPlans(context);
  const { history, fillOf, balances } = clientReads(context);
  const proofBallot = proofBallotOf(context);
  const { committeeBallot } = committeeSettlement(context);
  const { splitBallot } = splitSettlement(context);

  return {
    url,
    transport,
    plan,
    config,
    intent: async (ref) => {
      try {
        return await loadIntentRef(transport, ref);
      } catch (error) {
        if (isSdkError(error, "missing-account")) {
          return null;
        }
        throw error;
      }
    },
    intents: async (filter = {}) => {
      const { intents, unreadable } = readIntentAccounts(await transport.intents(filter));
      return { intents: intents.filter(({ intent }) => intentMatchesQuery(intent, filter)), unreadable };
    },
    history,
    nextNonce: async (owner) => nonceAfter(owner, await loadUser(transport, owner)),
    simulate: async (instructions, signer) =>
      simulated(transport, await budgeted(transport, priority, instructions, signer.address), signer.address),
    send,
    status: async (signature, lastValidBlockHeight) => {
      if (transport.sendStatus === undefined) {
        throw new TransportLacks("sendStatus");
      }
      return transport.sendStatus(signature, lastValidBlockHeight);
    },
    watch,
    explain,
    mint,
    amount: async (address, text) => amountText(text, (await mint(address)).decimals),
    format: async (address, amount) => amountShown(amount, (await mint(address)).decimals),
    chainTime: () => chainTime(transport),
    proofBallot,
    committee: (address) => loadCommittee(transport, address),
    committeeBallot,
    claims: async (ref) => loadClaims(transport, await intentAddress(ref)),
    profile: (wallet) => loadProfile(transport, wallet),
    reputation: (wallet, options) => reputationOf(transport, wallet, options),
    fillOf,
    balances,
    jobs: (filter = {}) => jobsOf(transport, filter),
    spec: async (ref, keypair) => readSpec(transport, specFetch, await intentAddress(ref), keypair, lookup, url),
    announce: announcing(context),
    announcements: async (ref) => announcementsOf(transport, await intentAddress(ref)),
    announcementsTo: (attestor) => announcementsTo(transport, attestor),
    announcementsBy: (worker) => announcementsBy(transport, worker),
    firstOpening: (input) => firstOpening(transport, input),
    openings: (input) => openings(transport, input),
    splitBallot,
    heldShares: (wallet, options) => heldSharesOf(transport, wallet, options),
    ...planWrites(send, plan),
  };
}
