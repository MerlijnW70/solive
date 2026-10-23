import { type Address, getAddressEncoder, getBase58Encoder, isAddress } from "@solana/kit";
import { PRODUCT_SLUG } from "../generated/identity.js";
import { MAX_COMMITTEE_MEMBERS } from "./committee.js";
import { isMemoUrl, isSha256Hex, MAX_MEMO_URL, MEMO_URL_RULE } from "./memo.js";
import { type DeliveryOpener, deliveryKeyOf, ENCRYPTION_KEY_BYTES } from "./encryption-key.js";
import { type SealRecipient, SealedError, wrapKey, x25519PublicOf } from "./sealed.js";

export const DELIVERY_MEMO_MARK = `${PRODUCT_SLUG}-delivery3`;
export const DELIVERY_MEMO_PREFIX = `${DELIVERY_MEMO_MARK}:`;
export const OPENING_MEMO_PREFIX = `${DELIVERY_MEMO_MARK}-open:`;
export const COMMITMENT_TAG = `${PRODUCT_SLUG}-delivery-v3`;
export const SALT_TAG = `${PRODUCT_SLUG}-delivery-salt-v3`;
export const SALT_CHECK_TAG = `${PRODUCT_SLUG}-delivery-check-v3`;
export const SALT_BYTES = 16;
export const SEALED_URL_VERSION = 3;
export const MAX_DELIVERY_MEMO = 960;
export const MAX_OPENING_MEMO = MAX_DELIVERY_MEMO;
export const MAX_SEALED_URL_RECIPIENTS = MAX_COMMITTEE_MEMBERS;
export const UNOPENED = "-";

export type DeliveryMemo = { intent: Address; commitment: string; check: string; blob: string };

export type Commitment = { intent: Address; worker: Address; salt: string; sha256: string };

export type SealedDelivery = { salt: string; url: string };

export type JudgeOpening = { intent: Address; salts: (string | null)[] };

export type SelfOpening = { intent: Address; announcement: string; salt: string };

export type Opening = JudgeOpening | SelfOpening;

export type SealedKey = "wallet" | "profile";

const INFO = new TextEncoder().encode(`${PRODUCT_SLUG}-sealed-url-v2`);
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const WRAPPED_BYTES = KEY_BYTES + TAG_BYTES;
const EPK_BYTES = 32;
const HEAD_BYTES = 3;
export const FINGERPRINT_BYTES = 8;
export const FINGERPRINT_TAG = `${PRODUCT_SLUG}-delivery-key-v3`;
const SIGNATURE_BYTES = 64;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const SALT_HEX = /^[0-9a-f]{32}$/;
const BASE58_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const ADDRESS_CHARS = 44;
const MEMO_SEPARATORS = 3;
const FIXED_MEMO = DELIVERY_MEMO_PREFIX.length + ADDRESS_CHARS + MEMO_SEPARATORS + 64 + 2 * SALT_BYTES;
const OPENED_CHARS = 2 * SALT_BYTES + 1;
const ZERO_IV = new Uint8Array(IV_BYTES);

export const MAX_OPENED_SALTS = Math.floor((MAX_OPENING_MEMO - OPENING_MEMO_PREFIX.length - ADDRESS_CHARS) / OPENED_CHARS);

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

const fromBase64 = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

const base64Length = (bytes: number): number => 4 * Math.ceil(bytes / 3);

const headBytes = (recipients: number): number => HEAD_BYTES + recipients * FINGERPRINT_BYTES;

const sealedBytes = (recipients: number, url: number, head = headBytes(recipients)): number =>
  head + EPK_BYTES + recipients * WRAPPED_BYTES + IV_BYTES + SALT_BYTES + url + TAG_BYTES;

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

const unhex = (text: string): number[] => Array.from({ length: text.length / 2 }, (_, i) => Number.parseInt(text.slice(2 * i, 2 * i + 2), 16));

const digest = async (bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));

const SALT_RULE = `${2 * SALT_BYTES} lowercase hex digits`;

export const isSaltHex = (text: string): boolean => SALT_HEX.test(text);

export function maxSealedUrl(recipients: number): number {
  let url = MAX_MEMO_URL;
  while (url > 0 && FIXED_MEMO + base64Length(sealedBytes(recipients, url)) > MAX_DELIVERY_MEMO) {
    url -= 1;
  }
  return url;
}

