import { tool } from "./names.js";
import type { Address } from "@solana/kit";
import {
  BPS_DENOMINATOR,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  IntentCoreError,
  MAX_PARTNER_BPS,
  TOKEN_2022_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
} from "@intent-engine/core";
import { MissingAccount, NotAMint, NotDeliverable, rateLimited } from "@intent-engine/client";
import { InvalidInput, type Issue } from "./schema.js";
import { redactUrl } from "../render.js";

export type Problem = {
  code: string;
  retryable: boolean;
  hint: string;
  programError?: number;
  program?: Address;
  issues?: Issue[];
  logs?: string[];
};

type Entry = { retryable: boolean; hint: string };

const never = (hint: string): Entry => ({ retryable: false, hint });
const later = (hint: string): Entry => ({ retryable: true, hint });

export const ENGINE_PROBLEMS = {
  Overflow: never("an amount is too large for the arithmetic; use smaller amounts"),
  DivideByZero: never("the arithmetic divided by zero; validated order terms never reach this, so rebuild the transaction with this server"),
  Truncated: never("the instruction data was cut short; rebuild the transaction with this server"),
  NonCanonical: never("the instruction data was not encoded canonically; rebuild the transaction with this server"),
  UnknownKind: never("the intent kind is not one the program knows; use swap, limit, dutch or attested"),
  UnknownStatus: never(`the intent holds a status this version does not know; read it again with ${tool("get_intent")}`),
  InvalidParams: never("the order terms are inconsistent; check amounts are non-zero and the auction times are ordered"),
  AmountMismatch: never("the amounts do not match what the intent escrows; read the intent again and use its remaining amount"),
  InsufficientOutput: later(`the fill pays less than the intent requires right now; quote again with ${tool("quote")}`),
  InvalidTransition: never(`the intent is not in a state that allows this; read it with ${tool("get_intent")}`),
  IntentExpired: never(`the intent has expired and can no longer be filled; its owner can still cancel it, and anyone can expire and close it (${tool("prepare_crank")})`),
  NotExpired: later("the intent has not expired yet; wait until its expiry time and try again"),
  NonceUsed: never("this nonce is already used; omit the nonce so the next free one is chosen"),
  NonceOutOfWindow: never("this nonce is outside the owner's 256-nonce window or inside the agent nonce lanes; omit the nonce so the next free one is chosen"),
  NonceRegression: never("the nonce base can only move forward"),
  Unauthorized: never("a signer or a named account does not match the one recorded on-chain (owner, rent payer, mandate agent, admin, guardian or upgrade authority); let this server pick the accounts and sign with the recorded key"),
  CreatePaused: later(`creating intents is paused by the guardian or admin; check paused.create in ${tool("get_config")} and try again later`),
  KindDisabled: never(`this intent kind is not enabled; see kinds[].enabled in ${tool("get_config")}`),
  UnknownKindBits: never("the kind mask names kinds the program does not know"),
  InvalidPauseFlags: never("the pause flags are empty or name pauses the program does not know; use create, fill or all"),
  FeeTooHigh: never("the configured fee exceeds the program's maximum"),
  NotPendingAdmin: never("only the proposed admin can accept the admin role"),
  ExpiryNotInFuture: never("the expiry must be later than the current chain time; use a later expiry"),
  SameMint: never("the input and output mints must differ"),
  MintNotAllowed: never("this mint cannot be used: it has a token extension the program refuses"),
  RefundNotCanonical: never("refunds go only to the owner's canonical token account; let this server pick accounts"),
  ReceiverNotAllowed: never("the receiver account is not owned by the named receiver authority, the authority is an engine account, or (for a mandate) the receiver is not an account the owner controls"),
  AuctionOutlivesExpiry: never("the dutch auction must end at or before the intent expires"),
  FillPaused: later(`fills are paused by the guardian or admin; check paused.fill in ${tool("get_config")} and try again later`),
  FeeAccountNotCanonical: never("a fee must go to its payee's canonical token account (the treasury's, the agent's or the judge's); let this server pick it"),
  FeeAccountMissing: never("a fee account was not passed: the treasury's, agent's or judge's at fill, or the relayer's at a signed create; create that token account and pass it"),
  SolverOutputNotAllowed: never("the solver's output account is not acceptable for this fill"),
  SigProgram: never("the signature instruction must come from the Ed25519 program"),
  SigHeader: never("the Ed25519 instruction is malformed; rebuild it with this server"),
  SigPubkey: never("the signature was made by a different key than the owner"),
  SigMessage: never(`the signed message does not match this intent; sign the exact message from ${tool("prepare_signed_intent")}`),
  KindMismatch: never("the instruction does not match the intent's kind"),
  ResultOutOfBounds: never("the attested result is outside the intent's bounds"),
  SigMissing: never("the Ed25519 signature instruction is missing; rebuild the transaction with this server"),
  InvalidDomain: never("the config domain must not be zero; init-config takes it from the RPC's genesis hash, so point --url at the cluster you set up"),
  SignatureExpired: never("the signed intent passed its submit-by time; ask the owner to sign a new one"),
  FlashCpi: never("a flash fill cannot be started from inside another program"),
  FlashEndProgram: never("the flash fill must end with this program's end_fill"),
  FlashEndDiscriminator: never("the flash fill's closing instruction is not end_fill"),
  FlashEndIntent: never("the flash fill ends a different intent than it began"),
  FlashEndOrder: never("the flash fill's begin and end are out of order"),
  ReceiverCannotReceive: never("the receiver token account cannot receive: frozen, closed, not initialized, for another mint or owner, or with an extension other than ImmutableOwner; use another receiver"),
  RefundCannotReceive: never("the refund account cannot take the refund: frozen, for another mint or owner, or with a foreign delegate, close authority or extension; refund to another account the owner controls, or wait for a frozen one to be thawed"),
  FeeAboveBound: never("the current fees exceed the bound the solver accepted"),
  ExtTooLong: never("the extension data is too long"),
  ExtMalformed: never("the extension data is malformed: badly encoded, tags unsorted or repeated, or a partner with a zero key or zero bps"),
  ExtUnknown: never("the extension data holds a field the program does not know"),
  FlagsUnknown: never("the intent flags name options the program does not know; leave flags unset"),
  FillKindDisabled: never(`the admin stopped fills of this kind; see kinds[].fills_stopped in ${tool("get_config")}`),
  UnsupportedVersion: never("an account has a version this program does not support"),
  AmountInMismatch: never("the fill must sell exactly the intent's remaining amount; read the intent again"),
  EpochRegression: never("the signing epoch can only move forward"),
  TreasuryMismatch: never("the treasury account must be the configured fee recipient; let this server pick it"),
  CrankBountyTooHigh: never("the crank bounty exceeds the program's maximum"),
  CreateFeeTooHigh: never("the create fee exceeds the program's maximum"),
  PartnerCutTooHigh: never(`the partner cut must be at most ${BPS_DENOMINATOR} bps`),
  PartnerFeeTooHigh: never(`a partner fee can be at most ${MAX_PARTNER_BPS} bps`),
  PartnerAccountMissing: later("the partner has no token account for the input mint yet; it must be created before a fill"),
  PartnerAccountNotCanonical: never("the partner fee must go to the partner's canonical token account"),
  MandateInvalid: never("the mandate's terms are unsound: kinds must be swap, limit or dutch; per-intent cap above the agent fee; total at least the per-intent cap; max intents, max lifetime and floors non-zero; valid until a future time; a partner needs both key and bps; the agent neither empty nor the owner; or the owner has used every grant lane"),
  MandateExpired: never(`the mandate has expired; the owner must grant a new one with ${tool("prepare_mandate")}`),
  MandateKind: never("the mandate does not allow this kind of intent"),
  MandateTtl: never("the intent lives longer than the mandate allows; choose an earlier expiry within it"),
  MandateCap: never("the intent draws more than the mandate's per-intent cap (amount sold plus agent fee); the owner set that cap, so stay within it or ask the owner, and never split or reword an order to get around it"),
  MandateBudget: never(`the mandate's total budget would be exceeded; check what remains with ${tool("get_mandate")}`),
  MandateCount: never("the mandate has already created as many intents as it allows"),
  MandatePrice: never("the minimum output is below the price floor the owner set; do not weaken the person's price on your own: tell them the order is cheaper than the owner allows, or ask for at least the floor"),
  MandateRevoked: never("this mandate no longer stands: the owner revoked it, granted that id again, or advanced their signing epoch; the owner must grant a new one"),
  MandateMismatch: never("the intent differs from the mandate's fixed terms: same mints, no flags, the owner's partner only, and proceeds to an account the owner holds"),
  CreateCostAboveCeiling: later("the engine's create fee or crank bounty rose above what this transaction allows; prepare it again and check the new cost before signing"),
  NonceJumpTooLarge: never("one advance may move the nonce base at most 2^32 past its current value and never into the agent nonce lanes; advance in smaller steps"),
  EpochJumpTooLarge: never("one advance may raise the signing epoch at most 2^48; advance-epoch always picks an allowed one, so rebuild the transaction with it"),
  NotAProof: never("the collaborative split settles only a proof intent that commits a spec hash; use the plain attested fill for a non-proof intent"),
  SplitCountMismatch: never("the recipient wallets, their weights, and the passed token accounts must be equal in number and within the engine's recipient cap"),
  RecipientNotCanonical: never("each split recipient account must be the recipient wallet's canonical associated token account for the input mint"),
  SplitNotConserved: never("the split left lamports in the escrow; the recipient weights must sum to the whole and cover the entire net after fees"),
  MintCapMissing: never("the engine requires escrow caps and this create did not pass the input mint's cap account; the mint may have no cap yet, in which case the engine accepts no intents selling it"),
  MintCapMismatch: never("the account passed as the mint cap is not the engine's writable cap account for the input mint"),
  MintCapPerOrder: never("the amount escrowed exceeds the per-order cap the engine set for the input mint; lower the amount"),
  MintCapWindow: later("intents selling this mint have used the engine's escrow cap for the current window; try again once the window rolls, or lower the amount"),
  MintCapInvalid: never("a mint cap needs a per-order cap above zero, a window cap at least the per-order cap, and a window of at least 60 seconds"),
  CommitteeInvalid: never("a committee needs 1 to 8 distinct members in ascending order, a threshold from 1 to its member count, a fee wallet, and an address that is the hash of exactly those terms"),
  CommitteeSigners: never("the votes name fewer members than the committee's threshold, or a member it does not have; gather votes from at least the threshold of its members"),
  CommitteeMismatch: never("the committee passed is not the judge the escrow names; release it with the committee its attestor field holds"),
} as const satisfies Record<string, Entry>;

