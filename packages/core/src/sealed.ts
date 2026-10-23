import { type Address, getAddressDecoder, getAddressEncoder } from "@solana/kit";
import type { DeliveryOpener } from "./encryption-key.js";

export const SEALED_VERSION = 2;
export const SEALED_TAG = "solive-sealed";
export const MAX_SEALED_RECIPIENTS = 32;

const INFO = new TextEncoder().encode("solive-sealed-v1");
const LIST_INFO = new TextEncoder().encode(`${SEALED_TAG}-v${SEALED_VERSION}`);
const P = 2n ** 255n - 19n;
const D = (((P - 121665n) % P) * modPow(121666n, P - 2n)) % P;
export const PKCS8_X25519 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]);
const IV_BYTES = 12;
const KEY_BYTES = 32;
const WRAPPED_BYTES = KEY_BYTES + 16;

export const OLD_SEALED = "this file was sealed in an older format, which does not bind its list of wallets; seal it again with this version";

export const SEALED_LIMIT = `a sealed file lists between 1 and ${MAX_SEALED_RECIPIENTS} wallets, each once`;

export class SealedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealedError";
  }
}

export class NotInvited extends SealedError {
  readonly wallet: Address | null;

  constructor(wallet: Address | null) {
    super(wallet === null ? "none of the keys given is one this was sealed to" : `${wallet} is not one of the wallets this was sealed to`);
    this.name = "NotInvited";
    this.wallet = wallet;
  }
}

export type SealRecipient = Address | { wallet: Address; encryptionKey: Uint8Array | null };

type Recipient = { wallet: Address; pk: string; epk: string; iv: string; key: string };
type Envelope = { [SEALED_TAG]: number; to: Recipient[]; iv: string; data: string };

const CHUNK = 0x8000;

function b64(bytes: Uint8Array): string {
  const chunks = Array.from({ length: Math.ceil(bytes.length / CHUNK) }, (_, k) => String.fromCharCode(...bytes.subarray(k * CHUNK, (k + 1) * CHUNK)));
  return btoa(chunks.join(""));
}
const unb64 = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

function b64Of(text: string, length?: number): Uint8Array<ArrayBuffer> | null {
  try {
    const bytes = unb64(text);
    return b64(bytes) === text && (length === undefined || bytes.length === length) ? bytes : null;
  } catch {
    return null;
  }
}

function modPow(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let b = base % P;
  let e = exponent;
  while (e > 0n) {
    if (e & 1n) {
      result = (result * b) % P;
    }
    b = (b * b) % P;
    e >>= 1n;
  }
  return result;
}

function yOf(wallet: Address): { y: bigint; sign: number } {
  const bytes = getAddressEncoder().encode(wallet);
  let y = 0n;
  for (let i = 31; i >= 0; i -= 1) {
    y = (y << 8n) | BigInt(i === 31 ? (bytes[i] ?? 0) & 0x7f : (bytes[i] ?? 0));
  }
  return { y, sign: (bytes[31] ?? 0) >> 7 };
}

export function isOnCurve(wallet: Address): boolean {
  const { y, sign } = yOf(wallet);
  if (y >= P) {
    return false;
  }
  const yy = (y * y) % P;
  const xx = (((yy - 1n + P) % P) * modPow((D * yy + 1n) % P, P - 2n)) % P;
  return xx === 0n ? sign === 0 : modPow(xx, (P - 1n) / 2n) === 1n;
}

export function x25519PublicOf(wallet: Address): Uint8Array<ArrayBuffer> {
  const { y } = yOf(wallet);
  if (y >= P || y === 1n) {
    throw new SealedError(`${wallet} has no encryption key`);
  }
  const u = ((1n + y) * modPow((1n - y + P) % P, P - 2n)) % P;
  return Uint8Array.from({ length: 32 }, (_, i) => Number((u >> BigInt(8 * i)) & 0xffn));
}

export async function x25519SecretOf(keypair: Uint8Array): Promise<CryptoKey> {
  if (keypair.length !== 64) {
    throw new SealedError("a wallet key is 64 bytes: its seed and its public key");
  }
  const hashed = new Uint8Array(await crypto.subtle.digest("SHA-512", keypair.slice(0, 32)));
  return crypto.subtle.importKey("pkcs8", Uint8Array.from([...PKCS8_X25519, ...hashed.slice(0, 32)]), { name: "X25519" }, false, ["deriveBits"]);
}

