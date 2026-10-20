import { type Address, getAddressDecoder, getAddressEncoder } from "@solana/kit";

export const SEALED_VERSION = 1;
export const SEALED_TAG = "solive-sealed";
export const MAX_SEALED_RECIPIENTS = 32;

const INFO = new TextEncoder().encode("solive-sealed-v1");
const P = 2n ** 255n - 19n;
export const PKCS8_X25519 = Uint8Array.from([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e, 0x04, 0x22, 0x04, 0x20]);
const IV_BYTES = 12;
const KEY_BYTES = 32;

export class SealedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SealedError";
  }
}

export class NotInvited extends SealedError {
  readonly wallet: Address;

  constructor(wallet: Address) {
    super(`${wallet} is not one of the wallets this was sealed to`);
    this.name = "NotInvited";
    this.wallet = wallet;
  }
}

type Recipient = { wallet: Address; epk: string; iv: string; key: string };
type Envelope = { [SEALED_TAG]: number; to: Recipient[]; iv: string; data: string };

const CHUNK = 0x8000;

function b64(bytes: Uint8Array): string {
  const chunks = Array.from({ length: Math.ceil(bytes.length / CHUNK) }, (_, k) => String.fromCharCode(...bytes.subarray(k * CHUNK, (k + 1) * CHUNK)));
  return btoa(chunks.join(""));
}
const unb64 = (text: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

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

export function x25519PublicOf(wallet: Address): Uint8Array<ArrayBuffer> {
  const bytes = getAddressEncoder().encode(wallet);
  let y = 0n;
  for (let i = 31; i >= 0; i -= 1) {
    y = (y << 8n) | BigInt(i === 31 ? (bytes[i] ?? 0) & 0x7f : (bytes[i] ?? 0));
  }
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

export async function seal(plain: Uint8Array, recipients: readonly Address[]): Promise<Uint8Array> {
  const wallets = [...new Set(recipients)];
  if (wallets.length === 0 || wallets.length > MAX_SEALED_RECIPIENTS) {
    throw new SealedError(`seal to between 1 and ${MAX_SEALED_RECIPIENTS} wallets`);
  }
  const contentKey = random(KEY_BYTES);
  const iv = random(IV_BYTES);
  const content = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["encrypt"]);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: INFO }, content, plain.slice()));
  const to: Recipient[] = [];
  for (const wallet of wallets) {
    const theirs = x25519PublicOf(wallet);
    const ephemeral = (await crypto.subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as unknown as { publicKey: CryptoKey; privateKey: CryptoKey };
    const epk = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));
    const peer = await crypto.subtle.importKey("raw", theirs, { name: "X25519" }, false, []);
    const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: peer }, ephemeral.privateKey, 256));
    const wrapping = await wrapKey(shared, Uint8Array.from([...epk, ...theirs]));
    const keyIv = random(IV_BYTES);
    const key = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: keyIv, additionalData: INFO }, wrapping, contentKey));
    to.push({ wallet, epk: b64(epk), iv: b64(keyIv), key: b64(key) });
  }
  const envelope: Envelope = { [SEALED_TAG]: SEALED_VERSION, to, iv: b64(iv), data: b64(data) };
  return new TextEncoder().encode(`${JSON.stringify(envelope)}\n`);
}

function envelopeOf(bytes: Uint8Array): Envelope | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") {
    return null;
  }
  const envelope = parsed as Partial<Envelope>;
  if (envelope[SEALED_TAG] !== SEALED_VERSION || !Array.isArray(envelope.to) || typeof envelope.iv !== "string" || typeof envelope.data !== "string") {
    return null;
  }
  const decoder = getAddressDecoder();
  for (const entry of envelope.to as unknown[]) {
    const r = entry as Partial<Recipient> | null;
    if (r === null || typeof r !== "object" || typeof r.wallet !== "string" || typeof r.epk !== "string" || typeof r.iv !== "string" || typeof r.key !== "string") {
      return null;
    }
    try {
      if (decoder.decode(getAddressEncoder().encode(r.wallet as Address)) !== r.wallet) {
        return null;
      }
    } catch {
      return null;
    }
  }
  return envelope as Envelope;
}

export const isSealed = (bytes: Uint8Array): boolean => envelopeOf(bytes) !== null;

export function sealedTo(bytes: Uint8Array): Address[] {
  const envelope = envelopeOf(bytes);
  if (envelope === null) {
    throw new SealedError("this is not a sealed file");
  }
  return envelope.to.map((r) => r.wallet);
}

export async function unseal(bytes: Uint8Array, keypair: Uint8Array): Promise<Uint8Array> {
  const envelope = envelopeOf(bytes);
  if (envelope === null) {
    throw new SealedError("this is not a sealed file");
  }
  if (keypair.length !== 64) {
    throw new SealedError("a wallet key is 64 bytes: its seed and its public key");
  }
  const wallet = getAddressDecoder().decode(keypair.slice(32));
  const entry = envelope.to.find((r) => r.wallet === wallet);
  if (entry === undefined) {
    throw new NotInvited(wallet);
  }
  const mine = await x25519SecretOf(keypair);
  const epk = unb64(entry.epk);
  const peer = await crypto.subtle.importKey("raw", epk.slice(), { name: "X25519" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: peer }, mine, 256));
  const wrapping = await wrapKey(shared, Uint8Array.from([...epk, ...x25519PublicOf(wallet)]));
  try {
    const contentKey = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(entry.iv), additionalData: INFO }, wrapping, unb64(entry.key)));
    const content = await crypto.subtle.importKey("raw", contentKey, "AES-GCM", false, ["decrypt"]);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(envelope.iv), additionalData: INFO }, content, unb64(envelope.data)));
  } catch {
    throw new SealedError("the sealed file was changed or was not sealed to this wallet's key");
  }
}
