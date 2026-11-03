import { readFileSync } from "node:fs";
import { type Address, getAddressDecoder, getPublicKeyFromAddress, type SignatureBytes, verifySignature } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { SealedError } from "../src/index.js";
import {
  announcementCommitment,
  deliverySecrets,
  ENCRYPTION_KEY_KIND,
  FEEDBACK_MEMO_PREFIX,
  LEGACY_SALT_TAG,
  legacyDeliverySecrets,
  legacySaltMessage,
  openDeliveryV4,
  openWithEsk,
  parseFeedbackMemo,
  parseSpecMemo,
  PRODUCT_SLUG,
  readEncryptionKeyFile,
  SALT_TAG,
  saltMessage,
  seal,
  SEALED_TAG,
  sealDeliveryV4,
  sealedTo,
  SMALL_ORDER_KEYS,
  SPEC_MEMO_MARK,
  SPEC_MEMO_PREFIX,
  unseal,
  x25519PublicOf,
} from "../src/internal.js";
import { referenceBlob, wallet } from "./sealed-v4-reference.js";

type Delivery = { source: string; salt: string; esk: string; content: string; commitment: string; blob: string };

type Legacy = {
  wallets: { owner: string; worker: string; judge: string; member: string };
  intent: Address;
  sha256: string;
  url: string;
  signed: Delivery;
  secret: Delivery;
  encryptionKeyFile: string;
  sealed: { plain: string; file: string };
  memos: { spec: string; feedback: string };
};

const LEGACY = JSON.parse(readFileSync(new URL("./golden/legacy-tags.json", import.meta.url), "utf8")) as Legacy;
const WORK = "ab".repeat(32);
const URL_A = "https://example.org/work.tar";

const bytes = (hex: string): Uint8Array<ArrayBuffer> => Uint8Array.from(Buffer.from(hex, "hex"));
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const addressOf = (keypair: string): Address => getAddressDecoder().decode(bytes(keypair).slice(32));
const text = (s: string): Uint8Array => new TextEncoder().encode(s);

async function written() {
  const [v4, memo, key, sealed] = await Promise.all([import("../src/sealed-delivery-v4.js"), import("../src/memo.js"), import("../src/encryption-key.js"), import("../src/sealed.js")]);
  const intent = LEGACY.intent;
  const file = JSON.parse((await key.newEncryptionKeyFile()).text) as Record<string, unknown>;
  const envelope = JSON.parse(new TextDecoder().decode(await sealed.seal(text("spec"), [addressOf(LEGACY.wallets.judge)]))) as Record<string, unknown>;
  return {
    salt: v4.SALT_TAG,
    message: hex(v4.saltMessage(intent, WORK)),
    spec: memo.specMemo(URL_A),
    feedback: memo.feedbackMemo({ intent, score: 1 }),
    kind: file["kind"],
    sealed: Object.keys(envelope)[0],
  };
}

describe("signing tags and file formats", () => {
  it("stay the same when the product is renamed", async () => {
    const actual = await written();
    vi.resetModules();
    vi.doMock("../generated/identity.js", async (original) => ({ ...(await original<Record<string, unknown>>()), PRODUCT_SLUG: "renamed", PRODUCT_NAME: "Renamed" }));
    try {
      expect((await import("../generated/identity.js")).PRODUCT_SLUG).toBe("renamed");
      expect(await written()).toEqual(actual);
    } finally {
      vi.doUnmock("../generated/identity.js");
      vi.resetModules();
    }
    expect(actual).toEqual({
      salt: SALT_TAG,
      message: hex(saltMessage(LEGACY.intent, WORK)),
      spec: `${SPEC_MEMO_PREFIX}${URL_A}`,
      feedback: `${FEEDBACK_MEMO_PREFIX}${LEGACY.intent}:1`,
      kind: ENCRYPTION_KEY_KIND,
      sealed: SEALED_TAG,
    });
    expect([SALT_TAG, SPEC_MEMO_PREFIX, FEEDBACK_MEMO_PREFIX, ENCRYPTION_KEY_KIND, SEALED_TAG].filter((tag) => tag.includes(PRODUCT_SLUG))).toEqual([]);
    expect(SPEC_MEMO_PREFIX.endsWith(SPEC_MEMO_MARK)).toBe(true);
  });
});