export const sealedUrlTooLong = (length: number, recipients: number): string =>
  `the work url has ${length} characters, but sealed to ${recipients} ${recipients === 1 ? "wallet" : "wallets"} it may have at most ${maxSealedUrl(recipients)}, so that the delivery memo stays within ${MAX_DELIVERY_MEMO} bytes and fits one transaction; nothing was sent`;

export function saltMessage(intent: Address, sha256: string): Uint8Array<ArrayBuffer> {
  if (!isSha256Hex(sha256)) {
    throw new RangeError("a salt binds a sha256 of 64 lowercase hex digits");
  }
  return Uint8Array.from([...new TextEncoder().encode(SALT_TAG), ...getAddressEncoder().encode(intent), ...unhex(sha256)]);
}

export function saltPreimage(signature: Uint8Array): Uint8Array<ArrayBuffer> {
  if (signature.length !== SIGNATURE_BYTES) {
    throw new RangeError(`a salt is derived from a ${SIGNATURE_BYTES}-byte ed25519 signature`);
  }
  return Uint8Array.from([...new TextEncoder().encode(SALT_TAG), ...signature]);
}

export async function saltOfSignature(signature: Uint8Array): Promise<string> {
  return hex((await digest(saltPreimage(signature))).slice(0, SALT_BYTES));
}

export function saltCheckPreimage(salt: string): Uint8Array<ArrayBuffer> {
  if (!isSaltHex(salt)) {
    throw new RangeError(`a salt is ${SALT_RULE}`);
  }
  return Uint8Array.from([...new TextEncoder().encode(SALT_CHECK_TAG), ...unhex(salt)]);
}

export async function saltCheck(salt: string): Promise<string> {
  return hex((await digest(saltCheckPreimage(salt))).slice(0, SALT_BYTES));
}

export function commitmentPreimage({ intent, worker, salt, sha256 }: Commitment): Uint8Array<ArrayBuffer> {
  if (!isSha256Hex(sha256)) {
    throw new RangeError("a commitment binds a sha256 of 64 lowercase hex digits");
  }
  if (!isSaltHex(salt)) {
    throw new RangeError(`a commitment binds a salt of ${SALT_RULE}`);
  }
  const encoder = getAddressEncoder();
  return Uint8Array.from([...new TextEncoder().encode(COMMITMENT_TAG), ...encoder.encode(intent), ...encoder.encode(worker), ...unhex(salt), ...unhex(sha256)]);
}

export async function deliveryCommitment(commitment: Commitment): Promise<string> {
  return hex(await digest(commitmentPreimage(commitment)));
}

const random = (length: number): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(new ArrayBuffer(length)));

const aad = (intent: Address, head: Uint8Array): Uint8Array<ArrayBuffer> => Uint8Array.from([...INFO, ...getAddressEncoder().encode(intent), ...head]);

type Layout = { head: number; count: number; mask: number };

export async function keyFingerprint(publicKey: Uint8Array): Promise<string> {
  return hex((await digest(Uint8Array.from([...new TextEncoder().encode(FINGERPRINT_TAG), ...publicKey]))).slice(0, FINGERPRINT_BYTES));
}

function recipientsOf(recipients: readonly SealRecipient[]): Map<Address, Uint8Array | null> {
  const keys = new Map<Address, Uint8Array | null>();
  for (const recipient of recipients) {
    const [wallet, key] = typeof recipient === "string" ? [recipient, null] : [recipient.wallet, recipient.encryptionKey];
    if (key !== null && key.length !== ENCRYPTION_KEY_BYTES) {
      throw new SealedError(`${wallet}'s encryption key is not ${ENCRYPTION_KEY_BYTES} bytes`);
    }
    if (!keys.has(wallet) || (keys.get(wallet) === null && key !== null)) {
      keys.set(wallet, key);
    }
  }
  return keys;
}

async function sharedWith(peer: Uint8Array, mine: CryptoKey): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", peer.slice(), { name: "X25519" }, false, []);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: key }, mine, 256));
}

