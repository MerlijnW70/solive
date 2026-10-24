import type { Address } from "@solana/kit";
import { PRODUCT_SLUG } from "../generated/identity.js";
import { ascii, key } from "./bytes.js";
import {
  BLOB_FIXED_LEN,
  BLOB_HEAD_LEN,
  BLOB_PER_RECIPIENT_LEN,
  BLOB_VERSION,
  blobHead,
  FINGERPRINT_LEN,
  fingerprintPreimage,
  MAX_BLOB_RECIPIENTS,
  MAX_BLOB_URL,
  SALT_LEN,
} from "./delivery.js";
import { type DeliveryOpener, deliveryKeyOf, isUsableKey } from "./encryption-key.js";
import { isMemoUrl, isSha256Hex, MEMO_URL_RULE } from "./memo.js";
import { PKCS8_X25519, type SealRecipient, SealedError, x25519PublicOf } from "./sealed.js";
import { InvalidInput } from "./errors.js";

export const SALT_TAG = `${PRODUCT_SLUG}-delivery-salt-v3`;
export const KC_TAG = ascii("intent-engine-kc");
export const WRAP_INFO = ascii("intent-engine-wk");
export const BLOB_INFO = ascii("intent-engine-bl");
export const ESK_TAG = ascii("intent-engine-ek");
export const CK_TAG = ascii("intent-engine-ck");
export const SIGNATURE_SOURCE_LEN = 64;
export const RANDOM_SOURCE_LEN = 32;
export const CONTENT_KEY_LEN = 32;
export const ESK_LEN = 32;
export const EPK_LEN = 32;
export const KC_LEN = 32;
export const WRAPPED_LEN = 32;

export type DeliverySecrets = {
  source: Uint8Array;
  url: string;
  recipients: readonly SealRecipient[];
  binding: Uint8Array;
  salt: Uint8Array;
  esk: Uint8Array;
  key: Uint8Array;
};

export type SecretSource = Pick<DeliverySecrets, "source" | "url" | "recipients">;

export type OpenedDelivery = { salt: Uint8Array; url: string; key: Uint8Array };

export type BlobLayout = { count: number; epk: number; kc: number; wrapped: number; ct: number; length: number };

type Parsed = BlobLayout & { mask: number };

type Recipient = { key: Uint8Array<ArrayBuffer>; profile: boolean };

const SALT_HEX = /^[0-9a-f]{32}$/;
const IV = new Uint8Array(12);
const BASE_POINT = Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 9 : 0));

const bytesOf = (parts: readonly ArrayLike<number>[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const sha256 = async (parts: readonly ArrayLike<number>[]): Promise<Uint8Array<ArrayBuffer>> =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", bytesOf(parts)));

const equal = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((byte, i) => byte === b[i]);

const xor = (a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> => Uint8Array.from(a, (byte, i) => byte ^ (b[i] ?? 0));

const hexBytes = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(text.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));

export const isSaltHex = (text: string): boolean => SALT_HEX.test(text);

export function saltMessage(intent: Address, sha256: string): Uint8Array<ArrayBuffer> {
  if (!isSha256Hex(sha256)) {
    throw new InvalidInput("sha256", "format", "a salt binds a sha256 of 64 lowercase hex digits");
  }
  return bytesOf([ascii(SALT_TAG), key(intent), hexBytes(sha256)]);
}

export const sealedBlobLength = (recipients: number, urlBytes: number): number => BLOB_FIXED_LEN + BLOB_PER_RECIPIENT_LEN * recipients + urlBytes;

export function blobLayout(count: number, length: number): BlobLayout {
  const epk = BLOB_HEAD_LEN + FINGERPRINT_LEN * count;
  const kc = epk + EPK_LEN;
  const wrapped = kc + KC_LEN;
  return { count, epk, kc, wrapped, ct: wrapped + WRAPPED_LEN * count, length };
}

export function clampScalar(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = Uint8Array.from(bytes);
  out[0] = (out[0] ?? 0) & 248;
  out[31] = ((out[31] ?? 0) & 127) | 64;
  return out;
}

export const keyCommitment = (contentKey: Uint8Array): Promise<Uint8Array<ArrayBuffer>> => sha256([KC_TAG, contentKey]);

export async function keyFingerprintV4(publicKey: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return (await sha256([fingerprintPreimage(publicKey)])).slice(0, FINGERPRINT_LEN);
}

const urlBytesOf = (url: string): Uint8Array<ArrayBuffer> => {
  if (!isMemoUrl(url)) {
    throw new InvalidInput("url", "format", `a delivery url must be ${MEMO_URL_RULE}`);
  }
  const bytes = new TextEncoder().encode(url);
  if (bytes.length > MAX_BLOB_URL) {
    throw new InvalidInput("url", "length", `a sealed delivery url may have at most ${MAX_BLOB_URL} bytes`);
  }
  return bytes;
};

export async function recipientBinding(recipients: readonly SealRecipient[]): Promise<Uint8Array<ArrayBuffer>> {
  return bindingOf(recipientsOf(recipients));
}

async function bindingOf(listed: readonly Recipient[]): Promise<Uint8Array<ArrayBuffer>> {
  const mask = listed.reduce((m, r, i) => (r.profile ? m | (1 << i) : m), 0);
  const fps = await Promise.all(listed.map((r) => keyFingerprintV4(r.key)));
  return bytesOf([[listed.length, mask], ...fps]);
}

export async function deliverySecrets(url: string, recipients: readonly SealRecipient[], source?: Uint8Array): Promise<DeliverySecrets> {
  const urlBytes = urlBytesOf(url);
  const binding = await recipientBinding(recipients);
  const kept = source === undefined ? crypto.getRandomValues(new Uint8Array(RANDOM_SOURCE_LEN)) : Uint8Array.from(source);
  if (kept.length !== SIGNATURE_SOURCE_LEN && kept.length !== RANDOM_SOURCE_LEN) {
    throw new InvalidInput("source", "length", `delivery secrets come from a ${SIGNATURE_SOURCE_LEN}-byte salt signature or ${RANDOM_SOURCE_LEN} kept random bytes`);
  }
  const [salt, esk, contentKey] = await Promise.all([
    sha256([ascii(SALT_TAG), kept]),
    sha256([ESK_TAG, kept, urlBytes, binding]),
    sha256([CK_TAG, kept, urlBytes, binding]),
  ]);
  return { source: kept, url, recipients: [...recipients], binding, salt: salt.slice(0, SALT_LEN), esk: clampScalar(esk), key: contentKey };
}

const importSecret = (scalar: Uint8Array): Promise<CryptoKey> =>
  crypto.subtle.importKey("pkcs8", bytesOf([PKCS8_X25519, scalar]), { name: "X25519" }, false, ["deriveBits"]);

async function exchange(secret: CryptoKey, peer: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const pub = await crypto.subtle.importKey("raw", Uint8Array.from(peer), { name: "X25519" }, false, []);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: pub }, secret, 256));
}

