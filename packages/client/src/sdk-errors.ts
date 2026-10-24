import {
  AccountVersionError,
  EncryptionKeyError,
  IntentCoreError,
  InvalidInput,
  NoSignature,
  NotAnEngineAccount,
  NotInvited,
  type SdkError,
  type SdkErrorCode,
  type SdkErrors,
  SealedError,
} from "@intent-engine/core";
import { MissingAccount, NotAMint } from "./accounts.js";
import {
  AnnouncementsUnreadable,
  BadSaltSignature,
  BookNotClosable,
  FirstOpeningRefused,
  NoMessageSigner,
  NotDeliverable,
  NotRefutable,
  UrlTooLong,
} from "./announce-errors.js";
import {
  ClaimHeldBy,
  CommitteeNeeded,
  CosignRejected,
  EscrowExpired,
  IntentUnreadable,
  NoFreeNonce,
  NotFillable,
  NotSettleable,
  PayeeMoved,
  PayToNotWallet,
  PreviewRefused,
  StaleRead,
  TransportLacks,
  VoteRejected,
} from "./client-errors.js";
import { ConfirmMismatch } from "./confirm-release.js";
import { SpecSealed, SpecUnreadable } from "./job-specs.js";
import { LedgerError, LedgerPathError } from "./ledger.js";
import { FetchFailed } from "./pinned-fetch.js";
import { BehindMinSlot, BlockhashExpired, FailedOnChain, MaybeSent, SubscriptionEnded } from "./send-errors.js";
import { MainnetNotAllowed } from "./simple-tokens.js";
import { NoKeyAtCreation, ProfileHistoryIncomplete } from "./unopened.js";

declare module "@intent-engine/core" {
  interface SdkErrors {
    "missing-account": MissingAccount;
    "not-a-mint": NotAMint;
    "not-deliverable": NotDeliverable;
    "no-message-signer": NoMessageSigner;
    "bad-salt-signature": BadSaltSignature;
    "url-too-long": UrlTooLong;
    "announcements-unreadable": AnnouncementsUnreadable;
    "first-opening-refused": FirstOpeningRefused;
    "not-refutable": NotRefutable;
    "book-not-closable": BookNotClosable;
    "no-free-nonce": NoFreeNonce;
    "not-settleable": NotSettleable;
    "claim-held-by": ClaimHeldBy;
    "not-fillable": NotFillable;
    "pay-to-not-wallet": PayToNotWallet;
    "payee-moved": PayeeMoved;
    "escrow-expired": EscrowExpired;
    "vote-rejected": VoteRejected;
    "cosign-rejected": CosignRejected;
    "committee-needed": CommitteeNeeded;
    "intent-unreadable": IntentUnreadable;
    "stale-read": StaleRead;
    "preview-refused": PreviewRefused;
    "transport-lacks": TransportLacks;
    "confirm-mismatch": ConfirmMismatch;
    "spec-sealed": SpecSealed;
    "spec-unreadable": SpecUnreadable;
    "ledger-error": LedgerError;
    "ledger-path-error": LedgerPathError;
    "maybe-sent": MaybeSent;
    "failed-on-chain": FailedOnChain;
    "blockhash-expired": BlockhashExpired;
    "behind-min-slot": BehindMinSlot;
    "subscription-ended": SubscriptionEnded;
    "fetch-failed": FetchFailed;
    "mainnet-not-allowed": MainnetNotAllowed;
    "profile-history-incomplete": ProfileHistoryIncomplete;
    "no-key-at-creation": NoKeyAtCreation;
  }
}

export type SdkErrorFields<C extends SdkErrorCode> = Extract<Exclude<keyof SdkErrors[C], keyof SdkError>, string>;

export type SdkErrorEntry<C extends SdkErrorCode> = {
  error: new (...args: never[]) => SdkErrors[C];
  fields: readonly SdkErrorFields<C>[];
  meaning: string;
};

