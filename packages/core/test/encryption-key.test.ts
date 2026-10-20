import { createHash, generateKeyPairSync } from "node:crypto";
import { type Address, getAddressDecoder } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  checkProfile,
  type DeliveryKey,
  DELIVERY_MEMO_PREFIX,
  ENCRYPTION_KEY_KIND,
  FINGERPRINT_BYTES,
  FINGERPRINT_TAG,
  keyFingerprint,
  ENCRYPTION_KEY_MISMATCH,
  EncryptionKeyError,
  encryptionKeyText,
  isEncryptionKeyText,
  isUsableKey,
  newEncryptionKeyFile,
  NOT_ENCRYPTION_KEY_FILE,
  openDelivery,
  parseDeliveryMemo,
  parseEncryptionKey,
  readEncryptionKeyFile,
  SALT_BYTES,
  saltCheck,
  SMALL_ORDER_KEYS,
  SEALED_URL_VERSION,
  sealDelivery,
  sealedFingerprints,
  sealedKeys,
  sealedUrlRecipients,
  WALLET_KEY_GIVEN,
  x25519PublicOf,
} from "../src/index.js";

type Wallet = { address: Address; keypair: Uint8Array };

function wallet(): Wallet {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  const keypair = Uint8Array.from([...Buffer.from(jwk.d ?? "", "base64url"), ...Buffer.from(jwk.x ?? "", "base64url")]);
  return { address: getAddressDecoder().decode(keypair.slice(32)), keypair };
}

const URL = "https://example.org/work.tar";
const SALT = "ab".repeat(SALT_BYTES);

async function encryptionKey(): Promise<{ file: string; key: DeliveryKey; publicKey: Uint8Array }> {
  const { text, publicKey } = await newEncryptionKeyFile();
  return { file: text, key: await readEncryptionKeyFile(text), publicKey: parseEncryptionKey(publicKey) };
}