export async function wrapKey(shared: Uint8Array, salt: Uint8Array, info: Uint8Array = INFO): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", shared.slice(), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: salt.slice(), info: info.slice() }, base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

const random = (length: number): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(new ArrayBuffer(length)));

function targetOf(recipient: SealRecipient): { wallet: Address; pk: Uint8Array<ArrayBuffer> } {
  const [wallet, key] = typeof recipient === "string" ? [recipient, null] : [recipient.wallet, recipient.encryptionKey];
  if (key !== null) {
    if (key.length !== KEY_BYTES) {
      throw new SealedError(`${wallet}'s encryption key is not ${KEY_BYTES} bytes`);
    }
    return { wallet, pk: Uint8Array.from(key) };
  }
  if (!isOnCurve(wallet)) {
    throw new SealedError(`${wallet} is off the ed25519 curve, such as a committee or another program's account, so no key opens what is sealed to it; seal to wallets, or to a committee's members`);
  }
  return { wallet, pk: x25519PublicOf(wallet) };
}

function listData(to: readonly { wallet: Address; pk: Uint8Array }[]): Uint8Array<ArrayBuffer> {
  const encoder = getAddressEncoder();
  return Uint8Array.from([...LIST_INFO, to.length, ...to.flatMap(({ wallet, pk }) => [...encoder.encode(wallet), ...pk])]);
}

export async function seal(plain: Uint8Array, recipients: readonly SealRecipient[]): Promise<Uint8Array> {
  const targets = new Map<Address, { wallet: Address; pk: Uint8Array<ArrayBuffer> }>();
  for (const recipient of recipients) {
    const target = targetOf(recipient);
    if (!targets.has(target.wallet) || (typeof recipient !== "string" && recipient.encryptionKey !== null)) {
      targets.set(target.wallet, target);
    }
  }
  const list = [...targets.values()];
  if (list.length === 0 || list.length > MAX_SEALED_RECIPIENTS) {
    throw new SealedError(`seal to between 1 and ${MAX_SEALED_RECIPIENTS} wallets`);
  }
  const bound = listData(list);
  const contentKey = random(KEY_BYTES);
  const iv = random(IV_BYTES);
  const content = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["encrypt"]);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: bound }, content, plain.slice()));
  const to: Recipient[] = [];
  for (const { wallet, pk } of list) {
    const ephemeral = (await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as unknown as { publicKey: CryptoKey; privateKey: CryptoKey };
    const epk = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));
    let shared: Uint8Array;
    try {
      const peer = await crypto.subtle.importKey("raw", pk, { name: "X25519" }, false, []);
      shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: peer }, ephemeral.privateKey, 256));
    } catch {
      throw new SealedError(`${wallet}'s encryption key cannot be sealed to`);
    }
    const wrapping = await wrapKey(shared, Uint8Array.from([...epk, ...pk]), LIST_INFO);
    const keyIv = random(IV_BYTES);
    const key = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: keyIv, additionalData: bound }, wrapping, contentKey));
    to.push({ wallet, pk: b64(pk), epk: b64(epk), iv: b64(keyIv), key: b64(key) });
  }
  const envelope: Envelope = { [SEALED_TAG]: SEALED_VERSION, to, iv: b64(iv), data: b64(data) };
  return new TextEncoder().encode(`${JSON.stringify(envelope)}\n`);
}

function tagged(bytes: Uint8Array): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) && SEALED_TAG in parsed ? (parsed as Record<string, unknown>) : null;
}

function canonical(wallet: string): boolean {
  try {
    return getAddressDecoder().decode(getAddressEncoder().encode(wallet as Address)) === wallet;
  } catch {
    return false;
  }
}

function recipientOf(entry: unknown): Recipient | null {
  const r = entry as Partial<Recipient> | null;
  if (r === null || typeof r !== "object" || typeof r.wallet !== "string" || typeof r.pk !== "string" || typeof r.epk !== "string" || typeof r.iv !== "string" || typeof r.key !== "string") {
    return null;
  }
  const sized = b64Of(r.pk, KEY_BYTES) !== null && b64Of(r.epk, KEY_BYTES) !== null && b64Of(r.iv, IV_BYTES) !== null && b64Of(r.key, WRAPPED_BYTES) !== null;
  return sized && canonical(r.wallet) ? (r as Recipient) : null;
}

