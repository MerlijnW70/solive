import { createCipheriv, createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, sign } from "node:crypto";
import { type Address, getAddressDecoder, getAddressEncoder } from "@solana/kit";
import { type DeliveryKey, type SealRecipient } from "../src/index.js";
import { newEncryptionKeyFile, readEncryptionKeyFile, SALT_TAG, saltMessage, x25519PublicOf } from "../src/internal.js";

export type Wallet = { address: Address; keypair: Uint8Array; sign: (message: Uint8Array) => Uint8Array };

export type Member = { recipient: SealRecipient; opener: Uint8Array | DeliveryKey; key: Uint8Array; profile: boolean };

export function wallet(): Wallet {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  const keypair = Uint8Array.from([...Buffer.from(jwk.d ?? "", "base64url"), ...Buffer.from(jwk.x ?? "", "base64url")]);
  const key = createPrivateKey({ key: jwk, format: "jwk" });
  return { address: getAddressDecoder().decode(keypair.slice(32)), keypair, sign: (message) => new Uint8Array(sign(null, message, key)) };
}

export async function walletMember(): Promise<Member> {
  const w = wallet();
  return { recipient: w.address, opener: w.keypair, key: x25519PublicOf(w.address), profile: false };
}

export async function profileMember(): Promise<Member> {
  const w = wallet();
  const opener = await readEncryptionKeyFile((await newEncryptionKeyFile()).text);
  return { recipient: { wallet: w.address, encryptionKey: opener.publicKey }, opener, key: opener.publicKey, profile: true };
}

export async function committee(n: number, profiled: (i: number) => boolean): Promise<Member[]> {
  return Promise.all(Array.from({ length: n }, (_, i) => (profiled(i) ? profileMember() : walletMember())));
}

export const WORK = createHash("sha256").update("the work").digest("hex");

export const saltSignature = (worker: Wallet, intent: Address, sha256 = WORK): Uint8Array => worker.sign(saltMessage(intent, sha256));

export const urlOf = (length: number): string => "https://example.org/" + "a".repeat(length - "https://example.org/".length);

const PKCS8 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI = Buffer.from("302a300506032b656e032100", "hex");

const digest = (...parts: Uint8Array[]): Buffer => createHash("sha256").update(Buffer.concat(parts)).digest();

const text = (s: string): Uint8Array => new TextEncoder().encode(s);

export function clamp(bytes: Uint8Array): Uint8Array {
  const out = Uint8Array.from(bytes);
  out[0] = (out[0] ?? 0) & 0xf8;
  out[31] = ((out[31] ?? 0) & 0x7f) | 0x40;
  return out;
}

export const refSecret = (scalar: Uint8Array) => createPrivateKey({ key: Buffer.concat([PKCS8, scalar]), format: "der", type: "pkcs8" });

export const refPublic = (scalar: Uint8Array): Uint8Array =>
  new Uint8Array(createPublicKey(refSecret(scalar)).export({ format: "der", type: "spki" })).slice(-32);

export const refShared = (scalar: Uint8Array, peer: Uint8Array): Uint8Array =>
  new Uint8Array(diffieHellman({ privateKey: refSecret(scalar), publicKey: createPublicKey({ key: Buffer.concat([SPKI, peer]), format: "der", type: "spki" }) }));

export type Reference = {
  source: Uint8Array;
  url: string;
  recipients: readonly { key: Uint8Array; profile: boolean }[];
  intent: Address;
  worker: Address;
  slotKey?: (i: number, key: Uint8Array) => Uint8Array;
  contentKey?: (key: Uint8Array) => Uint8Array;
  fingerprint?: (i: number, fp: Uint8Array) => Uint8Array;
  wrapEsk?: Uint8Array;
};

export function refSecrets(source: Uint8Array, url: string, binding: Uint8Array) {
  return {
    salt: digest(text(SALT_TAG), source).subarray(0, 16),
    esk: clamp(digest(text("intent-engine-ek"), source, text(url), binding)),
    key: new Uint8Array(digest(text("intent-engine-ck"), source, text(url), binding)),
  };
}

export const refBinding = (blob: Uint8Array): Uint8Array => blob.slice(1, 3 + 8 * (blob[1] ?? 0));

export function referenceBlob(r: Reference): Uint8Array {
  const n = r.recipients.length;
  const mask = r.recipients.reduce((m, x, i) => (x.profile ? m | (1 << i) : m), 0);
  const fps = r.recipients.map((x, i) => {
    const fp = digest(text("intent-engine-fp"), x.key).subarray(0, 8);
    return r.fingerprint?.(i, fp) ?? fp;
  });
  const binding = Buffer.concat([Uint8Array.of(n, mask), ...fps]);
  const { salt, esk, key } = refSecrets(r.source, r.url, binding);
  const epk = refPublic(esk);
  const prefix = Buffer.concat([Uint8Array.of(4, n, mask), ...fps, epk, digest(text("intent-engine-kc"), key)]);
  const wrapEsk = r.wrapEsk ?? esk;
  const wrapEpk = refPublic(wrapEsk);
  const wrapped = r.recipients.map((x, i) => {
    const pad = new Uint8Array(hkdfSync("sha256", refShared(wrapEsk, x.key), Buffer.concat([wrapEpk, x.key]), text("intent-engine-wk"), 32));
    const slot = r.slotKey?.(i, key) ?? key;
    return Uint8Array.from(slot, (b, j) => b ^ (pad[j] ?? 0));
  });
  const encoder = getAddressEncoder();
  const cipher = createCipheriv("aes-256-gcm", r.contentKey?.(key) ?? key, Buffer.alloc(12));
  cipher.setAAD(Buffer.concat([text("intent-engine-bl"), encoder.encode(r.intent) as Uint8Array, encoder.encode(r.worker) as Uint8Array, prefix]));
  const ct = Buffer.concat([cipher.update(Buffer.concat([salt, text(r.url)])), cipher.final(), cipher.getAuthTag()]);
  return new Uint8Array(Buffer.concat([prefix, ...wrapped, ct]));
}