describe("what was written under the earlier tags", () => {
  it("parses earlier spec and feedback memos", () => {
    expect(parseSpecMemo(LEGACY.memos.spec)).toEqual({ url: LEGACY.url });
    expect(LEGACY.memos.spec.includes(SPEC_MEMO_MARK)).toBe(true);
    expect(parseFeedbackMemo(LEGACY.memos.feedback)).toEqual({ intent: LEGACY.intent, score: 87, note: LEGACY.sha256 });
  });

  it("loads an earlier encryption key file and opens an earlier sealed file with it and with a wallet key", async () => {
    const opener = await readEncryptionKeyFile(LEGACY.encryptionKeyFile);
    const file = text(LEGACY.sealed.file);
    expect(sealedTo(file)).toEqual([addressOf(LEGACY.wallets.judge), addressOf(LEGACY.wallets.member)]);
    expect(new TextDecoder().decode(await unseal(file, opener))).toBe(LEGACY.sealed.plain);
    expect(new TextDecoder().decode(await unseal(file, bytes(LEGACY.wallets.judge)))).toBe(LEGACY.sealed.plain);
  });

  it("refuses an earlier sealed file whose list was moved under the new tag", async () => {
    const moved = LEGACY.sealed.file.replace(/^\{"[a-z-]+":/, `{"${SEALED_TAG}":`);
    expect(moved).not.toBe(LEGACY.sealed.file);
    await expect(unseal(text(moved), bytes(LEGACY.wallets.judge))).rejects.toThrow(SealedError);
  });

  it("rederives an earlier announcement's salt, ephemeral secret and commitment, and opens its blob", async () => {
    const worker = addressOf(LEGACY.wallets.worker);
    const judge = addressOf(LEGACY.wallets.judge);
    const signed = await verifySignature(await getPublicKeyFromAddress(worker), bytes(LEGACY.signed.source) as SignatureBytes, legacySaltMessage(LEGACY.intent, LEGACY.sha256));
    expect(signed).toBe(true);
    for (const kept of [LEGACY.signed, LEGACY.secret]) {
      const secrets = await legacyDeliverySecrets(LEGACY.url, [judge], bytes(kept.source));
      expect([hex(secrets.salt), hex(secrets.esk), hex(secrets.key)]).toEqual([kept.salt, kept.esk, kept.content]);
      expect(hex(await announcementCommitment(LEGACY.intent, worker, { delivered: bytes(LEGACY.sha256), salt: secrets.salt }))).toBe(kept.commitment);
      const blob = bytes(kept.blob);
      expect(hex(referenceBlob({ source: bytes(kept.source), url: LEGACY.url, recipients: [{ key: x25519PublicOf(judge), profile: false }], intent: LEGACY.intent, worker, legacy: true }))).toBe(kept.blob);
      expect((await openWithEsk(blob, secrets.esk, [judge], LEGACY.intent, worker))?.url).toBe(LEGACY.url);
      const opened = await openDeliveryV4(blob, bytes(LEGACY.wallets.judge), LEGACY.intent, worker);
      expect([opened?.url, hex(opened?.salt ?? new Uint8Array())]).toEqual([LEGACY.url, kept.salt]);
      const current = await deliverySecrets(LEGACY.url, [judge], { intent: LEGACY.intent, worker }, bytes(kept.source));
      expect(hex(current.salt)).not.toBe(kept.salt);
      expect(await openWithEsk(blob, current.esk, [judge], LEGACY.intent, worker)).toBeNull();
    }
  });
});

describe("the sealed-delivery content key", () => {
  it("differs between two intents, and between two workers, for one kept secret, url and recipient list", async () => {
    const [first, second, worker, other] = [wallet().address, wallet().address, wallet().address, wallet().address];
    const recipients = [wallet().address];
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const of = (intent: Address, by: Address) => deliverySecrets(URL_A, recipients, { intent, worker: by }, secret);
    const [a, b, c] = await Promise.all([of(first, worker), of(second, worker), of(first, other)]);
    expect(hex(a.key)).not.toBe(hex(b.key));
    expect(hex(a.key)).not.toBe(hex(c.key));
    expect(hex(a.esk)).not.toBe(hex(b.esk));
    expect(hex(a.esk)).not.toBe(hex(c.esk));
    expect(hex((await of(first, worker)).key)).toBe(hex(a.key));
    const [sealedA, sealedB] = await Promise.all([sealDeliveryV4({ source: secret, url: URL_A, recipients }, first, worker), sealDeliveryV4({ source: secret, url: URL_A, recipients }, second, worker)]);
    expect(hex(sealedA.subarray(0, 3 + 8 + 32))).not.toBe(hex(sealedB.subarray(0, 3 + 8 + 32)));
  });

  it("signs a salt message under the neutral tag, and rederives an earlier one under the earlier tag", () => {
    const intent = wallet().address;
    const message = saltMessage(intent, WORK);
    const earlier = legacySaltMessage(intent, WORK);
    expect(hex(message.subarray(0, SALT_TAG.length))).toBe(hex(text(SALT_TAG)));
    expect(hex(earlier.subarray(0, LEGACY_SALT_TAG.length))).toBe(hex(text(LEGACY_SALT_TAG)));
    expect(hex(message.subarray(SALT_TAG.length))).toBe(hex(earlier.subarray(LEGACY_SALT_TAG.length)));
    expect(SALT_TAG).not.toBe(LEGACY_SALT_TAG);
  });
});

describe("an explicit encryption key given to seal", () => {
  it("is refused when it is of small order or not canonical, as sealed delivery refuses it", async () => {
    const to = wallet().address;
    const notCanonical = Uint8Array.from({ length: 32 }, (_, i) => (i === 0 ? 0xf6 : i === 31 ? 0x7f : 0xff));
    for (const key of [...SMALL_ORDER_KEYS.map(bytes), notCanonical]) {
      await expect(seal(text("spec"), [{ wallet: to, encryptionKey: key }])).rejects.toThrow(new SealedError(`${to}'s encryption key is not a usable X25519 public key`));
    }
  });
});