export async function ephemeralPublic(esk: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  if (esk.length !== ESK_LEN) {
    throw new InvalidInput("ephemeralSecret", "length", `an ephemeral secret is ${ESK_LEN} bytes`);
  }
  return exchange(await importSecret(esk), BASE_POINT);
}

async function wrapPad(shared: Uint8Array, epk: Uint8Array, recipientKey: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const base = await crypto.subtle.importKey("raw", Uint8Array.from(shared), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: bytesOf([epk, recipientKey]), info: WRAP_INFO }, base, 256));
}

const aadOf = (intent: Address, worker: Address, blob: Uint8Array, layout: BlobLayout): Uint8Array<ArrayBuffer> =>
  bytesOf([BLOB_INFO, key(intent), key(worker), blob.subarray(0, layout.wrapped)]);

function recipientsOf(recipients: readonly SealRecipient[]): Recipient[] {
  if (recipients.length === 0 || recipients.length > MAX_BLOB_RECIPIENTS) {
    throw new SealedError(`seal a delivery to between 1 and ${MAX_BLOB_RECIPIENTS} recipients`);
  }
  const wallets = new Set<Address>();
  return recipients.map((recipient) => {
    const [wallet, profileKey] = typeof recipient === "string" ? [recipient, null] : [recipient.wallet, recipient.encryptionKey];
    if (wallets.has(wallet)) {
      throw new SealedError(`${wallet} is listed twice; each recipient holds one slot`);
    }
    wallets.add(wallet);
    if (profileKey === null) {
      return { key: x25519PublicOf(wallet), profile: false };
    }
    if (!isUsableKey(profileKey)) {
      throw new SealedError(`${wallet}'s encryption key is not a usable X25519 public key`);
    }
    return { key: Uint8Array.from(profileKey), profile: true };
  });
}

export async function sealDeliveryV4(from: SecretSource, intent: Address, worker: Address): Promise<Uint8Array<ArrayBuffer>> {
  const secrets = await deliverySecrets(from.url, from.recipients, from.source);
  const urlBytes = urlBytesOf(secrets.url);
  const listed = recipientsOf(secrets.recipients);
  const count = listed.length;
  const layout = blobLayout(count, sealedBlobLength(count, urlBytes.length));
  const blob = new Uint8Array(layout.length);
  blob.set([BLOB_VERSION, ...secrets.binding]);
  const esk = await importSecret(secrets.esk);
  const epk = await exchange(esk, BASE_POINT);
  blob.set(epk, layout.epk);
  blob.set(await keyCommitment(secrets.key), layout.kc);
  for (const [i, r] of listed.entries()) {
    let shared: Uint8Array;
    try {
      shared = await exchange(esk, r.key);
    } catch {
      throw new SealedError(`recipient ${i} has a key no shared secret can be made with`);
    }
    blob.set(xor(secrets.key, await wrapPad(shared, epk, r.key)), layout.wrapped + WRAPPED_LEN * i);
  }
  const content = await crypto.subtle.importKey("raw", Uint8Array.from(secrets.key), "AES-GCM", false, ["encrypt"]);
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv: IV, additionalData: aadOf(intent, worker, blob, layout) }, content, bytesOf([secrets.salt, urlBytes]));
  blob.set(new Uint8Array(sealed), layout.ct);
  return blob;
}