export const SDK_ERRORS: { readonly [C in SdkErrorCode]: SdkErrorEntry<C> } = {
  "invalid-input": { error: InvalidInput, fields: ["field", "rule"], meaning: "an argument breaks a rule: field names it, rule says which kind of rule" },
  "intent-core-error": { error: IntentCoreError, fields: ["engineError"], meaning: "a check that mirrors the engine program refused; engineError names the engine error it would raise" },
  "encryption-key-error": { error: EncryptionKeyError, fields: [], meaning: "an encryption key file is not one profile encryption-key new writes, or its keys do not match" },
  "sealed-error": { error: SealedError, fields: [], meaning: "a sealed file cannot be made or opened: malformed, changed, too many wallets or a key that does not fit" },
  "not-invited": { error: NotInvited, fields: ["wallet"], meaning: "none of the keys given is one the file was sealed to" },
  "account-version-error": { error: AccountVersionError, fields: ["account", "version", "current"], meaning: "an engine account has a layout this SDK does not read; close or migrate it" },
  "not-an-engine-account": { error: NotAnEngineAccount, fields: ["address"], meaning: "the account or data is not the engine account the call expects" },
  "no-signature": { error: NoSignature, fields: ["signer"], meaning: "a signer returned no signature for the message" },
  "missing-account": { error: MissingAccount, fields: ["address"], meaning: "an account the call reads does not exist on this cluster" },
  "not-a-mint": { error: NotAMint, fields: ["address"], meaning: "an address passed as a mint is not a token mint" },
  "not-deliverable": { error: NotDeliverable, fields: ["intent", "reason"], meaning: "work cannot be announced to this intent; reason says why" },
  "no-message-signer": { error: NoMessageSigner, fields: ["worker"], meaning: "the wallet cannot sign messages, which an announcement needs for its salt and keys" },
  "bad-salt-signature": { error: BadSaltSignature, fields: ["worker"], meaning: "the salt signature given is not the worker's signature of the salt message" },
  "url-too-long": { error: UrlTooLong, fields: ["bytes", "max", "recipients"], meaning: "the work url does not fit one transaction when sealed to this many recipients" },
  "announcements-unreadable": { error: AnnouncementsUnreadable, fields: [], meaning: "the transport cannot list engine accounts, so announcements cannot be read" },
  "first-opening-refused": {
    error: FirstOpeningRefused,
    fields: ["intent", "reason", "sha256", "announcement", "seq", "worker", "sealedTo", "missing", "closed", "holder"],
    meaning: "the first announcement that opens to the work cannot be known or cannot be paid; reason says why",
  },
  "not-refutable": { error: NotRefutable, fields: ["earlier"], meaning: "the announcements named cannot refute the release" },
  "book-not-closable": { error: BookNotClosable, fields: ["intent"], meaning: "the delivery book of the intent cannot be closed yet" },
  "no-free-nonce": { error: NoFreeNonce, fields: ["owner"], meaning: "every nonce in the owner's window is used; advance the window first" },
  "not-settleable": { error: NotSettleable, fields: ["intent", "reason"], meaning: "the intent cannot be released, paid or given feedback this way; reason says why" },
  "claim-held-by": { error: ClaimHeldBy, fields: ["intent", "worker", "until"], meaning: "another worker holds the job's claim, so only that worker can be paid until it ends" },
  "not-fillable": { error: NotFillable, fields: ["intent", "reason"], meaning: "the intent cannot be filled; reason says why" },
  "pay-to-not-wallet": { error: PayToNotWallet, fields: ["payTo", "program"], meaning: "the payee belongs to a program, not a wallet, so nothing paid to it could be spent" },
  "payee-moved": { error: PayeeMoved, fields: ["payTo", "account"], meaning: "the payee's token account changed hands, so a release would not reach the payee" },
  "escrow-expired": { error: EscrowExpired, fields: ["intent", "expiresAt"], meaning: "the escrow expired; its owner gets it back instead" },
  "vote-rejected": { error: VoteRejected, fields: ["member", "intent"], meaning: "a committee vote is not a valid signature over the release" },
  "cosign-rejected": { error: CosignRejected, fields: ["wallet", "intent"], meaning: "a co-author gave no valid signature over the split release" },
  "committee-needed": { error: CommitteeNeeded, fields: ["attestor", "escrow", "floor"], meaning: "the escrow reaches the committee floor, so its attestor must be a committee" },
  "intent-unreadable": { error: IntentUnreadable, fields: ["intent"], meaning: "a watched intent account could not be decoded; cause holds why" },
  "stale-read": { error: StaleRead, fields: ["slot", "seen"], meaning: "the node answered from a slot older than one the watch already saw" },
  "preview-refused": { error: PreviewRefused, fields: [], meaning: "a preview tried to send; previews send nothing" },
  "transport-lacks": { error: TransportLacks, fields: ["method"], meaning: "the transport does not implement a method the call needs" },
  "confirm-mismatch": { error: ConfirmMismatch, fields: ["field", "first", "second"], meaning: "the second RPC node disagrees with the first or could not be read; nothing was signed or sent" },
  "spec-sealed": { error: SpecSealed, fields: ["url", "to", "keyed"], meaning: "the spec is sealed to invited wallets and no key given opens it" },
  "spec-unreadable": { error: SpecUnreadable, fields: ["url"], meaning: "the spec url could not be fetched or opened" },
  "ledger-error": { error: LedgerError, fields: [], meaning: "the Ledger did not sign; nothing was sent" },
  "ledger-path-error": { error: LedgerPathError, fields: [], meaning: "the text is not a Ledger path this SDK accepts" },
  "maybe-sent": {
    error: MaybeSent,
    fields: ["signature", "lastValidBlockHeight"],
    meaning: "the transaction may have landed; resolve it with client.status(signature, lastValidBlockHeight) and do not send it again",
  },
  "failed-on-chain": {
    error: FailedOnChain,
    fields: ["signature", "err", "program", "logs", "engine"],
    meaning: "the transaction landed and failed, so its fee was paid and nothing else changed; engine is set when the engine program failed",
  },
  "blockhash-expired": { error: BlockhashExpired, fields: [], meaning: "the transaction certainly did not land: its blockhash expired; sign it again" },
  "behind-min-slot": { error: BehindMinSlot, fields: ["slot", "minContextSlot"], meaning: "the node answered from a slot older than one already seen; the read is retried" },
  "subscription-ended": { error: SubscriptionEnded, fields: ["signature", "reason"], meaning: "a signature subscription ended without a result; confirmation falls back to polling" },
  "fetch-failed": { error: FetchFailed, fields: ["url", "reason", "detail"], meaning: "a pinned fetch failed: redirect, bad status, network, no address or aborted" },
  "mainnet-not-allowed": { error: MainnetNotAllowed, fields: ["url"], meaning: "the url serves mainnet and allowMainnet was not given" },
  "profile-history-incomplete": { error: ProfileHistoryIncomplete, fields: ["judge"], meaning: "the judge's profile history could not be read back far enough; nothing was paid" },
  "no-key-at-creation": { error: NoKeyAtCreation, fields: ["intent"], meaning: "the Ledger judge's profile named no encryption key when the escrow was made" },
};
