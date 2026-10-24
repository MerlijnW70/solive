import type { Address } from "@solana/kit";
import { NotSettleable } from "./client-errors.js";

export class NotDeliverable extends Error {
  readonly intent: Address;

  constructor(intent: Address, reason: string) {
    super(`intent ${intent} ${reason}`);
    this.name = "NotDeliverable";
    this.intent = intent;
  }
}

export const cannotSignMessages = (worker: Address): string =>
  `the wallet ${worker} cannot sign messages, and an announcement derives its salt and keys from the wallet's own signature over the intent and the work's sha256; announce with a key file, a wallet that signs messages, or 32 secret bytes of your own that you keep; nothing was sent`;

export class NoMessageSigner extends Error {
  readonly worker: Address;

  constructor(worker: Address) {
    super(cannotSignMessages(worker));
    this.name = "NoMessageSigner";
    this.worker = worker;
  }
}

export const saltSignatureRefused = (worker: Address): string =>
  `the salt signature is not ${worker}'s ed25519 signature of the salt message for this intent and sha256; nothing was sent`;

export class BadSaltSignature extends Error {
  readonly worker: Address;

  constructor(worker: Address) {
    super(saltSignatureRefused(worker));
    this.name = "BadSaltSignature";
    this.worker = worker;
  }
}

export const SECRET_BYTES = 32;

export const SECRET_RULE = `a secret is ${SECRET_BYTES} bytes the worker keeps`;

export const urlTooLong = (bytes: number, max: number, recipients: number): string =>
  `the work url has ${bytes} bytes, but sealed to ${recipients} ${recipients === 1 ? "recipient" : "recipients"} in this announcement it may have at most ${max}, so that the transaction stays within one packet; nothing was sent`;

export class UrlTooLong extends RangeError {
  readonly bytes: number;
  readonly max: number;
  readonly recipients: number;

  constructor(bytes: number, max: number, recipients: number) {
    super(urlTooLong(bytes, max, recipients));
    this.name = "UrlTooLong";
    this.bytes = bytes;
    this.max = max;
    this.recipients = recipients;
  }
}

export const ACCOUNTS_UNREADABLE = "this transport cannot list engine accounts, so the announcements cannot be read; give it engineAccounts";

export class AnnouncementsUnreadable extends Error {
  constructor() {
    super(ACCOUNTS_UNREADABLE);
    this.name = "AnnouncementsUnreadable";
  }
}

export type RefusalReason = "incomplete" | "does-not-open" | "key-not-given" | "nothing-opens" | "claim-held";

export type SealedKeyKind = "wallet" | "profile";

export type SealedSlot = { wallet: Address; kind: SealedKeyKind; fingerprint: string; published: boolean };

export type Refusal = {
  reason: RefusalReason;
  announcement?: Address;
  seq?: bigint;
  worker?: Address;
  sealedTo?: readonly SealedSlot[];
  missing?: readonly bigint[];
  holder?: Address;
};

const slotText = ({ wallet, kind, fingerprint, published }: SealedSlot): string =>
  kind === "wallet" ? `the key derived from ${wallet}'s wallet (${fingerprint})` : `${published ? "the" : "an earlier"} encryption key of ${wallet}'s profile (${fingerprint})`;

export function refusalText(sha256: string, refusal: Refusal): string {
  const at = `announcement ${refusal.announcement ?? "?"} (seq ${refusal.seq ?? "?"}) by ${refusal.worker ?? "?"}`;
  const sealed = (refusal.sealedTo ?? []).map(slotText).join(", ");
  switch (refusal.reason) {
    case "incomplete":
      return `lists its announcements with seq ${(refusal.missing ?? []).join(", ")} missing, so the first worker who announced the work ${sha256} cannot be known; nothing was sent`;
    case "does-not-open":
      return `has the earlier ${at} sealed to a key given here, ${sealed}, which does not open it, so the first worker who announced the work ${sha256} cannot be known; nothing was sent`;
    case "key-not-given":
      return `has the earlier ${at} sealed to ${sealed}, which no key given here opens, so the first worker who announced the work ${sha256} cannot be known; pass that key; nothing was sent`;
    case "nothing-opens":
      return `has no announcement that opens to the work ${sha256} with the keys given; nothing was sent`;
    case "claim-held":
      return `is claimed by ${refusal.holder ?? "?"}, not by ${refusal.worker ?? "?"}, who announced the work ${sha256} first in ${refusal.announcement ?? "?"}, so the release would fail; nothing was sent`;
  }
}

export class FirstOpeningRefused extends NotSettleable {
  readonly reason: RefusalReason;
  readonly sha256: string;
  readonly announcement: Address | null;
  readonly seq: bigint | null;
  readonly worker: Address | null;
  readonly sealedTo: readonly SealedSlot[];
  readonly missing: readonly bigint[];
  readonly holder: Address | null;

  constructor(intent: Address, sha256: string, refusal: Refusal) {
    super(intent, refusalText(sha256, refusal));
    this.name = "FirstOpeningRefused";
    this.reason = refusal.reason;
    this.sha256 = sha256;
    this.announcement = refusal.announcement ?? null;
    this.seq = refusal.seq ?? null;
    this.worker = refusal.worker ?? null;
    this.sealedTo = refusal.sealedTo ?? [];
    this.missing = refusal.missing ?? [];
    this.holder = refusal.holder ?? null;
  }
}

export class NotRefutable extends Error {
  readonly earlier: Address;

  constructor(earlier: Address, reason: string) {
    super(`announcement ${earlier} ${reason}; nothing was sent`);
    this.name = "NotRefutable";
    this.earlier = earlier;
  }
}

export class BookNotClosable extends Error {
  readonly intent: Address;

  constructor(intent: Address, reason: string) {
    super(`the delivery book of intent ${intent} ${reason}; nothing was sent`);
    this.name = "BookNotClosable";
    this.intent = intent;
  }
}
