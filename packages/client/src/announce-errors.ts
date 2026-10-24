import type { Address } from "@solana/kit";
import { SdkError } from "@intent-engine/core";

export type NotDeliverableReason = "no-shared-secret" | "claim-held" | "not-a-proof-escrow" | "not-open" | "announced-unseen";

export class NotDeliverable extends SdkError {
  readonly code = "not-deliverable";
  override readonly name = "NotDeliverable";
  readonly intent: Address;
  readonly reason: NotDeliverableReason;

  constructor(intent: Address, reason: NotDeliverableReason, text: string) {
    super(`intent ${intent} ${text}`);
    this.intent = intent;
    this.reason = reason;
  }
}

export const cannotSignMessages = (worker: Address): string =>
  `the wallet ${worker} cannot sign messages, and an announcement derives its salt and keys from the wallet's own signature over the intent and the work's sha256; announce with a key file, a wallet that signs messages, or 32 secret bytes of your own that you keep; nothing was sent`;

export class NoMessageSigner extends SdkError {
  readonly code = "no-message-signer";
  override readonly name = "NoMessageSigner";
  readonly worker: Address;

  constructor(worker: Address) {
    super(cannotSignMessages(worker));
    this.worker = worker;
  }
}

export const saltSignatureRefused = (worker: Address): string =>
  `the salt signature is not ${worker}'s ed25519 signature of the salt message for this intent and sha256; nothing was sent`;

export class BadSaltSignature extends SdkError {
  readonly code = "bad-salt-signature";
  override readonly name = "BadSaltSignature";
  readonly worker: Address;

  constructor(worker: Address) {
    super(saltSignatureRefused(worker));
    this.worker = worker;
  }
}

export const SECRET_BYTES = 32;

export const SECRET_RULE = `a secret is ${SECRET_BYTES} bytes the worker keeps`;

export const urlTooLong = (bytes: number, max: number, recipients: number): string =>
  `the work url has ${bytes} bytes, but sealed to ${recipients} ${recipients === 1 ? "recipient" : "recipients"} in this announcement it may have at most ${max}, so that the transaction stays within one packet; nothing was sent`;

export class UrlTooLong extends SdkError {
  readonly code = "url-too-long";
  override readonly name = "UrlTooLong";
  readonly bytes: number;
  readonly max: number;
  readonly recipients: number;

  constructor(bytes: number, max: number, recipients: number) {
    super(urlTooLong(bytes, max, recipients));
    this.bytes = bytes;
    this.max = max;
    this.recipients = recipients;
  }
}

export const ACCOUNTS_UNREADABLE = "this transport cannot list engine accounts, so the announcements cannot be read; give it engineAccounts";

export class AnnouncementsUnreadable extends SdkError {
  readonly code = "announcements-unreadable";
  override readonly name = "AnnouncementsUnreadable";
  constructor() {
    super(ACCOUNTS_UNREADABLE);
  }
}

export type RefusalReason = "incomplete" | "key-not-given" | "nothing-opens" | "claim-held";

export type SealedKeyKind = "wallet" | "profile";

export type SealedSlot = { wallet: Address; kind: SealedKeyKind; fingerprint: string; published: boolean };

export type Refusal = {
  reason: RefusalReason;
  announcement?: Address;
  seq?: bigint;
  worker?: Address;
  sealedTo?: readonly SealedSlot[];
  missing?: readonly bigint[];
  closed?: boolean;
  holder?: Address;
};

const slotText = ({ wallet, kind, fingerprint, published }: SealedSlot): string =>
  kind === "wallet" ? `the key derived from ${wallet}'s wallet (${fingerprint})` : `${published ? "the" : "an earlier"} encryption key of ${wallet}'s profile (${fingerprint})`;

export function refusalText(sha256: string, refusal: Refusal): string {
  const at = `announcement ${refusal.announcement ?? "?"} (seq ${refusal.seq ?? "?"}) by ${refusal.worker ?? "?"}`;
  const sealed = (refusal.sealedTo ?? []).map(slotText).join(", ");
  switch (refusal.reason) {
    case "incomplete":
      return refusal.closed === true
        ? `is no longer open or has no delivery book, so its announcements may have been closed and the first worker who announced the work ${sha256} cannot be known; nothing was sent`
        : (refusal.missing ?? []).length > 0
          ? `lists its announcements with seq ${(refusal.missing ?? []).join(", ")} missing, so the first worker who announced the work ${sha256} cannot be known; nothing was sent`
          : `lists a seq twice or past its delivery book's next seq, so the first worker who announced the work ${sha256} cannot be known; nothing was sent`;
    case "key-not-given":
      return `has the earlier ${at} sealed to ${sealed}, which no key given here opens, so the first worker who announced the work ${sha256} cannot be known; pass that key; nothing was sent`;
    case "nothing-opens":
      return `has no announcement that opens to the work ${sha256} with the keys given; nothing was sent`;
    case "claim-held":
      return `is claimed by ${refusal.holder ?? "?"}, not by ${refusal.worker ?? "?"}, who announced the work ${sha256} first in ${refusal.announcement ?? "?"}, so the release would fail; nothing was sent`;
  }
}

export class FirstOpeningRefused extends SdkError {
  readonly code = "first-opening-refused";
  override readonly name = "FirstOpeningRefused";
  readonly intent: Address;
  readonly reason: RefusalReason;
  readonly sha256: string;
  readonly announcement: Address | null;
  readonly seq: bigint | null;
  readonly worker: Address | null;
  readonly sealedTo: readonly SealedSlot[];
  readonly missing: readonly bigint[];
  readonly closed: boolean;
  readonly holder: Address | null;

  constructor(intent: Address, sha256: string, refusal: Refusal) {
    super(`intent ${intent} ${refusalText(sha256, refusal)}`);
    this.intent = intent;
    this.reason = refusal.reason;
    this.sha256 = sha256;
    this.announcement = refusal.announcement ?? null;
    this.seq = refusal.seq ?? null;
    this.worker = refusal.worker ?? null;
    this.sealedTo = refusal.sealedTo ?? [];
    this.missing = refusal.missing ?? [];
    this.closed = refusal.closed ?? false;
    this.holder = refusal.holder ?? null;
  }
}

export class NotRefutable extends SdkError {
  readonly code = "not-refutable";
  override readonly name = "NotRefutable";
  readonly earlier: Address;

  constructor(earlier: Address, reason: string) {
    super(`announcement ${earlier} ${reason}; nothing was sent`);
    this.earlier = earlier;
  }
}

export class BookNotClosable extends SdkError {
  readonly code = "book-not-closable";
  override readonly name = "BookNotClosable";
  readonly intent: Address;

  constructor(intent: Address, reason: string) {
    super(`the delivery book of intent ${intent} ${reason}; nothing was sent`);
    this.intent = intent;
  }
}
