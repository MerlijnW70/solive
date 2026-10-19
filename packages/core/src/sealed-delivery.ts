import { type Address, getAddressDecoder, getAddressEncoder, isAddress } from "@solana/kit";
import { PRODUCT_SLUG } from "../generated/identity.js";
import { MAX_COMMITTEE_MEMBERS } from "./committee.js";
import { isMemoUrl, isSha256Hex, MAX_MEMO_URL, MEMO_URL_RULE } from "./memo.js";
import { SealedError, wrapKey, x25519PublicOf, x25519SecretOf } from "./sealed.js";

export const DELIVERY_V2_MEMO_PREFIX = `${PRODUCT_SLUG}-delivery2:`;
export const DELIVERY_SCAN_MARK = `${PRODUCT_SLUG}-delivery`;
export const COMMITMENT_TAG = `${PRODUCT_SLUG}-delivery-v2`;
export const SEALED_URL_VERSION = 1;
export const MAX_DELIVERY_V2_MEMO = 960;
export const MAX_SEALED_URL_RECIPIENTS = MAX_COMMITTEE_MEMBERS;

export type DeliveryMemoV2 = { intent: Address; commitment: string; blob: string };

export type Commitment = { intent: Address; worker: Address; sha256: string };

const INFO = new TextEncoder().encode(`${PRODUCT_SLUG}-sealed-url-v1`);
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const WRAPPED_BYTES = KEY_BYTES + TAG_BYTES;
const EPK_BYTES = 32;
const HEAD_BYTES = 2;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const ADDRESS_CHARS = 44;
const FIXED_MEMO = DELIVERY_V2_MEMO_PREFIX.length + ADDRESS_CHARS + 1 + 64 + 1;
const ZERO_IV = new Uint8Array(IV_BYTES);

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));

const fromBase64 = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

const base64Length = (bytes: number): number => 4 * Math.ceil(bytes / 3);

const sealedBytes = (recipients: number, url: number): number => HEAD_BYTES + EPK_BYTES + recipients * WRAPPED_BYTES + IV_BYTES + url + TAG_BYTES;

export function maxSealedUrl(recipients: number): number {
  let url = MAX_MEMO_URL;
  while (url > 0 && FIXED_MEMO + base64Length(sealedBytes(recipients, url)) > MAX_DELIVERY_V2_MEMO) {
    url -= 1;
  }
  return url;
}

export const sealedUrlTooLong = (length: number, recipients: number): string =>
  `the work url has ${length} characters, but sealed to ${recipients} ${recipients === 1 ? "wallet" : "wallets"} it may have at most ${maxSealedUrl(recipients)}, so that the delivery memo stays within ${MAX_DELIVERY_V2_MEMO} bytes and fits one transaction; nothing was sent`;

export function commitmentPreimage({ intent, worker, sha256 }: Commitment): Uint8Array<ArrayBuffer> {
  if (!isSha256Hex(sha256)) {
    throw new RangeError("a commitment binds a sha256 of 64 lowercase hex digits");
  }
  const encoder = getAddressEncoder();
  return Uint8Array.from([
    ...new TextEncoder().encode(COMMITMENT_TAG),
    ...encoder.encode(intent),
    ...encoder.encode(worker),
    ...Array.from({ length: 32 }, (_, i) => Number.parseInt(sha256.slice(2 * i, 2 * i + 2), 16)),
  ]);
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export async function deliveryCommitment(commitment: Commitment): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", commitmentPreimage(commitment))));
}

const random = (length: number): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(new ArrayBuffer(length)));

const aad = (intent: Address): Uint8Array<ArrayBuffer> => Uint8Array.from([...INFO, ...getAddressEncoder().encode(intent)]);

async function sharedWith(peer: Uint8Array, mine: CryptoKey): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", peer.slice(), { name: "X25519" }, false, []);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: key }, mine, 256));
}

