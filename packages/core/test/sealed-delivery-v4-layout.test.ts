import { createHash } from "node:crypto";
import { getAddressDecoder } from "@solana/kit";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ATTEST_DELIVERY_TAG,
  ATTEST_PROOF_TAG,
  ATTEST_SPLIT_DELIVERY_TAG,
  ATTEST_SPLIT_TAG,
  ATTEST_TAG,
  BLOB_INFO,
  blobLayout,
  CK_TAG,
  COMMITTEE_COSIGN_TAG,
  COMMITTEE_TAG,
  delivery,
  deliverySecrets,
  ESK_TAG,
  INTENT_TAG,
  KC_TAG,
  sealDeliveryV4,
  sealedBlobLength,
  SPLIT_COSIGN_TAG,
  WRAP_INFO,
  x25519PublicOf,
  COMMITMENT_TAG,
  FINGERPRINT_TAG,
  SALT_TAG,
  SALT_CHECK_TAG,
  SEALED_TAG,
} from "../src/index.js";
import { clamp, refBinding, refPublic, referenceBlob, refSecrets, urlOf } from "./sealed-v4-reference.js";

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");
const fixed = (byte: number, length = 32) => new Uint8Array(length).fill(byte);
const address = (byte: number) => getAddressDecoder().decode(fixed(byte));
const key = (byte: number) => refPublic(clamp(fixed(byte)));

const INTENT = address(0x11);
const WORKER = address(0x22);
const SIG = Uint8Array.from({ length: 64 }, (_, i) => i);
const URL = "https://example.org/sealed/work.tar";
const member = (i: number, profile: boolean) => {
  const wallet = address(0x40 + i);
  const k = profile ? key(0x30 + i) : x25519PublicOf(wallet);
  return { key: k, profile, recipient: profile ? { wallet, encryptionKey: k } : wallet };
};
const GOLDEN_RECIPIENTS = [member(0, true), member(1, false), member(2, true)];
const GOLDEN_SHA256 = "1476ef924eab8ff5c97353067d630b0696928b19c1bedd396ad1bd8850bc056a";

const sealed = (source: Uint8Array, url: string, recipients: readonly ReturnType<typeof member>[]) =>
  deliverySecrets(
    url,
    recipients.map((r) => r.recipient),
    source,
  ).then((secrets) => sealDeliveryV4(secrets, INTENT, WORKER));

describe("the v4 blob layout", () => {
  it("places every field at the offset the spec gives", async () => {
    const all = [member(0, true), member(1, true), member(2, true)];
    const blob = await sealed(SIG, URL, all);
    const n = 3;
    const u = URL.length;
    const { esk, key: contentKey, salt } = refSecrets(SIG, URL, refBinding(blob));
    expect(blob.length).toBe(99 + 40 * n + u);
    expect(blob.length).toBe(sealedBlobLength(n, u));
    expect([...blob.subarray(0, 3)]).toEqual([4, 3, 0b111]);
    for (const [i, r] of all.entries()) {
      const fp = createHash("sha256").update(Buffer.concat([Buffer.from("intent-engine-fp"), r.key])).digest().subarray(0, 8);
      expect(hex(blob.subarray(3 + 8 * i, 11 + 8 * i))).toBe(hex(fp));
    }
    expect(hex(blob.subarray(3 + 8 * n, 35 + 8 * n))).toBe(hex(refPublic(esk)));
    const kc = createHash("sha256").update(Buffer.concat([Buffer.from("intent-engine-kc"), contentKey])).digest();
    expect(hex(blob.subarray(35 + 8 * n, 67 + 8 * n))).toBe(hex(kc));
    expect(blobLayout(n, blob.length)).toEqual({ count: n, epk: 27, kc: 59, wrapped: 91, ct: 187, length: blob.length });
    expect(blob.length - 187).toBe(16 + u + 16);
    expect(salt.length).toBe(16);
  });

  it("matches an independent node:crypto build of the spec byte for byte", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 24, max: 200 }),
        fc.uint8Array({ minLength: 64, maxLength: 64 }),
        fc.boolean(),
        async (n, maskSeed, length, signature, random) => {
          const source = random ? signature.slice(0, 32) : signature;
          const recipients = Array.from({ length: n }, (_, i) => member(i, ((maskSeed >> i) & 1) === 1));
          const url = urlOf(length);
          expect(hex(await sealed(source, url, recipients))).toBe(hex(referenceBlob({ source, url, recipients, intent: INTENT, worker: WORKER })));
        },
      ),
      { numRuns: 40 },
    );
  });

  it("pins one blob by its hash", async () => {
    const blob = await sealed(SIG, URL, GOLDEN_RECIPIENTS);
    expect(hex(blob.subarray(0, 3))).toBe("040305");
    expect(createHash("sha256").update(blob).digest("hex")).toBe(GOLDEN_SHA256);
  });

  it("derives its secrets from the salt signature, the url and the recipient bytes of the head", async () => {
    const secrets = await deliverySecrets(URL, GOLDEN_RECIPIENTS.map((r) => r.recipient), SIG);
    const blob = await sealed(SIG, URL, GOLDEN_RECIPIENTS);
    expect(hex(secrets.binding)).toBe(hex(blob.subarray(1, 3 + 8 * 3)));
    const ref = refSecrets(SIG, URL, refBinding(blob));
    const digest = (tag: string) => createHash("sha256").update(Buffer.concat([Buffer.from(tag), SIG, Buffer.from(URL), blob.subarray(1, 27)])).digest("hex");
    expect(hex(secrets.key)).toBe(digest("intent-engine-ck"));
    expect(hex(secrets.esk)).toBe(hex(clamp(Buffer.from(digest("intent-engine-ek"), "hex"))));
    expect(hex(secrets.salt)).toBe(hex(ref.salt));
    expect(hex(secrets.esk)).toBe(hex(ref.esk));
    expect(hex(secrets.key)).toBe(hex(ref.key));
    expect((secrets.esk[0] ?? 0) & 7).toBe(0);
    expect((secrets.esk[31] ?? 0) & 0xc0).toBe(0x40);
  });

  it("uses tags of its own, distinct from every tag already in core", () => {
    const ours = [KC_TAG, WRAP_INFO, BLOB_INFO, ESK_TAG, CK_TAG].map((t) => new TextDecoder().decode(t));
    const existing = [
      INTENT_TAG,
      ATTEST_TAG,
      ATTEST_PROOF_TAG,
      ATTEST_SPLIT_TAG,
      ATTEST_DELIVERY_TAG,
      ATTEST_SPLIT_DELIVERY_TAG,
      SPLIT_COSIGN_TAG,
      COMMITTEE_TAG,
      COMMITTEE_COSIGN_TAG,
      delivery.COMMITMENT_TAG,
      delivery.FINGERPRINT_TAG,
    ]
      .map((t) => new TextDecoder().decode(t))
      .concat([COMMITMENT_TAG, FINGERPRINT_TAG, SALT_TAG, SALT_CHECK_TAG, SEALED_TAG]);
    expect(ours).toEqual(["intent-engine-kc", "intent-engine-wk", "intent-engine-bl", "intent-engine-ek", "intent-engine-ck"]);
    expect(new Set([...ours, ...existing]).size).toBe(ours.length + existing.length);
    expect(ours.every((t) => /^[\x20-\x7e]+$/.test(t))).toBe(true);
  });
});
