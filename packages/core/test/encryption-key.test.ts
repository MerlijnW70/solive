import { createHash, generateKeyPairSync } from "node:crypto";
import { type Address, getAddressDecoder } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  checkProfile,
  delivery,
  type DeliveryKey,
  type DeliveryOpener,
  deliverySecrets,
  ENCRYPTION_KEY_KIND,
  ENCRYPTION_KEY_MISMATCH,
  EncryptionKeyError,
  encryptionKeyText,
  isEncryptionKeyText,
  isUsableKey,
  keyFingerprintV4,
  newEncryptionKeyFile,
  NOT_ENCRYPTION_KEY_FILE,
  openDeliveryV4,
  openWithContentKey,
  parseEncryptionKey,
  readEncryptionKeyFile,
  SMALL_ORDER_KEYS,
  SealedError,
  sealDeliveryV4,
  type SealRecipient,
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

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

async function sealTo(recipients: readonly SealRecipient[], intent: Address, worker: Address): Promise<Uint8Array> {
  return sealDeliveryV4(await deliverySecrets(URL, recipients), intent, worker);
}

const urlOpened = async (blob: Uint8Array, opener: DeliveryOpener, intent: Address, worker: Address): Promise<string | null> =>
  (await openDeliveryV4(blob, opener, intent, worker))?.url ?? null;

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
    const [intent, worker] = [wallet().address, wallet().address];
    const [judge, member] = [wallet(), wallet()];
    const sealed = await encryptionKey();
    const blob = await sealTo([{ wallet: judge.address, encryptionKey: sealed.publicKey }, member.address], intent, worker);
    const head = delivery.blobHead(blob);
    expect([blob[0], head.count, head.mask]).toEqual([delivery.BLOB_VERSION, 2, 0b01]);
    expect(head.fps.slice(0, 2).map(hex)).toEqual([hex(await keyFingerprintV4(sealed.publicKey)), hex(await keyFingerprintV4(x25519PublicOf(member.address)))]);
    const fingerprint = createHash("sha256").update(Buffer.concat([delivery.FINGERPRINT_TAG, sealed.publicKey])).digest("hex").slice(0, 2 * delivery.FINGERPRINT_LEN);
    expect(hex(head.fps[0] ?? new Uint8Array())).toBe(fingerprint);
    expect(await urlOpened(blob, sealed.key, intent, worker)).toBe(URL);
    expect(await urlOpened(blob, member.keypair, intent, worker)).toBe(URL);
    expect(await urlOpened(blob, judge.keypair, intent, worker)).toBeNull();
    expect(await urlOpened(blob, (await encryptionKey()).key, intent, worker)).toBeNull();
  });

  it("mark the key of each recipient at its own position", async () => {
    const [intent, worker] = [wallet().address, wallet().address];
    const [judge, member] = [wallet(), wallet()];
    const sealed = await encryptionKey();
    const blob = await sealTo([member.address, { wallet: judge.address, encryptionKey: sealed.publicKey }], intent, worker);
    expect(delivery.blobHead(blob).mask).toBe(0b10);
    expect(blob[2]).toBe(0b10);
    expect(delivery.blobHead(blob).fps[1]).toEqual(await keyFingerprintV4(sealed.publicKey));
    expect(await urlOpened(blob, sealed.key, intent, worker)).toBe(URL);
    expect(await urlOpened(blob, member.keypair, intent, worker)).toBe(URL);
  });

  it("refuse a wallet listed twice, whichever keys its listings give", async () => {
    const [intent, worker] = [wallet().address, wallet().address];
    const judge = wallet();
    const [first, second] = [await encryptionKey(), await encryptionKey()];
    const keyed = { wallet: judge.address, encryptionKey: first.publicKey };
    const bare = { wallet: judge.address, encryptionKey: null };
    const lists: SealRecipient[][] = [[keyed, { wallet: judge.address, encryptionKey: second.publicKey }], [judge.address, keyed], [keyed, judge.address], [bare, keyed], [judge.address, bare]];
    for (const recipients of lists) {
      await expect(sealTo(recipients, intent, worker)).rejects.toThrow(new SealedError(`${judge.address} is listed twice; each recipient holds one slot`));
    }
  });

  it("seal to the key derived from the wallet when a recipient publishes no encryption key", async () => {
    const [intent, worker] = [wallet().address, wallet().address];
    const judge = wallet();
    for (const recipient of [{ wallet: judge.address, encryptionKey: null }, judge.address]) {
      const blob = await sealTo([recipient], intent, worker);
      const head = delivery.blobHead(blob);
      expect([head.mask, hex(head.fps[0] ?? new Uint8Array())]).toEqual([0, hex(await keyFingerprintV4(x25519PublicOf(judge.address)))]);
      expect(await urlOpened(blob, judge.keypair, intent, worker)).toBe(URL);
      expect(await urlOpened(blob, (await encryptionKey()).key, intent, worker)).toBeNull();
    }
    await expect(sealTo([{ wallet: judge.address, encryptionKey: new Uint8Array(31).fill(9) }], intent, worker)).rejects.toThrow(SealedError);
  });

  it("refuse a tampered header, whichever recipient opens it", async () => {
    const [intent, worker] = [wallet().address, wallet().address];
    const [judge, member] = [wallet(), wallet()];
    const sealed = await encryptionKey();
    const recipients = [{ wallet: judge.address, encryptionKey: sealed.publicKey }, member.address];
    const secrets = await deliverySecrets(URL, recipients);
    const blob = await sealDeliveryV4(secrets, intent, worker);
    const tampered = (at: number, value: (byte: number) => number) => Uint8Array.from(blob, (byte, i) => (i === at ? value(byte) : byte));
    const heads = [
      tampered(0, () => 3),
      tampered(1, () => 1),
      tampered(2, () => 0b00),
      tampered(2, () => 0b10),
      tampered(2, () => 0b11),
      tampered(3, (byte) => byte ^ 1),
      tampered(3 + delivery.FINGERPRINT_LEN, (byte) => byte ^ 1),
    ];
    for (const changed of heads) {
      expect(await urlOpened(changed, sealed.key, intent, worker)).toBeNull();
      expect(await urlOpened(changed, member.keypair, intent, worker)).toBeNull();
      expect(await openWithContentKey(changed, secrets.key, intent, worker)).toBeNull();
    }
    expect(await urlOpened(blob, sealed.key, intent, worker)).toBe(URL);
    expect((await openWithContentKey(blob, secrets.key, intent, worker))?.url).toBe(URL);
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

  it("refuse to seal a delivery to a small-order or non-canonical encryption key", async () => {
    const [intent, worker] = [wallet().address, wallet().address];
    const judge = wallet();
    const field = Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 0xed : i === 31 ? 0x7f : 0xff));
    const high = Uint8Array.from((await encryptionKey()).publicKey, (byte, i) => (i === 31 ? byte | 0x80 : byte));
    for (const bad of [...SMALL_ORDER_KEYS.map((text) => Uint8Array.from(Buffer.from(text, "hex"))), field, high]) {
      const refused = new SealedError(`${judge.address}'s encryption key is not a usable X25519 public key`);
      await expect(sealTo([{ wallet: judge.address, encryptionKey: bad }], intent, worker)).rejects.toThrow(refused);
      const recipients = [wallet().address, { wallet: judge.address, encryptionKey: bad }];
      await expect(sealDeliveryV4({ source: new Uint8Array(32), url: URL, recipients }, intent, worker)).rejects.toThrow(refused);
    }
  });
});