type EngineErrorName = keyof typeof ENGINE_PROBLEMS;

export const ENGINE_ERROR_BASE = 6000;

export const ENGINE_ERROR_NAMES = Object.keys(ENGINE_PROBLEMS) as EngineErrorName[];

export const TOKEN_PROGRAMS: Address[] = [TOKEN_PROGRAM_ADDRESS, TOKEN_2022_PROGRAM_ADDRESS];

export const TOKEN_PROBLEMS: Record<number, { code: string } & Entry> = {
  1: { code: "InsufficientFunds", ...never("a token account, or the allowance a signed or agent create draws through, holds less than the amount; lower the amount or fund the account") },
  3: { code: "MintMismatch", ...never("a token account belongs to a different mint than the intent uses") },
  4: { code: "OwnerMismatch", ...never("a token account is not owned by the expected wallet") },
  17: { code: "AccountFrozen", ...later("a token account is frozen by its issuer; try again once it is thawed") },
  36: { code: "NoMemo", ...never("a token account requires a memo on incoming transfers; its owner must turn that off before it can receive") },
  42: {
    code: "CpiGuardTransferBlocked",
    ...never(`the owner's token account has CPI Guard on, which stops the engine moving tokens on the owner's signature; use ${tool("prepare_signed_intent")}, which draws through the engine's allowance, or turn CPI Guard off`),
  },
};