function layoutOf(blob: Uint8Array): Parsed | null {
  try {
    const head = blobHead(blob);
    return { ...blobLayout(head.count, blob.length), mask: head.mask };
  } catch {
    return null;
  }
}

const commitmentOf = (blob: Uint8Array, layout: BlobLayout): Uint8Array => blob.subarray(layout.kc, layout.kc + KC_LEN);

async function decrypted(blob: Uint8Array, layout: BlobLayout, contentKey: Uint8Array, intent: Address, worker: Address): Promise<OpenedDelivery | null> {
  let plain: Uint8Array;
  try {
    const content = await crypto.subtle.importKey("raw", Uint8Array.from(contentKey), "AES-GCM", false, ["decrypt"]);
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: IV, additionalData: aadOf(intent, worker, blob, layout) }, content, blob.slice(layout.ct)));
  } catch {
    return null;
  }
  let url: string;
  try {
    url = new TextDecoder("utf-8", { fatal: true }).decode(plain.subarray(SALT_LEN));
  } catch {
    return null;
  }
  return isMemoUrl(url) ? { salt: plain.slice(0, SALT_LEN), url, key: Uint8Array.from(contentKey) } : null;
}

const slotOf = (blob: Uint8Array, layout: BlobLayout, i: number) => ({
  fp: blob.subarray(BLOB_HEAD_LEN + FINGERPRINT_LEN * i, BLOB_HEAD_LEN + FINGERPRINT_LEN * (i + 1)),
  wrapped: blob.subarray(layout.wrapped + WRAPPED_LEN * i, layout.wrapped + WRAPPED_LEN * (i + 1)),
});

export async function openWithContentKey(blob: Uint8Array, contentKey: Uint8Array, intent: Address, worker: Address): Promise<OpenedDelivery | null> {
  const layout = layoutOf(blob);
  if (layout === null || contentKey.length !== CONTENT_KEY_LEN || !equal(await keyCommitment(contentKey), commitmentOf(blob, layout))) {
    return null;
  }
  return decrypted(blob, layout, contentKey, intent, worker);
}

export async function openDeliveryV4(blob: Uint8Array, opener: DeliveryOpener, intent: Address, worker: Address): Promise<OpenedDelivery | null> {
  const layout = layoutOf(blob);
  if (layout === null) {
    return null;
  }
  const { publicKey, secret } = await deliveryKeyOf(opener);
  const fp = await keyFingerprintV4(publicKey);
  const epk = blob.slice(layout.epk, layout.epk + EPK_LEN);
  const kc = commitmentOf(blob, layout);
  const ours = Array.from({ length: layout.count }, (_, i) => slotOf(blob, layout, i)).filter((slot) => equal(slot.fp, fp));
  if (ours.length === 0) {
    return null;
  }
  let pad: Uint8Array;
  try {
    pad = await wrapPad(await exchange(secret, epk), epk, publicKey);
  } catch {
    return null;
  }
  const keys = ours.map((slot) => xor(slot.wrapped, pad));
  const commitments = await Promise.all(keys.map((k) => keyCommitment(k)));
  const [contentKey] = keys;
  if (contentKey === undefined || commitments.some((c) => !equal(c, kc))) {
    return null;
  }
  return decrypted(blob, layout, contentKey, intent, worker);
}

export async function openWithEsk(
  blob: Uint8Array,
  esk: Uint8Array,
  recipients: readonly SealRecipient[],
  intent: Address,
  worker: Address,
): Promise<OpenedDelivery | null> {
  const layout = layoutOf(blob);
  if (layout === null || esk.length !== ESK_LEN || recipients.length !== layout.count) {
    return null;
  }
  let listed: Recipient[];
  let secret: CryptoKey;
  let epk: Uint8Array<ArrayBuffer>;
  try {
    listed = recipientsOf(recipients);
    secret = await importSecret(esk);
    epk = await exchange(secret, BASE_POINT);
  } catch {
    return null;
  }
  if (!equal(epk, blob.subarray(layout.epk, layout.epk + EPK_LEN))) {
    return null;
  }
  const kc = commitmentOf(blob, layout);
  let contentKey: Uint8Array | null = null;
  for (const [i, r] of listed.entries()) {
    const slot = slotOf(blob, layout, i);
    if (((layout.mask >> i) & 1) !== Number(r.profile) || !equal(slot.fp, await keyFingerprintV4(r.key))) {
      return null;
    }
    let pad: Uint8Array;
    try {
      pad = await wrapPad(await exchange(secret, r.key), epk, r.key);
    } catch {
      return null;
    }
    const unwrapped = xor(slot.wrapped, pad);
    if (!equal(await keyCommitment(unwrapped), kc) || (contentKey !== null && !equal(contentKey, unwrapped))) {
      return null;
    }
    contentKey = unwrapped;
  }
  return contentKey === null ? null : decrypted(blob, layout, contentKey, intent, worker);
}
