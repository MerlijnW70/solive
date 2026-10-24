import type { Address } from "@solana/kit";
import { ascii, concat, key, sized, u16le } from "./bytes.js";
import type { ClaimSlot } from "./claims.js";
import { IntentCoreError, InvalidInput } from "./errors.js";
import { I64_MAX, I64_MIN } from "./kinds.js";
import { U64_MAX } from "./math.js";

export const COMMITMENT_TAG = ascii("intent-engine-dc");
export const FINGERPRINT_TAG = ascii("intent-engine-fp");
export const BLOB_VERSION = 4;
export const SALT_LEN = 16;
export const FINGERPRINT_LEN = 8;
export const MAX_BLOB_RECIPIENTS = 8;
export const MAX_BLOB_URL = 200;
export const BLOB_HEAD_LEN = 3;
export const BLOB_FIXED_LEN = BLOB_HEAD_LEN + 32 + 32 + SALT_LEN + 16;
export const BLOB_PER_RECIPIENT_LEN = FINGERPRINT_LEN + 32;
export const MAX_SEALED_BLOB = 624;
export const REFUTE_WINDOW_SECS = 30n * 86_400n;
export const MAX_SPLIT_RECIPIENTS = 8;
export const SPLIT_ENTRY_LEN = 34;
export const COMMITMENT_PREIMAGE_LEN = 16 + 32 + 32 + SALT_LEN + 32;
export const FINGERPRINT_PREIMAGE_LEN = 16 + 32;

export function commitmentPreimage(intent: Address, worker: Address, salt: Uint8Array, sha256: Uint8Array): Uint8Array {
  return concat([COMMITMENT_TAG, key(intent), key(worker), sized("salt", salt, SALT_LEN), sized("sha256", sha256, 32)], COMMITMENT_PREIMAGE_LEN);
}

export function fingerprintPreimage(publicKey: Uint8Array): Uint8Array {
  return concat([FINGERPRINT_TAG, sized("publicKey", publicKey, 32)], FINGERPRINT_PREIMAGE_LEN);
}

export type BlobHead = { count: number; mask: number; fps: Uint8Array[]; urlLen: number };

export function blobHead(bytes: Uint8Array): BlobHead {
  if (bytes.length < BLOB_HEAD_LEN) {
    throw new IntentCoreError("BlobMalformed");
  }
  const [version = 0, count = 0, mask = 0] = bytes;
  if (version !== BLOB_VERSION || count === 0 || count > MAX_BLOB_RECIPIENTS || mask >> count !== 0) {
    throw new IntentCoreError("BlobMalformed");
  }
  const url = bytes.length - (BLOB_FIXED_LEN + BLOB_PER_RECIPIENT_LEN * count);
  if (url <= 0 || url > MAX_BLOB_URL || bytes.length > MAX_SEALED_BLOB) {
    throw new IntentCoreError("BlobMalformed");
  }
  const fps = Array.from({ length: MAX_BLOB_RECIPIENTS }, (_, i) => {
    const at = BLOB_HEAD_LEN + FINGERPRINT_LEN * i;
    return i < count ? bytes.slice(at, at + FINGERPRINT_LEN) : new Uint8Array(FINGERPRINT_LEN);
  });
  return { count, mask, fps, urlLen: url };
}

export function mayAnnounce(slot: ClaimSlot, worker: Address): void {
  if (slot.state === "held" && slot.worker !== worker) {
    throw new IntentCoreError("ClaimHeld");
  }
}

export type AnnState = "announced" | "paid";

const ANN_STATES: readonly AnnState[] = ["announced", "paid"];

export function decodeAnnState(byte: number): AnnState {
  const state = Number.isInteger(byte) ? ANN_STATES[byte] : undefined;
  if (state === undefined) {
    throw new IntentCoreError("AnnouncementState");
  }
  return state;
}

export function encodeAnnState(state: AnnState): number {
  return ANN_STATES.indexOf(state);
}

function checkI64(name: string, v: bigint): void {
  if (v < I64_MIN || v > I64_MAX) {
    throw new InvalidInput(name, "range", `${name} ${v} is outside i64`);
  }
}

export function closable(state: AnnState, byWorker: boolean, intentOpen: boolean, now: bigint, expiresAt: bigint, paidAt: bigint): void {
  checkI64("now", now);
  checkI64("expiresAt", expiresAt);
  checkI64("paidAt", paidAt);
  if (state === "announced" && byWorker) {
    if (intentOpen) {
      throw new IntentCoreError("AnnouncementOpen");
    }
    return;
  }
  const edge = (state === "paid" ? paidAt : expiresAt) + REFUTE_WINDOW_SECS;
  if (edge > I64_MAX) {
    throw new IntentCoreError("Overflow");
  }
  if (now < edge) {
    throw new IntentCoreError("AnnouncementRetained");
  }
}

function checkSeq(name: string, v: bigint): void {
  if (v < 0n || v > U64_MAX) {
    throw new InvalidInput(name, "range", `${name} ${v} is outside u64`);
  }
}

export function refutes(earlierSeq: bigint, paidSeq: bigint, earlierWorker: Address, payees: readonly Address[]): void {
  checkSeq("earlierSeq", earlierSeq);
  checkSeq("paidSeq", paidSeq);
  if (earlierSeq >= paidSeq) {
    throw new IntentCoreError("RefuteNotEarlier");
  }
  if (payees.includes(earlierWorker)) {
    throw new IntentCoreError("RefuteSamePayee");
  }
}

export type SplitPreimage = { bytes: Uint8Array; len: number };

export function splitHashPreimage(recipients: readonly Address[], weights: readonly number[]): SplitPreimage {
  const n = recipients.length;
  if (n === 0 || n > MAX_SPLIT_RECIPIENTS || weights.length !== n) {
    throw new IntentCoreError("SplitCountMismatch");
  }
  const len = SPLIT_ENTRY_LEN * n;
  const bytes = new Uint8Array(SPLIT_ENTRY_LEN * MAX_SPLIT_RECIPIENTS);
  bytes.set(concat(recipients.flatMap((wallet, i) => [key(wallet), u16le(weights[i] ?? -1)]), len));
  return { bytes, len };
}