const FAILED = /^Program (\w{32,44}) failed: custom program error: 0x([0-9a-f]+)$/;

export function failureOf(logs: readonly string[]): { program: Address; code: number } | null {
  for (const line of logs) {
    const match = FAILED.exec(line);
    if (match !== null) {
      return { program: match[1] as Address, code: Number.parseInt(match[2] ?? "", 16) };
    }
  }
  return null;
}

const engineProblem = (name: EngineErrorName): Problem => ({
  code: name,
  programError: ENGINE_ERROR_BASE + ENGINE_ERROR_NAMES.indexOf(name),
  program: INTENT_ENGINE_PROGRAM_ADDRESS,
  ...ENGINE_PROBLEMS[name],
});

export const LOG_TAIL = 12;
export const LOG_LINE_LIMIT = 200;

export function simulationProblem(err: string, logs: readonly string[]): Problem {
  const tail = logs.slice(-LOG_TAIL).map((line) => untrusted(line).slice(0, LOG_LINE_LIMIT));
  const failure = failureOf(logs);
  if (failure !== null && failure.program === INTENT_ENGINE_PROGRAM_ADDRESS) {
    const name = ENGINE_ERROR_NAMES[failure.code - ENGINE_ERROR_BASE];
    if (name !== undefined) {
      return { ...engineProblem(name), logs: tail };
    }
  }
  if (failure !== null && TOKEN_PROGRAMS.includes(failure.program)) {
    const known = TOKEN_PROBLEMS[failure.code];
    if (known !== undefined) {
      return { ...known, programError: failure.code, program: failure.program, logs: tail };
    }
  }
  return {
    code: "TransactionFailed",
    retryable: SERVER_PROBLEMS.TransactionFailed.retryable,
    hint: `the transaction would fail (${untrusted(err)}); read the logs for the cause`,
    ...(failure === null ? {} : { programError: failure.code, program: failure.program }),
    logs: tail,
  };
}