function envelopeOf(bytes: Uint8Array): Envelope {
  const parsed = tagged(bytes);
  if (parsed === null) {
    throw new SealedError("this is not a sealed file");
  }
  if (parsed[SEALED_TAG] !== SEALED_VERSION) {
    throw new SealedError(parsed[SEALED_TAG] === 1 ? OLD_SEALED : "this sealed file has a version this release does not read");
  }
  const { to, iv, data } = parsed;
  if (!Array.isArray(to) || typeof iv !== "string" || typeof data !== "string" || b64Of(iv, IV_BYTES) === null || b64Of(data) === null) {
    throw new SealedError("this sealed file is malformed");
  }
  const recipients = to.map(recipientOf);
  if (recipients.some((r) => r === null)) {
    throw new SealedError("this sealed file is malformed");
  }
  const wallets = new Set(recipients.map((r) => r?.wallet));
  if (to.length === 0 || to.length > MAX_SEALED_RECIPIENTS || wallets.size !== to.length) {
    throw new SealedError(`this sealed file is refused: ${SEALED_LIMIT}`);
  }
  return parsed as Envelope;
}

export const isSealed = (bytes: Uint8Array): boolean => tagged(bytes) !== null;

export function sealedTo(bytes: Uint8Array): Address[] {
  return envelopeOf(bytes).to.map((r) => r.wallet);
}

type Opener = { wallet: Address | null; publicKey: Uint8Array; secret: CryptoKey };

async function openerOf(opener: DeliveryOpener): Promise<Opener> {
  if (!(opener instanceof Uint8Array)) {
    return { wallet: null, ...opener };
  }
  if (opener.length !== 64) {
    throw new SealedError("a wallet key is 64 bytes: its seed and its public key");
  }
  const wallet = getAddressDecoder().decode(opener.slice(32));
  return { wallet, publicKey: x25519PublicOf(wallet), secret: await x25519SecretOf(opener) };
}

const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

async function contentKeyOf(entry: Recipient, opener: Opener, bound: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer> | null> {
  try {
    const epk = unb64(entry.epk);
    const peer = await crypto.subtle.importKey("raw", epk.slice(), { name: "X25519" }, false, []);
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: peer }, opener.secret, 256));
    const wrapping = await wrapKey(shared, Uint8Array.from([...epk, ...opener.publicKey]), LIST_INFO);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(entry.iv), additionalData: bound }, wrapping, unb64(entry.key)));
  } catch {
    return null;
  }
}

export async function unseal(bytes: Uint8Array, given: DeliveryOpener | readonly DeliveryOpener[]): Promise<Uint8Array> {
  const envelope = envelopeOf(bytes);
  const openers = await Promise.all((Array.isArray(given) ? (given as readonly DeliveryOpener[]) : [given as DeliveryOpener]).map(openerOf));
  const bound = listData(envelope.to.map(({ wallet, pk }) => ({ wallet, pk: unb64(pk) })));
  const pairs = openers.flatMap((opener) => envelope.to.filter((entry) => same(unb64(entry.pk), opener.publicKey)).map((entry) => ({ entry, opener })));
  if (pairs.length === 0) {
    const listed = openers.find(({ wallet }) => wallet !== null && envelope.to.some((entry) => entry.wallet === wallet));
    if (listed !== undefined && listed.wallet !== null) {
      throw new SealedError(`this was sealed to another key of ${listed.wallet}, such as the encryption key its profile publishes, not to its wallet key; open it with that encryption key file`);
    }
    throw new NotInvited(openers.length === 1 ? (openers[0]?.wallet ?? null) : null);
  }
  for (const { entry, opener } of pairs) {
    const contentKey = await contentKeyOf(entry, opener, bound);
    if (contentKey === null) {
      continue;
    }
    try {
      const content = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["decrypt"]);
      return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(envelope.iv), additionalData: bound }, content, unb64(envelope.data)));
    } catch {
      break;
    }
  }
  throw new SealedError("the sealed file or its list of wallets was changed, or it was not sealed to this key");
}
