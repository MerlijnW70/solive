import type { Address } from "@solana/kit";
import { FLOOR_THRESHOLD } from "@intent-engine/core";

export class NoFreeNonce extends Error {
  readonly owner: Address;

  constructor(owner: Address) {
    super(`every nonce in the window of ${owner} is used; advance the nonce window first`);
    this.name = "NoFreeNonce";
    this.owner = owner;
  }
}

export class NotSettleable extends Error {
  readonly intent: Address;

  constructor(intent: Address, reason: string) {
    super(`intent ${intent} ${reason}`);
    this.name = "NotSettleable";
    this.intent = intent;
  }
}

export class ClaimHeldBy extends NotSettleable {
  readonly worker: Address;
  readonly until: bigint;

  constructor(intent: Address, worker: Address, until: bigint) {
    super(intent, `is claimed by ${worker} until ${until}, so only that worker can be paid until then`);
    this.name = "ClaimHeldBy";
    this.worker = worker;
    this.until = until;
  }
}

export class NotFillable extends Error {
  readonly intent: Address;

  constructor(intent: Address, reason: string) {
    super(`intent ${intent} ${reason}`);
    this.name = "NotFillable";
    this.intent = intent;
  }
}

export class PayToNotWallet extends Error {
  readonly payTo: Address;
  readonly program: Address;

  constructor(payTo: Address, program: Address) {
    super(`payTo ${payTo} belongs to the program ${program}, not to a wallet, so nothing paid to it could be spent; give a wallet address`);
    this.name = "PayToNotWallet";
    this.payTo = payTo;
    this.program = program;
  }
}

export class PayeeMoved extends Error {
  readonly payTo: Address;
  readonly account: Address;

  constructor(payTo: Address, account: Address) {
    super(`the token account ${account} of payTo ${payTo} is no longer held by ${payTo} for this mint, so a release to it would not reach ${payTo}`);
    this.name = "PayeeMoved";
    this.payTo = payTo;
    this.account = account;
  }
}

export class EscrowExpired extends Error {
  readonly intent: Address;
  readonly expiresAt: bigint;

  constructor(intent: Address, expiresAt: bigint) {
    super(`intent ${intent} expired at ${expiresAt}; its owner gets it back instead`);
    this.name = "EscrowExpired";
    this.intent = intent;
    this.expiresAt = expiresAt;
  }
}

export class VoteRejected extends Error {
  readonly member: Address;
  readonly intent: Address;

  constructor(member: Address, intent: Address) {
    super(`the vote of ${member} is not a valid committee signature over the release of ${intent}`);
    this.name = "VoteRejected";
    this.member = member;
    this.intent = intent;
  }
}

export class CosignRejected extends Error {
  readonly wallet: Address;
  readonly intent: Address;

  constructor(wallet: Address, intent: Address) {
    super(`the co-author ${wallet} gave no valid signature over the split release of ${intent}; nothing was sent`);
    this.name = "CosignRejected";
    this.wallet = wallet;
    this.intent = intent;
  }
}

export class CommitteeNeeded extends Error {
  readonly attestor: Address;
  readonly escrow: bigint;
  readonly floor: bigint;

  constructor(attestor: Address, escrow: bigint, floor: bigint) {
    super(
      `this escrow of ${escrow} raw units reaches the committee floor of ${floor} the engine sets for its token, and the attestor ${attestor} is not a committee of at least ${FLOOR_THRESHOLD} judges; name such a committee as attestor, or escrow less`,
    );
    this.name = "CommitteeNeeded";
    this.attestor = attestor;
    this.escrow = escrow;
    this.floor = floor;
  }
}
