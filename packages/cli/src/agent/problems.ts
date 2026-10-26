import { tool } from "./names.js";
import type { Address } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import { BPS_DENOMINATOR, INTENT_ENGINE_PROGRAM_ADDRESS, MAX_PARTNER_BPS, TOKEN_2022_PROGRAM_ADDRESS } from "@intent-engine/core/internal";
import { type AnySdkError, isSdkError, type MaybeSent } from "@intent-engine/client";
import { rateLimited } from "@intent-engine/client/internal";
import { InvalidInput, type Issue } from "./schema.js";
import { redactUrl } from "../render.js";
import { sanitized } from "../untrusted-text.js";

export type Problem = {
  code: string;
  retryable: boolean;
  hint: string;
  programError?: number;
  program?: Address;
  issues?: Issue[];
  logs?: string[];
  signature?: string;
  untrustedDetail?: string;
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
  UnknownStatus: never("the intent holds a status this version does not know; update to the latest @intent-engine/cli and read it again"),
  InvalidParams: never("the order terms are inconsistent; check amounts are non-zero and the auction times are ordered"),
  AmountMismatch: never("the amounts do not match what the intent escrows; read the intent again and use its remaining amount"),
  InsufficientOutput: later("the fill pays less than the intent requires right now; check what it requires with intent-engine quote --owner <address> --nonce <n>"),
  InvalidTransition: never("the intent is not in a state that allows this; read its status with intent-engine show intent --owner <address> --nonce <n>"),
  IntentExpired: never("the intent has expired and can no longer be filled; its owner can still cancel it; anyone can expire it with intent-engine expire --owner <address> --nonce <n>"),
  NotExpired: later("the intent has not expired yet; wait until its expiry time and try again"),
  NonceUsed: never("this nonce is already used; omit the nonce so the next free one is chosen"),
  NonceOutOfWindow: never("this nonce is outside the owner's 256-nonce window or inside the agent nonce lanes; omit the nonce so the next free one is chosen"),
  NonceRegression: never("the nonce base can only move forward"),
  Unauthorized: never("a signer or a named account does not match the one recorded on-chain (owner, rent payer, mandate agent, admin, guardian or upgrade authority); let this server pick the accounts and sign with the recorded key"),
  CreatePaused: later("creating intents is paused by the guardian or admin; try again later; intent-engine show config shows the pause bits in paused"),
  KindDisabled: never("this intent kind is not enabled; intent-engine show config shows the enabled kinds as bits in enabledKinds"),
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
  FillPaused: later("fills are paused by the guardian or admin, and with them new claims and stand-by joins; try again later; intent-engine show config shows the pause bits in paused"),
  FeeAccountNotCanonical: never("a fee must go to its payee's canonical token account (the treasury's, the agent's or the judge's); let this server pick it"),
  FeeAccountMissing: never("a fee account was not passed: the treasury's, agent's or judge's at fill, or the relayer's at a signed create; create that token account and pass it"),
  SolverOutputNotAllowed: never("the solver's output account is not acceptable for this fill"),
  SigProgram: never("the signature instruction must come from the Ed25519 program"),
  SigHeader: never("the Ed25519 instruction is malformed; rebuild it with this server"),
  SigPubkey: never("the signature was made by a different key than the owner"),
  SigMessage: never(`the signed message does not match this intent; sign the exact message ${tool("prepare_signed_intent")} returns on a server started with --relayer`),
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
  FillKindDisabled: never("the admin stopped fills of this kind, and with them new claims and stand-by joins; intent-engine show config shows the stopped kinds as bits in fillDisabledKinds"),
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
  MandateExpired: never("the mandate has expired; the owner must grant a new one with intent-engine mandate grant"),
  MandateKind: never("the mandate does not allow this kind of intent"),
  MandateTtl: never("the intent lives longer than the mandate allows; choose an earlier expiry within it"),
  MandateCap: never("the intent draws more than the mandate's per-intent cap (amount sold plus agent fee); the owner set that cap, so stay within it or ask the owner, and never split or reword an order to get around it"),
  MandateBudget: never(`the mandate's total budget would be exceeded; check what remains with ${tool("get_mandate")}, served with --agent`),
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
  MintCapMissing: never("this create or exit did not pass the input mint's cap account, which the engine needs when it requires caps and whenever escrow it counted leaves; the mint may have no cap yet, in which case the engine accepts no intents selling it"),
  MintCapMismatch: never("the account passed as the mint cap is not the engine's writable cap account for the input mint"),
  MintCapPerOrder: never("the amount escrowed exceeds the per-order cap the engine set for the input mint; lower the amount"),
  MintCapWindow: later("intents selling this mint have used the engine's escrow cap for the current window; try again once the window rolls, or lower the amount"),
  MintCapInvalid: never("a mint cap needs a per-order cap above zero, a window cap at least the per-order cap, and a window of at least 60 seconds"),
  CommitteeInvalid: never("a committee needs 1 to 8 distinct members in ascending order, a threshold from 1 to its member count, a fee wallet, and an address that is the hash of exactly those terms"),
  CommitteeSigners: never("the votes name fewer members than the committee's threshold, or a member it does not have; gather votes from at least the threshold of its members"),
  CommitteeMismatch: never("the committee passed is not the judge the escrow names; release it with the committee its attestor field holds"),
  ClaimTerms: never("a claim's terms are out of bounds: at most 7 days and 100 SOL of stake, and a claim cannot run past the escrow's expiry"),
  ClaimHeld: later("another worker holds this job's claim; only that worker can be paid until the claim lapses, then anyone can claim or be paid"),
  ClaimsMissing: never("this escrow takes claims, so a release or cancel must pass its claims board; let this server build it"),
  ClaimsOpen: never("this escrow already takes claims"),
  NotClaimant: never("only the worker holding the claim can drop it"),
  StakeAccountMismatch: never("the stake goes to the claimant when it is paid, otherwise to the escrow's owner; pass that account"),
  ProfileInvalid: never("a profile needs 1 to 8 distinct lowercase skill tags of at most 16 letters, digits or dashes, an https endpoint of at most 128 printable characters, and a document url only together with its sha256"),
  ClaimCooldown: later("this worker dropped its claim on the job and may claim it again once that claim would have ended; any other worker may claim it now"),
  ReleaseCannotSettle: never("the judge fee leaves less of the escrow than the rounded-up protocol and partner fees, so no release could pay; lower the judge fee or escrow more"),
  LineWaiting: later("workers stand by for this job, so it goes to them in line order and cannot be claimed directly; stand by to join the line"),
  LineEmpty: never("nobody stands by for this job, so no line is left to advance"),
  JobNotHeld: never("nobody holds this job and nobody stands by, so claim it instead of standing by"),
  LineEntryMismatch: never("a line entry passed is not the line's next one, or a drop or advance passed none while workers wait; let this server build it"),
  MintCapTotal: later("intents selling this mint already hold the engine's total escrow limit for it; try again once open intents settle, or lower the amount"),
  CommitteeRequired: never("this escrow reaches the committee floor the engine sets for its token, so its attestor must be a committee of at least 2 judges, passed with the create; name such a committee as attestor, or escrow less"),
  CommitteeFloorsFull: never("the engine already keeps a committee floor for as many tokens as it can; set one of them to zero first"),
  AccountOutdated: never("an account has an earlier layout or version than this program reads; upgrade it with intent-engine migrate, or close it with intent-engine close-legacy and create it again"),
  NotLegacy: never("close-legacy closes only accounts of an earlier layout or version, and this one is current"),
  LegacyPayeeMismatch: never("close-legacy pays the wallet the account's layout records as its payer, or the config's fee recipient when it records none; let intent-engine close-legacy build it"),
  LegacyVaultOpen: never("close-legacy closes an intent only once its vault is gone; cancel, expire or close the intent first so its owner gets every token back"),
  LegacyMigrates: never("close-legacy never closes a config or user state; intent-engine migrate upgrades them in place"),
  AlreadyCurrent: never("migrate rewrites only accounts of an earlier layout or version, and this one is current"),
  UnknownLayout: never("migrate reads only the layouts earlier programs wrote; close this account with intent-engine close-legacy"),
  ConfigMissing: never("migrating an open escrow reads the fee schedule from the config; let intent-engine migrate build it"),
  LegacyLineOpen: never("close-legacy never closes a claim board or stand-by entry of an open escrow, so the line keeps its order; intent-engine migrate upgrades it in place"),
  ClaimListInvalid: never("a claim list names 1 to 32 distinct wallets, none of them the empty address, and never more than the size its owner set"),
  ClaimListIncomplete: later("the owner has not yet added every wallet its claim list names, so nobody can claim or stand by until the list is complete"),
  NotListed: never("the escrow's owner named the wallets that may claim it, and this wallet is not one of them"),
  ClaimListMissing: never("this escrow's claims board records a claim list, so a claim, stand-by or closing settle must pass it; let this server build it"),
  ClaimListSet: never("this escrow's claim list is already set, and a set list never changes"),
  BlobMalformed: never("the sealed delivery is not a version-4 sealed blob within the engine's size bounds; seal it again with this version"),
  AnnouncementState: never("the announcement account holds a state this version does not read; update this server"),
  AnnouncementOpen: later("an announcement stays while its escrow is open; its worker can close it once the escrow is released, cancelled or expired"),
  AnnouncementRetained: later("an announcement stays through the refute window after its escrow expires or after it is paid, so an earlier worker can still refute the release"),
  RefuteNotEarlier: never("a refutation needs an announcement made before the paid one, and this one came later"),
  RefuteSamePayee: never("the earlier announcement belongs to a wallet the release paid; only an announcement by an unpaid wallet refutes a release"),
  AttestorMismatch: never("the attestor account is not the attestor this escrow names; pass the escrow's attestor"),
  BlobRecipients: never("the sealed delivery is sealed to a different number of keys than this escrow's judge or committee holds; seal it again to the judge's keys"),
  BlobKeyMismatch: never("the sealed delivery is not sealed to the key the judge's profile publishes now; seal it again to the published key"),
  CommitteeKeysUnsynced: later("the committee has not recorded its members' encryption keys yet; anyone can record them with sync_committee_keys, then announce again"),
  CommitmentZero: never("an announcement must carry the commitment to the delivered work, and this one is empty"),
  ProfileMismatch: never("the judge's profile account is missing or is not a profile of this program; pass the judge's profile address"),
  BookMismatch: never("the delivery book account does not belong to this escrow"),
  AnnounceFeeMissing: never("the engine charges an announce fee, so the transaction must pass the fee recipient's wallet; let this server build it"),
  AnnouncementMissing: never("a release of a proof escrow names the announcement it pays, and this one names none; release through the first announcement that opens to the work"),
  AnnouncementUnexpected: never("this escrow commits no spec hash, so its release names no announcement and no opening"),
  AnnouncementMismatch: never("the announcement belongs to another escrow than the one this names"),
  AnnouncementPaid: never("this announcement was already paid; an announcement is paid once"),
  PayeeNotAnnouncer: never("the payee token account does not belong to the wallet that made the announcement; a proof release pays the announcing worker"),
  CommitmentMismatch: never("the opening does not open the announcement's commitment to this work; use the salt and sha256 the announcement commits to"),
  AnnouncerNotRecipient: never("a split release must pay the wallet that made the announcement among its recipients"),
  RentRecipientMismatch: never("rent goes back only to the wallet that paid it; let this server pick the account"),
  DeliveryBookOpen: never("the delivery book of an open escrow stays; close it once the escrow is released, cancelled or expired"),
  DeliveryBookLive: never("the delivery book still holds announcements; close them first"),
  RefuteNotPaid: never("only a paid announcement can be refuted"),
  RefuteNotAnnouncer: never("only the wallet that made the earlier announcement refutes with it"),
  RefuteSplitMismatch: never("the recipients and weights given are not the split the release paid; pass them exactly as the release named them"),
  DeliveryRecordKept: never("a delivery record account is not closed as a legacy account"),
  SharesHeld: later("a co-author's share of this escrow is still held for it to claim; the escrow and its paid announcement stay until that share is claimed or a year after the escrow expires"),
  NoShareHeld: never("nothing is held for this index of the split; it was paid at release or already claimed"),
  HeldSplitMismatch: never("the recipients and weights given are not the split the release paid, or the signer is not the wallet at that index; pass them exactly as the release named them"),
  HolderStandsBy: never("the wallet holding a job's claim cannot stand by in that job's line; it keeps the claim until it drops it or the claim lapses"),
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
    ...never("the owner's token account has CPI Guard on, which stops the engine moving tokens on the owner's signature; turn CPI Guard off, or create a signed intent with intent-engine signed prepare, which draws through the engine's allowance"),
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
  const tail = logs.slice(-LOG_TAIL).map((line) => sanitized(line, LOG_LINE_LIMIT));
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
  if (err.replace(/^'(.*)'$/, "$1") === "AccountNotFound" && failure === null) {
    return { code: "Unfunded", retryable: SERVER_PROBLEMS.Unfunded.retryable, hint: SERVER_PROBLEMS.Unfunded.hint, logs: tail };
  }
  return {
    code: "TransactionFailed",
    retryable: SERVER_PROBLEMS.TransactionFailed.retryable,
    hint: SERVER_PROBLEMS.TransactionFailed.hint,
    untrustedDetail: untrusted(err),
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
  CertificateUntrusted: never("this machine does not trust the RPC node's certificate, often because antivirus or a proxy inspects HTTPS"),
  Unfunded: never("your wallet has no SOL yet; fund it, then try again"),
  Failed: never("an unexpected error; its message, which may come from the RPC node, is in the untrusted detail"),
  MaybeSent: never("the transaction may have landed, so it must not be sent again: look its signature up with intent-engine lookup --signature, as the hint says, and send again only once that reports expired"),
  TransactionFailed: never("the transaction would fail for a reason this client does not name; the node's error is in the untrusted detail and the last log lines in logs"),
  WalletNotConfigured: never("a wallet tool was called on a server started without --wallet"),
  NoClock: never("wait was given to a server built without a clock; call again without wait"),
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
  NoSpecUrl: never("the escrow publishes no spec url, or is not a proof escrow; ask its owner where its acceptance spec lives"),
  NotInvited: never("pay_to was not invited to the job: its spec is sealed to other wallets"),
  SpecSealed: never("the spec is sealed to invited wallets, and this server's wallet is not one of them or it has no wallet"),
  SpecUnreadable: later("the spec url could not be read this time: it failed or the node answered a temporary error; try again shortly"),
  SpecUnfetchable: never("the spec url cannot be read: it answered not-found, redirects, is larger than the limit, or is not a public http(s) address; ask the owner for a working spec url and do not retry this one"),
  WorkUnreadable: later("the announced work could not be fetched this time: the request failed or the host answered a temporary error; try again shortly"),
  WorkUnfetchable: never("the announced work cannot be read here: no announcement opens with this wallet's keys, or its url answers not-found, redirects, is larger than the limit or is not a public https address; do not retry it"),
  NotEarliestAnnouncer: never("another wallet made the first announcement that opens to the delivered work; a release pays that announcement's worker"),
  AnnouncementsIncomplete: later("the RPC node does not list every announcement of the escrow yet, or the escrow is closed, so the first one that opens to the work cannot be known; nothing was signed"),
  KeyNotGiven: never("an earlier announcement is sealed to a key this server was not given, so the first one that opens to the work cannot be known; start the server with mcp --encryption-keypair naming that key's file"),
  EncryptionKeyInvalid: never("the file mcp --encryption-keypair names is not an encryption key file that profile encryption-key new writes, so nothing sealed to it can be opened; start the server with the right file"),
  NoMessageSigner: never("the wallet cannot sign messages, and an announcement derives its salt and keys from the wallet's signature; use a key file or give the signature the hint asks for"),
  NotAnnounced: never("no announcement to the escrow opens to this work with this wallet's keys, so no release can pay for it"),
  NotReleased: never("the escrow has no release in its history yet"),
  KeyInUse: never("this wallet signs on a Ledger and judges open escrows, whose announcements only its encryption key opens; rotate the key instead of removing it, or wait until they close"),
  NotRefutable: never("the announcements named cannot refute this release: the hint says why; nothing was sent"),
  NothingToReclaim: never("none of this wallet's announcements can close now: each belongs to an open escrow, is kept for the refutation window, can still refute a paid release, or holds a split share until it is claimed; the hint says which"),
  NotARelease: never("the transaction named as the release is not a release of this escrow"),
  ReleaseUnread: later("the RPC node could not return the named release transaction; call again in a few seconds"),
  HistoryLagging: later("the RPC node has not returned every transaction the call reads yet; call again in a few seconds"),
  OtherLifecycle: never("the named release belongs to an earlier lifecycle of this escrow address, which was closed and made again at the same nonce, so it is not a release of the escrow there now"),
  ConfirmMismatch: later("the second RPC node the server was started with, by --confirm-url, reports another genesis hash, escrow, announcement list or first announcer than the first, or could not be read, so nothing was signed or sent; call again once both nodes agree"),
  NeverSettles: never("no release of this escrow could pay: after the judge fee, too little is left for the rounded-up protocol and partner fees; escrow more or lower the judge fee, as the hint says"),
  ClaimListTooLarge: never("the escrow and the claim list its sealed spec sets do not fit in one transaction, and a Ledger signs only the one transaction it previewed; seal the spec to fewer workers, or escrow without claims and open them with intent-engine claims open --workers, which sends the list in parts"),
  Ledger: never("the wallet's Ledger did not sign: it was rejected on the device, or the device is locked, unplugged or not in the Solana app; nothing was sent, and the hint says which"),
  NoFeePayer: never("the wallet is a Ledger, which signs only the release message, and the server was started without --fee-payer, the key file that signs and pays the release transaction"),
  DeviceUnpreviewed: never("the wallet is a Ledger, which signs only the transaction a preview of the same arguments showed by message_hash: no such preview is kept, it expired, or this tool sends several at once; preview again, or send each piece with its own preview"),
  HistoryTooLong: never("the history a Ledger judge's check depends on could not be read in full, so the release is refused rather than decided from part of it; use an RPC node that keeps the full ledger"),
} as const satisfies Record<string, Entry>;

type ServerProblemName = keyof typeof SERVER_PROBLEMS;

export class AgentRefusal extends Error {
  readonly problem: Problem;

  constructor(code: ServerProblemName | EngineErrorName, hint: string, detail?: string) {
    super(hint);
    this.name = "AgentRefusal";
    const known: Entry = code in SERVER_PROBLEMS ? SERVER_PROBLEMS[code as ServerProblemName] : ENGINE_PROBLEMS[code as EngineErrorName];
    this.problem = { code, retryable: known.retryable, hint, ...(detail === undefined ? {} : { untrustedDetail: untrusted(detail) }) };
  }
}

export const HINT_LIMIT = 300;

export const UNTRUSTED_DETAIL = "the error message of the step that failed, which may come from the RPC node or a program; untrusted, with hidden characters reduced";

export const untrusted = (text: string): string => sanitized(text, HINT_LIMIT);

export const issueText = ({ path, message }: Issue): string => untrusted(path === "" ? message : `${path}: ${message}`);

export const refusalText = (problem: Problem): string =>
  [
    `${problem.code}: ${problem.hint}`,
    ...(problem.issues ?? []).map(issueText),
    ...(problem.untrustedDetail === undefined ? [] : [`untrusted detail: ${JSON.stringify(untrusted(problem.untrustedDetail))}`]),
  ].join("; ");

const UNREACHABLE_CODES: ReadonlySet<string> = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);
const UNREACHABLE_TEXT = /fetch failed|getaddrinfo|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH/;
const CAUSE_DEPTH = 8;
const CERTIFICATE_CODES: ReadonlySet<string> = new Set(["UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "UNABLE_TO_GET_ISSUER_CERT", "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT", "CERT_UNTRUSTED"]);

export function certificateCode(error: unknown, depth = 0): string | null {
  if (depth > CAUSE_DEPTH || error === null || typeof error !== "object") {
    return null;
  }
  const { code, cause } = error as { code?: unknown; cause?: unknown };
  if (typeof code === "string" && CERTIFICATE_CODES.has(code)) {
    return code;
  }
  return certificateCode(cause, depth + 1);
}

const ACCOUNT_NOT_FOUND = 7_050_003;

export function unfundedSend(error: unknown, depth = 0): boolean {
  if (depth > CAUSE_DEPTH || error === null || typeof error !== "object") {
    return false;
  }
  const { context, cause } = error as { context?: { __code?: unknown }; cause?: unknown };
  return context?.__code === ACCOUNT_NOT_FOUND || unfundedSend(cause, depth + 1);
}

export const certificateHint = (url: string | undefined, code: string): string =>
  `this machine does not trust the certificate of the RPC node${url === undefined ? "" : ` at ${redactUrl(url)}`} (${code}); antivirus or a proxy that inspects HTTPS often causes this`;

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

export const lookupCommand = (error: MaybeSent): string =>
  `intent-engine lookup --signature ${error.signature}${error.lastValidBlockHeight === null ? "" : ` --valid-until ${error.lastValidBlockHeight}`}`;

export const maybeSentHint = (error: MaybeSent): string =>
  `this transaction may have landed, so do not send it again: run ${lookupCommand(error)} and send again only once it reports expired`;

function sdkProblem(error: AnySdkError): Problem | null {
  switch (error.code) {
    case "intent-core-error":
      return engineProblem(error.engineError);
    case "ledger-error":
      return { code: "Ledger", retryable: SERVER_PROBLEMS.Ledger.retryable, hint: untrusted(error.message) };
    case "account-version-error":
      return { code: "AccountOutdated", retryable: ENGINE_PROBLEMS.AccountOutdated.retryable, hint: error.message };
    case "missing-account":
      return { code: "NotFound", retryable: SERVER_PROBLEMS.NotFound.retryable, hint: error.message };
    case "not-deliverable":
      return { code: "NotDeliverable", retryable: SERVER_PROBLEMS.NotDeliverable.retryable, hint: untrusted(error.message) };
    case "not-a-mint":
      return {
        code: "NotAMint",
        retryable: SERVER_PROBLEMS.NotAMint.retryable,
        hint: `${error.address} is not a token mint; pass the mint of the token itself, not a wallet or a token account`,
      };
    case "maybe-sent":
      return { code: "MaybeSent", retryable: SERVER_PROBLEMS.MaybeSent.retryable, hint: untrusted(maybeSentHint(error)), signature: error.signature };
    default:
      return null;
  }
}

export function problemOf(error: unknown, url?: string): Problem {
  if (error instanceof InvalidInput) {
    return { code: "InvalidInput", retryable: SERVER_PROBLEMS.InvalidInput.retryable, hint: "fix the listed fields and call again", issues: error.issues };
  }
  if (error instanceof SimulationFailed || error instanceof AgentRefusal) {
    return error.problem;
  }
  const sdk = isSdkError(error) ? sdkProblem(error) : null;
  if (sdk !== null) {
    return sdk;
  }
  if (rateLimited(error)) {
    return { code: "RateLimited", retryable: SERVER_PROBLEMS.RateLimited.retryable, hint: "the RPC node is rate limiting; wait a few seconds and call again" };
  }
  if (unfundedSend(error)) {
    return { code: "Unfunded", retryable: SERVER_PROBLEMS.Unfunded.retryable, hint: SERVER_PROBLEMS.Unfunded.hint };
  }
  const certificate = certificateCode(error);
  if (certificate !== null) {
    return { code: "CertificateUntrusted", retryable: SERVER_PROBLEMS.CertificateUntrusted.retryable, hint: certificateHint(url, certificate) };
  }
  if (unreachable(error)) {
    return { code: "Unreachable", retryable: SERVER_PROBLEMS.Unreachable.retryable, hint: untrusted(unreachableHint(url)) };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { code: "Failed", retryable: SERVER_PROBLEMS.Failed.retryable, hint: SERVER_PROBLEMS.Failed.hint, untrustedDetail: untrusted(message) };
}