export class SimulationFailed extends Error {
  readonly problem: Problem;

  constructor(problem: Problem) {
    super(problem.hint);
    this.name = "SimulationFailed";
    this.problem = problem;
  }
}

export const SERVER_PROBLEMS = {
  InvalidInput: never("a parameter is missing or out of range; issues names each field"),
  NotFound: never("an account the call reads does not exist on this cluster"),
  NotAMint: never("an address passed as a mint is not a token mint"),
  RateLimited: later("the RPC node is rate limiting; call again in a few seconds"),
  Unreachable: later("the RPC node could not be reached: the connection was refused, the name did not resolve or the request failed; call again once it is back, and check whether a send landed before sending it again"),
  Failed: never("an unexpected error; the hint carries its message"),
  TransactionFailed: never("the transaction would fail for a reason this client does not name; read the logs"),
  WalletNotConfigured: never("a wallet tool was called on a server started without --wallet"),
  WalletNotMainnet: never("the RPC serves mainnet; wallet tools work on devnet, testnet and localnet only"),
  NoWallet: never(`the server has no wallet yet; call ${tool("wallet_setup")} first`),
  WalletEmpty: never("the wallet holds no SOL; fund it from a faucet, then try again"),
  WalletTokenNotAllowed: never("the server was started with sell limits that do not name this token"),
  WalletTradeLimit: never("the trade sells more than the server's --wallet-per-trade limit for this token"),
  ReleaseChanged: never("the release differs from the one previewed: its payee, amount, result, fee or the escrow itself changed; preview it again and show the user"),
  ReleaseTooLarge: never("this split has too many co-authors to fit in one transaction; pass a lookup_table or reduce recipients as the hint says"),
  WalletBusy: later("another server using the same wallet holds its sale record for a moment; call again"),
  WalletHourLimit: later("the wallet sold as much of this token in the last hour as the server's --wallet-per-hour limit allows; try later or sell less"),
  AgentNotConfigured: never(`${tool("agent_create")} was called on a server started without --agent`),
  OwnerNotServed: never("the owner is not in the server's --agent-owners list"),
  BudgetExhausted: later("the agent or relayer key reached its hourly lamport budget; try again later"),
  NoFreeNonce: never("no free nonce is left in the owner's window or the mandate's lane"),
  NoFreeMandateId: never("this owner already granted this agent as many mandates as the client looks through; revoke one first"),
  NoncePromised: later("the nonce is held for another pending request; leave nonce out or ask again later"),
  TooManyPending: later("the owner has too many prepared requests waiting; submit some or let them expire"),
  SubmitInFlight: later("another request is relaying the same intent; ask again in a moment"),
  RelayerNotConfigured: never(`${tool("submit_signed_intent")} was called on a server started without --relayer`),
  RelayMintNotAccepted: never("the relayer does not relay intents selling this token"),
  RelayFeeTooLow: never("the relayer fee is below what this relayer charges for the input token"),
  RelayTooCostly: never("relaying would cost more lamports than this relayer pays per intent"),
  RelayTooLong: never("the intent expires later than this relayer accepts"),
  RelayRateLimited: later("the owner reached this relayer's hourly intent limit"),
  RelayTooLarge: never("the signed terms do not fit in one transaction with this relayer"),
  NonceTaken: never("a different intent already uses this nonce; these signed terms can never be submitted"),
  SignatureInvalid: never("the signature is not the owner's signature of these exact terms"),
  SignatureMalformed: never("the signature is not a base58 Ed25519 signature"),
  NotRentPayer: never("only the wallet that paid an intent's rent may close it; cancel without close"),
  NothingToCrank: later("the intent is not yet expired, or settling it pays this cranker nothing"),
  FundingExceedsBounty: never("recreating the owner's token account costs more than the intent's bounty"),
  OwnerAccountMissing: never("the owner has no token account that can take the refund; crank with fund_accounts"),
  NotDeliverable: never("the intent is not an open proof escrow, so no work can be delivered to it"),
  NotEarliestAnnouncer: never("another wallet announced the delivered work first; a release recording that work pays its earliest announcer"),
  NotAnnounced: never("no work with this sha256 was announced for the escrow, so it is not recorded as what the release paid for"),
  NotReleased: never("the escrow has no release in its history, so no delivery can be recorded for it"),
  NotARelease: never("the transaction named as the release is not a release of this escrow"),
  ReleaseUnread: later("the RPC node could not return the named release transaction; call again in a few seconds"),
  HistoryLagging: later("the RPC node has not returned every transaction the call reads yet; call again in a few seconds"),
  OtherLifecycle: never("the named release belongs to an earlier lifecycle of this escrow address, which was closed and made again at the same nonce, so it is not a release of the escrow there now"),
  AlreadyRecorded: never("the release already records a delivered sha256, in its own memo or a follow-up, and a receipt reads the first"),
  HistoryTooLong: never("the record a release depends on is incomplete, so it is refused rather than decided from part of it: the history is longer than the pages read, which more pages fix, or the RPC node's ledger does not reach back to the escrow's creation, or the transport cannot page signatures or report its first available slot, which more pages do not fix"),
} as const satisfies Record<string, Entry>;

