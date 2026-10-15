import { type Address, createSolanaRpc, type Instruction, type Signature, type TransactionSigner } from "@solana/kit";
import { chainTime, loadConfig, loadIntent, loadUser, MissingAccount, mintOf } from "./accounts.js";
import { budgeted, simulated } from "./budget.js";
import { intentSends, nonceAfter } from "./client-intents.js";
import { clientReads } from "./client-reads.js";
import { committeeSends } from "./client-committee.js";
import { loadClaims, loadProfile } from "./client-claims.js";
import { feedbackInstructions, reputationOf } from "./reputation.js";
export { loadCommittee } from "./client-committee.js";
export { type ClaimsView, loadClaims, loadProfile } from "./client-claims.js";
import { committeeSettlement, proofSettlement } from "./client-settle.js";
import { type Client, type ClientOptions, type Mint, WATCH_POLL_MS, WATCH_WAIT_SECONDS } from "./client-types.js";
import { decoded, watchIntents } from "./client-watch.js";
import { explain } from "./errors.js";
import { deliveriesOf, deliveryInstructions, deliveryRecord, jobsOf, readSpec } from "./jobs.js";
import { intentNotifications, type RpcLike, rpcTransport, signatureWatch } from "./transport.js";

export type {
  Balances,
  BallotInput,
  Client,
  ClientOptions,
  CommitteeBallot,
  CommitteeRelease,
  CommitteeView,
  CreateCommitteeInput,
  CreatedCommittee,
  CreatedIntent,
  CreateIntentInput,
  Fill,
  FillInput,
  HistoryEvent,
  IntentAccount,
  IntentFilter,
  Mint,
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
  MAX_EXPIRES_IN,
  MIN_EXPIRES_IN,
  SPEC_URL_NEEDS_PROOF,
  WATCH_POLL_MS,
  WATCH_WAIT_SECONDS,
} from "./client-types.js";
export {
  EscrowExpired,
  NoFreeNonce,
  NotFillable,
  NotSettleable,
  PayeeMoved,
  PayToNotWallet,
  VoteRejected,
} from "./client-errors.js";

export function createClient(options: ClientOptions): Client {
  const { url, priority = 0n, pollMs = WATCH_POLL_MS, resyncSeconds = WATCH_WAIT_SECONDS } = options;
  const transport =
    options.transport ?? rpcTransport(createSolanaRpc(url) as unknown as RpcLike, undefined, signatureWatch(url));
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
  const { createIntent, cancel, unwrap, fill, expire, close } = intentSends(context);
  const { history, fillOf, balances } = clientReads(context);
  const settleProof = proofSettlement(context);
  const { committeeBallot, prepareCommitteeRelease, settleCommittee } = committeeSettlement(context);
  const { committee, createCommittee } = committeeSends(context);

  return {
    url,
    transport,
    config,
    intent: async (owner, nonce) => {
      try {
        return await loadIntent(transport, owner, nonce);
      } catch (error) {
        if (error instanceof MissingAccount) {
          return null;
        }
        throw error;
      }
    },
    intents: async (filter = {}) =>
      (await transport.intents(filter.owner))
        .map(decoded)
        .filter(({ intent }) => filter.status === undefined || intent.status === filter.status),
    history,
    nextNonce: async (owner) => nonceAfter(owner, await loadUser(transport, owner)),
    simulate: async (instructions, signer) =>
      simulated(transport, await budgeted(transport, priority, instructions, signer.address), signer.address),
    send,
    watch,
    explain,
    mint,
    chainTime: () => chainTime(transport),
    createIntent,
    cancel,
    unwrap,
    settleProof,
    committee,
    createCommittee,
    committeeBallot,
    prepareCommitteeRelease,
    settleCommittee,
    claims: (owner, nonce) => loadClaims(transport, owner, nonce),
    profile: (wallet) => loadProfile(transport, wallet),
    reputation: (wallet, options) => reputationOf(transport, wallet, options),
    feedback: async (input) => send(await feedbackInstructions(transport, input), input.owner),
    fill,
    fillOf,
    expire,
    close,
    balances,
    jobs: (filter = {}) => jobsOf(transport, filter.attestor),
    spec: (intent) => readSpec(transport, options.fetch ?? fetch, intent),
    deliver: async (input) => send((await deliveryInstructions(transport, input)).instructions, input.worker),
    deliveries: ({ judge, intent }) => deliveriesOf(transport, judge, intent),
    deliveryRecord: ({ judge, intent, pages }) => deliveryRecord(transport, judge, intent, pages),
  };
}