export async function sealUrl(url: string, recipients: readonly Address[], intent: Address): Promise<string> {
  const wallets = [...new Set(recipients)];
  if (wallets.length === 0 || wallets.length > MAX_SEALED_URL_RECIPIENTS) {
    throw new SealedError(`seal a work url to between 1 and ${MAX_SEALED_URL_RECIPIENTS} wallets`);
  }
  if (!isMemoUrl(url)) {
    throw new RangeError(`a delivery url must be ${MEMO_URL_RULE}`);
  }
  if (url.length > maxSealedUrl(wallets.length)) {
    throw new RangeError(sealedUrlTooLong(url.length, wallets.length));
  }
  const contentKey = random(KEY_BYTES);
  const iv = random(IV_BYTES);
  const ephemeral = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as unknown as { publicKey: CryptoKey; privateKey: CryptoKey };
  const epk = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));
  const wrapped: number[] = [];
  for (const wallet of wallets) {
    const theirs = x25519PublicOf(wallet);
    const wrapping = await wrapKey(await sharedWith(theirs, ephemeral.privateKey), Uint8Array.from([...epk, ...theirs]), INFO);
    wrapped.push(...new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: ZERO_IV, additionalData: INFO }, wrapping, contentKey)));
  }
  const content = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["encrypt"]);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(intent) }, content, new TextEncoder().encode(url)));
  return toBase64(Uint8Array.from([SEALED_URL_VERSION, wallets.length, ...epk, ...wrapped, ...iv, ...data]));
}

export function sealedUrlRecipients(blob: string): number | null {
  if (!BASE64.test(blob)) {
    return null;
  }
  let bytes: Uint8Array;
  try {
    bytes = fromBase64(blob);
  } catch {
    return null;
  }
  const count = bytes[1] ?? 0;
  if (toBase64(bytes) !== blob || bytes[0] !== SEALED_URL_VERSION || count < 1 || count > MAX_SEALED_URL_RECIPIENTS) {
    return null;
  }
  return bytes.length > sealedBytes(count, 0) ? count : null;
}

export async function openUrl(blob: string, keypair: Uint8Array, intent: Address): Promise<string | null> {
  const count = sealedUrlRecipients(blob);
  if (count === null) {
    return null;
  }
  const bytes = fromBase64(blob);
  const epk = bytes.slice(HEAD_BYTES, HEAD_BYTES + EPK_BYTES);
  const mine = await x25519SecretOf(keypair);
  const ours = x25519PublicOf(getAddressDecoder().decode(keypair.slice(32)));
  let wrapping: CryptoKey;
  try {
    wrapping = await wrapKey(await sharedWith(epk, mine), Uint8Array.from([...epk, ...ours]), INFO);
  } catch {
    return null;
  }
  const keysAt = HEAD_BYTES + EPK_BYTES;
  const ivAt = keysAt + count * WRAPPED_BYTES;
  for (let at = 0; at < count; at += 1) {
    let contentKey: Uint8Array<ArrayBuffer>;
    try {
      const start = keysAt + at * WRAPPED_BYTES;
      contentKey = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: ZERO_IV, additionalData: INFO }, wrapping, bytes.slice(start, start + WRAPPED_BYTES)));
    } catch {
      continue;
    }
    try {
      const content = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["decrypt"]);
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(ivAt, ivAt + IV_BYTES), additionalData: aad(intent) }, content, bytes.slice(ivAt + IV_BYTES));
      const url = new TextDecoder("utf-8", { fatal: true }).decode(plain);
      return isMemoUrl(url) ? url : null;
    } catch {
      return null;
    }
  }
  return null;
}

export function deliveryMemoV2({ intent, commitment, blob }: DeliveryMemoV2): string {
  if (!isAddress(intent)) {
    throw new RangeError("a delivery names its intent by a base58 address");
  }
  if (!isSha256Hex(commitment)) {
    throw new RangeError("a delivery's commitment must be 64 lowercase hex digits");
  }
  if (sealedUrlRecipients(blob) === null) {
    throw new RangeError("a delivery's sealed url must be the base64 a sealUrl call returns");
  }
  const memo = `${DELIVERY_V2_MEMO_PREFIX}${intent}:${commitment}:${blob}`;
  if (memo.length > MAX_DELIVERY_V2_MEMO) {
    throw new RangeError(`a delivery memo may have at most ${MAX_DELIVERY_V2_MEMO} bytes, so that it fits one transaction`);
  }
  return memo;
}

export function parseDeliveryMemoV2(text: string): DeliveryMemoV2 | null {
  if (text.length > MAX_DELIVERY_V2_MEMO || !text.startsWith(DELIVERY_V2_MEMO_PREFIX)) {
    return null;
  }
  const [intent = "", commitment = "", blob = "", ...rest] = text.slice(DELIVERY_V2_MEMO_PREFIX.length).split(":");
  if (rest.length > 0 || !isAddress(intent) || !isSha256Hex(commitment) || sealedUrlRecipients(blob) === null) {
    return null;
  }
  return { intent, commitment, blob };
}
