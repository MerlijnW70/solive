import type { Address } from "@solana/kit";
import { FLOOR_THRESHOLD, SdkError } from "@intent-engine/core";

export class NoFreeNonce extends SdkError {
  readonly code = "no-free-nonce";
  override readonly name = "NoFreeNonce";
  readonly owner: Address;

  constructor(owner: Address) {
    super(`every nonce in the window of ${owner} is used; advance the nonce window first`);
    this.owner = owner;
  }
}

export type NotSettleableReason =
  | "wrong-judge"
  | "committee-judged"
  | "not-a-committee"
  | "split-excludes-announcer"
  | "not-a-proof-escrow"
  | "not-attested"
  | "not-open"
  | "unknown-announcement"
  | "other-escrow"
  | "already-paid"
  | "salt-mismatch"
  | "no-release"
  | "not-owner"
  | "feedback-given"
  | "not-an-intent"
  | "not-first-announcer";

export class NotSettleable extends SdkError {
  readonly code = "not-settleable";
  override readonly name = "NotSettleable";
  readonly intent: Address;
  readonly reason: NotSettleableReason;

  constructor(intent: Address, reason: NotSettleableReason, text: string) {
    super(`intent ${intent} ${text}`);
    this.intent = intent;
    this.reason = reason;
  }
}

export class ClaimHeldBy extends SdkError {
  readonly code = "claim-held-by";
  override readonly name = "ClaimHeldBy";
  readonly intent: Address;
  readonly worker: Address;
  readonly until: bigint;

  constructor(intent: Address, worker: Address, until: bigint) {
    super(`intent ${intent} is claimed by ${worker} until ${until}, so only that worker can be paid until then`);
    this.intent = intent;
    this.worker = worker;
    this.until = until;
  }
}

export type NotFillableReason = "not-open" | "attested";

export class NotFillable extends SdkError {
  readonly code = "not-fillable";
  override readonly name = "NotFillable";
  readonly intent: Address;
  readonly reason: NotFillableReason;

  constructor(intent: Address, reason: NotFillableReason, text: string) {
    super(`intent ${intent} ${text}`);
    this.intent = intent;
    this.reason = reason;
  }
}

export class PayToNotWallet extends SdkError {
  readonly code = "pay-to-not-wallet";
  override readonly name = "PayToNotWallet";
  readonly payTo: Address;
  readonly program: Address;

  constructor(payTo: Address, program: Address) {
    super(`payTo ${payTo} belongs to the program ${program}, not to a wallet, so nothing paid to it could be spent; give a wallet address`);
    this.payTo = payTo;
    this.program = program;
  }
}

export class PayeeMoved extends SdkError {
  readonly code = "payee-moved";
  override readonly name = "PayeeMoved";
  readonly payTo: Address;
  readonly account: Address;

  constructor(payTo: Address, account: Address) {
    super(`the token account ${account} of payTo ${payTo} is no longer held by ${payTo} for this mint, so a release to it would not reach ${payTo}`);
    this.payTo = payTo;
    this.account = account;
  }
}

export class EscrowExpired extends SdkError {
  readonly code = "escrow-expired";
  override readonly name = "EscrowExpired";
  readonly intent: Address;
  readonly expiresAt: bigint;

  constructor(intent: Address, expiresAt: bigint) {
    super(`intent ${intent} expired at ${expiresAt}; its owner gets it back instead`);
    this.intent = intent;
    this.expiresAt = expiresAt;
  }
}

export class VoteRejected extends SdkError {
  readonly code = "vote-rejected";
  override readonly name = "VoteRejected";
  readonly member: Address;
  readonly intent: Address;

  constructor(member: Address, intent: Address) {
    super(`the vote of ${member} is not a valid committee signature over the release of ${intent}`);
    this.member = member;
    this.intent = intent;
  }
}

export class CosignRejected extends SdkError {
  readonly code = "cosign-rejected";
  override readonly name = "CosignRejected";
  readonly wallet: Address;
  readonly intent: Address;

  constructor(wallet: Address, intent: Address) {
    super(`the co-author ${wallet} gave no valid signature over the split release of ${intent}; nothing was sent`);
    this.wallet = wallet;
    this.intent = intent;
  }
}

export class CommitteeNeeded extends SdkError {
  readonly code = "committee-needed";
  override readonly name = "CommitteeNeeded";
  readonly attestor: Address;
  readonly escrow: bigint;
  readonly floor: bigint;

  constructor(attestor: Address, escrow: bigint, floor: bigint) {
    super(
      `this escrow of ${escrow} raw units reaches the committee floor of ${floor} the engine sets for its token, and the attestor ${attestor} is not a committee of at least ${FLOOR_THRESHOLD} judges; name such a committee as attestor, or escrow less`,
    );
    this.attestor = attestor;
    this.escrow = escrow;
    this.floor = floor;
  }
}

export class IntentUnreadable extends SdkError {
  readonly code = "intent-unreadable";
  override readonly name = "IntentUnreadable";
  readonly intent: Address;

  constructor(intent: Address, cause: unknown) {
    super(`intent ${intent} cannot be read: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.intent = intent;
  }
}

export class StaleRead extends SdkError {
  readonly code = "stale-read";
  override readonly name = "StaleRead";
  readonly slot: bigint;
  readonly seen: bigint;

  constructor(slot: bigint, seen: bigint) {
    super(`the intents read at slot ${slot} is older than slot ${seen}, which the watch has already seen`);
    this.slot = slot;
    this.seen = seen;
  }
}

export class PreviewRefused extends SdkError {
  readonly code = "preview-refused";
  override readonly name = "PreviewRefused";

  constructor() {
    super("a preview sends nothing");
  }
}

export class TransportLacks extends SdkError {
  readonly code = "transport-lacks";
  override readonly name = "TransportLacks";
  readonly method: string;

  constructor(method: string) {
    super(`this transport has no ${method}; use a transport that implements it`);
    this.method = method;
  }
}