type ServerProblemName = keyof typeof SERVER_PROBLEMS;

export class AgentRefusal extends Error {
  readonly problem: Problem;

  constructor(code: ServerProblemName | EngineErrorName, hint: string) {
    super(hint);
    this.name = "AgentRefusal";
    const known: Entry = code in SERVER_PROBLEMS ? SERVER_PROBLEMS[code as ServerProblemName] : ENGINE_PROBLEMS[code as EngineErrorName];
    this.problem = { code, retryable: known.retryable, hint };
  }
}

export const HINT_LIMIT = 300;

export const untrusted = (text: string): string => text.replace(/[^ -~]+/g, " ").slice(0, HINT_LIMIT);

const UNREACHABLE_CODES: ReadonlySet<string> = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);
const UNREACHABLE_TEXT = /fetch failed|getaddrinfo|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH/;
const CAUSE_DEPTH = 8;

export function unreachable(error: unknown, depth = 0): boolean {
  if (depth > CAUSE_DEPTH || error === null || typeof error !== "object") {
    return false;
  }
  const { code, message, cause } = error as { code?: unknown; message?: unknown; cause?: unknown };
  if (typeof code === "string" && UNREACHABLE_CODES.has(code)) {
    return true;
  }
  if (typeof message === "string" && UNREACHABLE_TEXT.test(message)) {
    return true;
  }
  return unreachable(cause, depth + 1);
}

export const unreachableHint = (url: string | undefined): string =>
  `the RPC node${url === undefined ? "" : ` at ${redactUrl(url)}`} could not be reached; call again once it answers, and if this call sent a transaction, check whether it landed before sending it again`;

export function problemOf(error: unknown, url?: string): Problem {
  if (error instanceof InvalidInput) {
    return { code: "InvalidInput", retryable: SERVER_PROBLEMS.InvalidInput.retryable, hint: "fix the listed fields and call again", issues: error.issues };
  }
  if (error instanceof SimulationFailed || error instanceof AgentRefusal) {
    return error.problem;
  }
  if (error instanceof IntentCoreError) {
    return engineProblem(error.code);
  }
  if (error instanceof MissingAccount) {
    return { code: "NotFound", retryable: SERVER_PROBLEMS.NotFound.retryable, hint: error.message };
  }
  if (error instanceof NotDeliverable) {
    return { code: "NotDeliverable", retryable: SERVER_PROBLEMS.NotDeliverable.retryable, hint: untrusted(error.message) };
  }
  if (error instanceof NotAMint) {
    return {
      code: "NotAMint",
      retryable: SERVER_PROBLEMS.NotAMint.retryable,
      hint: `${error.address} is not a token mint; pass the mint of the token itself, not a wallet or a token account`,
    };
  }
  if (rateLimited(error)) {
    return { code: "RateLimited", retryable: SERVER_PROBLEMS.RateLimited.retryable, hint: "the RPC node is rate limiting; wait a few seconds and call again" };
  }
  if (unreachable(error)) {
    return { code: "Unreachable", retryable: SERVER_PROBLEMS.Unreachable.retryable, hint: untrusted(unreachableHint(url)) };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: "Failed", retryable: SERVER_PROBLEMS.Failed.retryable, hint: untrusted(message) };
}