export async function sealDelivery({ salt, url }: SealedDelivery, recipients: readonly SealRecipient[], intent: Address): Promise<string> {
  const keys = recipientsOf(recipients);
  const wallets = [...keys.keys()];
  if (wallets.length === 0 || wallets.length > MAX_SEALED_URL_RECIPIENTS) {
    throw new SealedError(`seal a work url to between 1 and ${MAX_SEALED_URL_RECIPIENTS} wallets`);
  }
  if (!isSaltHex(salt)) {
    throw new RangeError(`a sealed delivery carries a salt of ${SALT_RULE}`);
  }
  if (!isMemoUrl(url)) {
    throw new RangeError(`a delivery url must be ${MEMO_URL_RULE}`);
  }
  if (url.length > maxSealedUrl(wallets.length)) {
    throw new RangeError(sealedUrlTooLong(url.length, wallets.length));
  }
  const contentKey = random(KEY_BYTES);
  const iv = random(IV_BYTES);
  const ephemeral = (await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as unknown as { publicKey: CryptoKey; privateKey: CryptoKey };
  const epk = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));
  const wrapped: number[] = [];
  let mask = 0;
  const fingerprints: number[] = [];
  for (const [at, wallet] of wallets.entries()) {
    const profileKey = keys.get(wallet) ?? null;
    const usable = profileKey === null ? null : await sharedWith(profileKey, ephemeral.privateKey).catch(() => null);
    const theirs = profileKey === null || usable === null ? x25519PublicOf(wallet) : Uint8Array.from(profileKey);
    mask |= usable === null ? 0 : 1 << at;
    fingerprints.push(...unhex(await keyFingerprint(theirs)));
    const wrapping = await wrapKey(usable ?? (await sharedWith(theirs, ephemeral.privateKey)), Uint8Array.from([...epk, ...theirs]), INFO);
    wrapped.push(...new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: ZERO_IV, additionalData: INFO }, wrapping, contentKey)));
  }
  const content = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["encrypt"]);
  const plain = Uint8Array.from([...unhex(salt), ...new TextEncoder().encode(url)]);
  const head = Uint8Array.from([SEALED_URL_VERSION, wallets.length, mask, ...fingerprints]);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(intent, head) }, content, plain));
  return toBase64(Uint8Array.from([...head, ...epk, ...wrapped, ...iv, ...data]));
}

function layoutOf(blob: string): Layout | null {
  if (!BASE64.test(blob)) {
    return null;
  }
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(blob);
  } catch {
    return null;
  }
  const version = bytes[0];
  const count = bytes[1] ?? 0;
  const head = headBytes(count);
  const mask = bytes[2] ?? 0;
  if (toBase64(bytes) !== blob || version !== SEALED_URL_VERSION || count < 1 || count > MAX_SEALED_URL_RECIPIENTS || mask >> count !== 0) {
    return null;
  }
  return bytes.length > sealedBytes(count, 0, head) ? { head, count, mask } : null;
}

export function sealedUrlRecipients(blob: string): number | null {
  return layoutOf(blob)?.count ?? null;
}

export function sealedKeys(blob: string): SealedKey[] | null {
  const layout = layoutOf(blob);
  return layout === null ? null : Array.from({ length: layout.count }, (_, at): SealedKey => ((layout.mask >> at) & 1 ? "profile" : "wallet"));
}

export function sealedFingerprints(blob: string): string[] | null {
  const layout = layoutOf(blob);
  if (layout === null) {
    return null;
  }
  const bytes = fromBase64(blob);
  return Array.from({ length: layout.count }, (_, at) => hex(bytes.slice(HEAD_BYTES + at * FINGERPRINT_BYTES, HEAD_BYTES + (at + 1) * FINGERPRINT_BYTES)));
}

