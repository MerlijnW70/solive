import { getAddressDecoder, getBase58Decoder, getBase58Encoder } from "@solana/kit";
import { PRODUCT_SLUG } from "../generated/identity.js";
import { InvalidInput, SdkError } from "./errors.js";
import { PKCS8_X25519, x25519PublicOf, x25519SecretOf } from "./sealed.js";

export const ENCRYPTION_KEY_KIND = `${PRODUCT_SLUG}-encryption-key`;
export const ENCRYPTION_KEY_BYTES = 32;
export const NO_ENCRYPTION_KEY = "none";
export const ENCRYPTION_KEY_RULE = `an X25519 public key: ${ENCRYPTION_KEY_BYTES} bytes in base58, canonical and not of small order`;

const FIELD = 2n ** 255n - 19n;

const hexOf = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export const SMALL_ORDER_KEYS: readonly string[] = [
  "00".repeat(ENCRYPTION_KEY_BYTES),
  `01${"00".repeat(ENCRYPTION_KEY_BYTES - 1)}`,
  "e0eb7a7c3b41b8ae1656e3faf19fc46ada098deb9c32b1fd866205165f49b800",
  "5f9c95bca3508c24b1d0b1559c83ef5b04445cc4581c8e86d8224eddd09f1157",
  `ec${"ff".repeat(ENCRYPTION_KEY_BYTES - 2)}7f`,
];

export function isUsableKey(key: Uint8Array): boolean {
  if (key.length !== ENCRYPTION_KEY_BYTES) {
    return false;
  }
  const u = key.reduceRight((acc, byte) => (acc << 8n) | BigInt(byte), 0n);
  return u < FIELD && !SMALL_ORDER_KEYS.includes(hexOf(key));
}

export type DeliveryKey = { publicKey: Uint8Array<ArrayBuffer>; secret: CryptoKey };

export type DeliveryOpener = Uint8Array | DeliveryKey;

export type EncryptionKeyFile = { text: string; publicKey: string };

export class EncryptionKeyError extends SdkError {
  readonly code = "encryption-key-error";
  override readonly name = "EncryptionKeyError";
}

export const NOT_ENCRYPTION_KEY_FILE = `this is not an encryption key file: it holds a JSON object of kind ${ENCRYPTION_KEY_KIND}, which profile encryption-key new writes`;

export const WALLET_KEY_GIVEN = `this is a wallet key file, which signs; an encryption key file only decrypts, so make one with profile encryption-key new`;

export const ENCRYPTION_KEY_MISMATCH = "the encryption key file's public key does not match its secret key";

const BASE_POINT = Uint8Array.from({ length: ENCRYPTION_KEY_BYTES }, (_, i) => (i === 0 ? 9 : 0));

const decoded = (text: string): Uint8Array | null => {
  try {
    return getBase58Encoder().encode(text) as Uint8Array;
  } catch {
    return null;
  }
};

export function isEncryptionKeyText(text: string): boolean {
  const bytes = decoded(text);
  return bytes !== null && isUsableKey(bytes) && getBase58Decoder().decode(bytes) === text;
}

export function parseEncryptionKey(text: string): Uint8Array<ArrayBuffer> {
  if (!isEncryptionKeyText(text)) {
    throw new InvalidInput("key", "format", `an encryption key is ${ENCRYPTION_KEY_RULE}`);
  }
  return Uint8Array.from(decoded(text) ?? []);
}

export const encryptionKeyText = (publicKey: Uint8Array): string => getBase58Decoder().decode(publicKey);

async function publicOf(secret: CryptoKey): Promise<Uint8Array<ArrayBuffer>> {
  const base = await crypto.subtle.importKey("raw", BASE_POINT.slice(), { name: "X25519" }, false, []);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "X25519", public: base }, secret, 256));
}

const importSecret = (secret: Uint8Array): Promise<CryptoKey> =>
  crypto.subtle.importKey("pkcs8", Uint8Array.from([...PKCS8_X25519, ...secret]), { name: "X25519" }, false, ["deriveBits"]);

export async function newEncryptionKeyFile(): Promise<EncryptionKeyFile> {
  const pair = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as unknown as { publicKey: CryptoKey; privateKey: CryptoKey };
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const secret = pkcs8.slice(pkcs8.length - ENCRYPTION_KEY_BYTES);
  const publicKey = encryptionKeyText(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)));
  const text = `${JSON.stringify({ kind: ENCRYPTION_KEY_KIND, public_key: publicKey, secret_key: getBase58Decoder().decode(secret) }, null, 2)}\n`;
  return { text, publicKey };
}

export async function readEncryptionKeyFile(text: string): Promise<DeliveryKey> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new EncryptionKeyError(NOT_ENCRYPTION_KEY_FILE);
  }
  if (Array.isArray(parsed)) {
    throw new EncryptionKeyError(WALLET_KEY_GIVEN);
  }
  const file = (parsed ?? {}) as { kind?: unknown; public_key?: unknown; secret_key?: unknown };
  const secret = typeof file.secret_key === "string" ? decoded(file.secret_key) : null;
  if (file.kind !== ENCRYPTION_KEY_KIND || typeof file.public_key !== "string" || !isEncryptionKeyText(file.public_key) || secret?.length !== ENCRYPTION_KEY_BYTES) {
    throw new EncryptionKeyError(NOT_ENCRYPTION_KEY_FILE);
  }
  const key = await importSecret(secret);
  const publicKey = await publicOf(key);
  if (encryptionKeyText(publicKey) !== file.public_key) {
    throw new EncryptionKeyError(ENCRYPTION_KEY_MISMATCH);
  }
  return { publicKey, secret: key };
}

export async function walletDeliveryKey(keypair: Uint8Array): Promise<DeliveryKey> {
  const secret = await x25519SecretOf(keypair);
  return { publicKey: x25519PublicOf(getAddressDecoder().decode(keypair.slice(32))), secret };
}

export const deliveryKeyOf = (opener: DeliveryOpener): Promise<DeliveryKey> => (opener instanceof Uint8Array ? walletDeliveryKey(opener) : Promise.resolve(opener));