describe("judge encryption keys", () => {
  it("write a key file that only decrypts, read it back, and refuse wallet key files and changed ones", async () => {
    const { text, publicKey } = await newEncryptionKeyFile();
    const file = JSON.parse(text) as Record<string, string>;
    expect(Object.keys(file).sort()).toEqual(["kind", "public_key", "secret_key"]);
    expect([file["kind"], file["public_key"]]).toEqual([ENCRYPTION_KEY_KIND, publicKey]);
    const key = await readEncryptionKeyFile(text);
    expect(encryptionKeyText(key.publicKey)).toBe(publicKey);
    expect(key.secret.usages).toEqual(["deriveBits"]);
    expect(key.secret.extractable).toBe(false);
    const other = await newEncryptionKeyFile();
    const swapped = JSON.stringify({ ...file, public_key: other.publicKey });
    await expect(readEncryptionKeyFile(swapped)).rejects.toThrow(ENCRYPTION_KEY_MISMATCH);
    await expect(readEncryptionKeyFile(JSON.stringify([...wallet().keypair]))).rejects.toThrow(WALLET_KEY_GIVEN);
    for (const bad of ["not json", "null", "{}", JSON.stringify({ ...file, kind: "other" }), JSON.stringify({ ...file, secret_key: "1" })]) {
      await expect(readEncryptionKeyFile(bad)).rejects.toThrow(new EncryptionKeyError(NOT_ENCRYPTION_KEY_FILE));
    }
  });

  it("accept a public key of 32 bytes in base58 that is not all zero, in a profile too", async () => {
    const { publicKey } = await newEncryptionKeyFile();
    expect(isEncryptionKeyText(publicKey)).toBe(true);
    expect(isEncryptionKeyText(encryptionKeyText(new Uint8Array(32)))).toBe(false);
    expect(isEncryptionKeyText(encryptionKeyText(new Uint8Array(31).fill(1)))).toBe(false);
    expect(isEncryptionKeyText("0OIl")).toBe(false);
    expect(() => parseEncryptionKey("x")).toThrow(RangeError);
    const profile = { skills: ["judge"], endpoint: "https://judge.example" };
    expect(checkProfile({ ...profile, encryptionKey: publicKey })).toEqual({ ...profile, encryptionKey: publicKey });
    expect(() => checkProfile({ ...profile, encryptionKey: "11111111111111111111111111111111" })).toThrow();
  });

  it("seal to a recipient's encryption key, record which key each got, and open only with that key", async () => {
    const intent = wallet().address;
    const [judge, member] = [wallet(), wallet()];
    const sealed = await encryptionKey();
    const blob = await sealDelivery({ salt: SALT, url: URL }, [{ wallet: judge.address, encryptionKey: sealed.publicKey }, member.address], intent);
    expect(Buffer.from(blob, "base64")[0]).toBe(SEALED_URL_VERSION);
    expect(sealedUrlRecipients(blob)).toBe(2);
    expect(sealedKeys(blob)).toEqual(["profile", "wallet"]);
    expect(sealedFingerprints(blob)).toEqual([await keyFingerprint(sealed.publicKey), await keyFingerprint(x25519PublicOf(member.address))]);
    const fingerprint = createHash("sha256").update(Buffer.concat([Buffer.from(FINGERPRINT_TAG), Buffer.from(sealed.publicKey)])).digest("hex").slice(0, 2 * FINGERPRINT_BYTES);
    expect(sealedFingerprints(blob)?.[0]).toBe(fingerprint);
    const renamed = Buffer.from(blob, "base64");
    renamed[3] = (renamed[3] ?? 0) ^ 1;
    expect(await openDelivery(renamed.toString("base64"), sealed.key, intent)).toBeNull();
    expect(await openDelivery(blob, sealed.key, intent)).toEqual({ salt: SALT, url: URL });
    expect(await openDelivery(blob, member.keypair, intent)).toEqual({ salt: SALT, url: URL });
    expect(await openDelivery(blob, judge.keypair, intent)).toBeNull();
    expect(await openDelivery(blob, (await encryptionKey()).key, intent)).toBeNull();
    const changed = Buffer.from(blob, "base64");
    changed[2] = 0b11;
    expect(sealedKeys(changed.toString("base64"))).toEqual(["profile", "profile"]);
    expect(await openDelivery(changed.toString("base64"), sealed.key, intent)).toBeNull();
    changed[2] = 0b100;
    expect(sealedKeys(changed.toString("base64"))).toBeNull();
  });

  it("mark the key of each recipient at its own position", async () => {
    const intent = wallet().address;
    const [judge, member] = [wallet(), wallet()];
    const sealed = await encryptionKey();
    const blob = await sealDelivery({ salt: SALT, url: URL }, [member.address, { wallet: judge.address, encryptionKey: sealed.publicKey }], intent);
    expect(sealedKeys(blob)).toEqual(["wallet", "profile"]);
    expect(Buffer.from(blob, "base64")[2]).toBe(0b10);
    expect(await openDelivery(blob, sealed.key, intent)).toEqual({ salt: SALT, url: URL });
    expect(await openDelivery(blob, member.keypair, intent)).toEqual({ salt: SALT, url: URL });
  });

  it("keep a wallet listed twice once, with its first encryption key, or the key a later listing adds", async () => {
    const intent = wallet().address;
    const judge = wallet();
    const [first, second] = [await encryptionKey(), await encryptionKey()];
    const seal = (recipients: Parameters<typeof sealDelivery>[1]) => sealDelivery({ salt: SALT, url: URL }, recipients, intent);
    const keyed = { wallet: judge.address, encryptionKey: first.publicKey };
    const twice = await seal([keyed, { wallet: judge.address, encryptionKey: second.publicKey }]);
    expect(sealedFingerprints(twice)).toEqual([await keyFingerprint(first.publicKey)]);
    expect(await openDelivery(twice, first.key, intent)).toEqual({ salt: SALT, url: URL });
    expect(await openDelivery(twice, second.key, intent)).toBeNull();
    for (const recipients of [[judge.address, keyed], [keyed, judge.address], [{ wallet: judge.address, encryptionKey: null }, keyed]]) {
      const blob = await seal(recipients);
      expect([sealedKeys(blob), sealedFingerprints(blob)]).toEqual([["profile"], [await keyFingerprint(first.publicKey)]]);
    }
    const bare = await seal([judge.address, { wallet: judge.address, encryptionKey: null }]);
    expect(sealedKeys(bare)).toEqual(["wallet"]);
  });

  it("seal to the key derived from the wallet when a recipient publishes no encryption key, or a low-order one", async () => {
    const intent = wallet().address;
    const judge = wallet();
    const blob = await sealDelivery({ salt: SALT, url: URL }, [{ wallet: judge.address, encryptionKey: null }], intent);
    expect(sealedKeys(blob)).toEqual(["wallet"]);
    expect(await openDelivery(blob, judge.keypair, intent)).toEqual({ salt: SALT, url: URL });
    expect(await openDelivery(blob, (await encryptionKey()).key, intent)).toBeNull();
    const plain = await sealDelivery({ salt: SALT, url: URL }, [judge.address], intent);
    expect(sealedKeys(plain)).toEqual(["wallet"]);
    const lowOrder = Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 1 : 0));
    const fallback = await sealDelivery({ salt: SALT, url: URL }, [{ wallet: judge.address, encryptionKey: lowOrder }], intent);
    expect(sealedKeys(fallback)).toEqual(["wallet"]);
    expect(await openDelivery(fallback, judge.keypair, intent)).toEqual({ salt: SALT, url: URL });
    await expect(sealDelivery({ salt: SALT, url: URL }, [{ wallet: judge.address, encryptionKey: new Uint8Array(31) }], intent)).rejects.toThrow("32 bytes");
  });

  it("refuse a version-3 delivery rewritten as version 2, and one whose key record was flipped", async () => {
    const intent = wallet().address;
    const [judge, member] = [wallet(), wallet()];
    const sealed = await encryptionKey();
    const blob = Buffer.from(await sealDelivery({ salt: SALT, url: URL }, [{ wallet: judge.address, encryptionKey: sealed.publicKey }, member.address], intent), "base64");
    const downgraded = Buffer.from([2, blob[1] ?? 0, ...blob.subarray(3)]).toString("base64");
    expect([sealedKeys(downgraded), sealedFingerprints(downgraded), sealedUrlRecipients(downgraded)]).toEqual([null, null, null]);
    const commitment = createHash("sha256").update("commitment").digest("hex");
    const memo = `${DELIVERY_MEMO_PREFIX}${intent}:${commitment}:${await saltCheck(SALT)}:${downgraded}`;
    expect(parseDeliveryMemo(memo)).toEqual({ intent, commitment, check: await saltCheck(SALT), blob: downgraded });
    expect(await openDelivery(downgraded, sealed.key, intent)).toBeNull();
    expect(await openDelivery(downgraded, member.keypair, intent)).toBeNull();
    for (const mask of [0b00, 0b10, 0b11]) {
      const flipped = Buffer.from(blob);
      flipped[2] = mask;
      expect(await openDelivery(flipped.toString("base64"), sealed.key, intent)).toBeNull();
      expect(await openDelivery(flipped.toString("base64"), member.keypair, intent)).toBeNull();
    }
  });

  it("refuse small-order and non-canonical keys, which X25519 itself cannot use", async () => {
    const ephemeral = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as unknown as { privateKey: CryptoKey };
    for (const hex of SMALL_ORDER_KEYS) {
      const bytes = Uint8Array.from(Buffer.from(hex, "hex"));
      expect(isUsableKey(bytes)).toBe(false);
      const peer = await crypto.subtle.importKey("raw", bytes, { name: "X25519" }, false, []);
      await expect(crypto.subtle.deriveBits({ name: "X25519", public: peer }, ephemeral.privateKey, 256)).rejects.toThrow();
    }
    const field = Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 0xed : i === 31 ? 0x7f : 0xff));
    const high = Uint8Array.from({ length: 32 }, (_, i) => (i === 31 ? 0x80 : 9));
    for (const bad of [field, high]) {
      expect(isUsableKey(bad)).toBe(false);
      expect(isEncryptionKeyText(encryptionKeyText(bad))).toBe(false);
    }
    expect(isUsableKey((await encryptionKey()).publicKey)).toBe(true);
  });
});