export async function openDelivery(blob: string, opener: DeliveryOpener, intent: Address): Promise<SealedDelivery | null> {
  const layout = layoutOf(blob);
  if (layout === null) {
    return null;
  }
  const { head, count } = layout;
  const bytes = fromBase64(blob);
  const epk = bytes.slice(head, head + EPK_BYTES);
  const { publicKey: ours, secret: mine } = await deliveryKeyOf(opener);
  let wrapping: CryptoKey;
  try {
    wrapping = await wrapKey(await sharedWith(epk, mine), Uint8Array.from([...epk, ...ours]), INFO);
  } catch {
    return null;
  }
  const keysAt = head + EPK_BYTES;
  const ivAt = keysAt + count * WRAPPED_BYTES;
  for (const start of Array.from({ length: count }, (_, at) => keysAt + at * WRAPPED_BYTES)) {
    let contentKey: Uint8Array<ArrayBuffer>;
    try {
      contentKey = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: ZERO_IV, additionalData: INFO }, wrapping, bytes.slice(start, start + WRAPPED_BYTES)));
    } catch {
      continue;
    }
    try {
      const content = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["decrypt"]);
      const iv = bytes.slice(ivAt, ivAt + IV_BYTES);
      const plain = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad(intent, bytes.slice(0, head)) }, content, bytes.slice(ivAt + IV_BYTES)));
      const url = new TextDecoder().decode(plain.slice(SALT_BYTES));
      return isMemoUrl(url) ? { salt: hex(plain.slice(0, SALT_BYTES)), url } : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function deliveryMemo({ intent, commitment, check, blob }: DeliveryMemo): string {
  if (!isAddress(intent)) {
    throw new RangeError("a delivery names its intent by a base58 address");
  }
  if (!isSha256Hex(commitment)) {
    throw new RangeError("a delivery's commitment must be 64 lowercase hex digits");
  }
  if (!isSaltHex(check)) {
    throw new RangeError(`a delivery's salt check must be ${SALT_RULE}`);
  }
  if (sealedUrlRecipients(blob) === null) {
    throw new RangeError("a delivery's sealed url must be the base64 a sealDelivery call returns");
  }
  const memo = `${DELIVERY_MEMO_PREFIX}${intent}:${commitment}:${check}:${blob}`;
  if (memo.length > MAX_DELIVERY_MEMO) {
    throw new RangeError(`a delivery memo may have at most ${MAX_DELIVERY_MEMO} bytes, so that it fits one transaction`);
  }
  return memo;
}

export function parseDeliveryMemo(text: string): DeliveryMemo | null {
  if (text.length > MAX_DELIVERY_MEMO || !text.startsWith(DELIVERY_MEMO_PREFIX)) {
    return null;
  }
  const [intent = "", commitment = "", check = "", blob = "", ...rest] = text.slice(DELIVERY_MEMO_PREFIX.length).split(":");
  if (rest.length > 0 || !isAddress(intent) || !isSha256Hex(commitment) || !isSaltHex(check) || !BASE64.test(blob)) {
    return null;
  }
  return { intent, commitment, check, blob };
}

export function isSignatureText(text: string): boolean {
  return BASE58_SIGNATURE.test(text) && getBase58Encoder().encode(text).length === SIGNATURE_BYTES;
}

export function openingMemo(opening: Opening): string {
  if (!isAddress(opening.intent)) {
    throw new RangeError("an opening names its intent by a base58 address");
  }
  if ("announcement" in opening) {
    if (!isSignatureText(opening.announcement) || !isSaltHex(opening.salt)) {
      throw new RangeError(`an opening names its announcement by a base58 signature and gives its salt as ${SALT_RULE}`);
    }
    return `${OPENING_MEMO_PREFIX}${opening.intent}:${opening.announcement}:${opening.salt}`;
  }
  const { salts } = opening;
  if (salts.length === 0 || salts.length > MAX_OPENED_SALTS || salts.some((salt) => salt !== null && !isSaltHex(salt))) {
    throw new RangeError(`an opening lists from 1 to ${MAX_OPENED_SALTS} salts, each ${SALT_RULE} or ${UNOPENED} for one it could not open`);
  }
  return `${OPENING_MEMO_PREFIX}${opening.intent}:${salts.map((salt) => salt ?? UNOPENED).join(",")}`;
}

export function parseOpeningMemo(text: string): Opening | null {
  if (!text.startsWith(OPENING_MEMO_PREFIX)) {
    return null;
  }
  const [intent = "", first = "", second, ...rest] = text.slice(OPENING_MEMO_PREFIX.length).split(":");
  if (rest.length > 0 || !isAddress(intent)) {
    return null;
  }
  if (second !== undefined) {
    return isSignatureText(first) && isSaltHex(second) ? { intent, announcement: first, salt: second } : null;
  }
  const listed = first.split(",");
  if (listed.length > MAX_OPENED_SALTS || listed.some((salt) => salt !== UNOPENED && !isSaltHex(salt))) {
    return null;
  }
  return { intent, salts: listed.map((salt) => (salt === UNOPENED ? null : salt)) };
}
