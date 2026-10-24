import { createHash } from "node:crypto";
import { type Address, getAddressEncoder } from "@solana/kit";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  announcementCommitment,
  delivery,
  type DeliverySecrets,
  deliverySecrets,
  ephemeralPublic,
  openDeliveryV4,
  openWithContentKey,
  openWithEsk,
  isSaltHex,
  RANDOM_SOURCE_LEN,
  recipientBinding,
  SALT_TAG,
  saltMessage,
  sealDeliveryV4,
  SealedError,
  type SealRecipient,
  PRODUCT_SLUG,
} from "../src/index.js";
import { clamp, committee, profileMember, refBinding, referenceBlob, refSecrets, saltSignature, urlOf, type Wallet, wallet, walletMember, WORK } from "./sealed-v4-reference.js";
import { InvalidInput } from "../src/errors.js";

const URL_A = "https://example.org/work-a.tar";
const URL_B = "https://example.org/work-b.tar";
const YES = createHash("sha256").update("yes").digest("hex");
const NO = createHash("sha256").update("no").digest("hex");

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

async function job() {
  const [intent, worker] = [wallet().address, wallet()];
  const sig = saltSignature(worker, intent);
  return { intent, worker: worker.address, sig };
}

async function seal(url: string, recipients: readonly SealRecipient[], intent: Address, worker: Address, source?: Uint8Array) {
  const secrets = await deliverySecrets(url, recipients, source);
  return { secrets, blob: await sealDeliveryV4(secrets, intent, worker) };
}

describe("sealed delivery v4", () => {
  it("opens to identical salt, url and content key for every recipient of one blob", async () => {
    const { intent, worker, sig } = await job();
    const members = await committee(8, (i) => i % 3 === 0);
    const { secrets, blob } = await seal(URL_A, members.map((m) => m.recipient), intent, worker, sig);
    const opened = await Promise.all(members.map((m) => openDeliveryV4(blob, m.opener, intent, worker)));
    const salt = hex(refSecrets(sig, URL_A, secrets.binding).salt);
    for (const o of opened) {
      expect(o).not.toBeNull();
      expect(o?.url).toBe(URL_A);
      expect(hex(o?.salt ?? new Uint8Array())).toBe(salt);
      expect(hex(o?.key ?? new Uint8Array())).toBe(hex(secrets.key));
    }
    expect(delivery.blobHead(blob).mask).toBe(0b0100_1001);
  });

  it("is refused by the recipient whose slot wraps a key other than the committed one", async () => {
    const { intent, worker, sig } = await job();
    const members = await committee(3, (i) => i === 1);
    const recipients = members.map((m) => ({ key: m.key, profile: m.profile }));
    const other = crypto.getRandomValues(new Uint8Array(32));
    const honest = referenceBlob({ source: sig, url: URL_A, recipients, intent, worker });
    const forged = referenceBlob({ source: sig, url: URL_A, recipients, intent, worker, slotKey: (i, k) => (i === 1 ? other : k), contentKey: () => other });
    const cheated = members[1];
    if (cheated === undefined) {
      throw new Error("no member");
    }
    expect((await openDeliveryV4(honest, cheated.opener, intent, worker))?.url).toBe(URL_A);
    expect(await openDeliveryV4(forged, cheated.opener, intent, worker)).toBeNull();
    for (const m of members) {
      expect(await openDeliveryV4(forged, m.opener, intent, worker)).toBeNull();
    }
    expect(await openWithContentKey(forged, other, intent, worker)).toBeNull();
    const { esk } = refSecrets(sig, URL_A, refBinding(forged));
    expect(await openWithEsk(forged, esk, members.map((m) => m.recipient), intent, worker)).toBeNull();
  });

  it("opens for a non-recipient once the content key is published, and only with that key", async () => {
    const { intent, worker, sig } = await job();
    const members = await committee(2, (i) => i === 0);
    const { secrets, blob } = await seal(URL_A, members.map((m) => m.recipient), intent, worker, sig);
    const stranger = await walletMember();
    const first = members[0];
    expect(await openDeliveryV4(blob, stranger.opener, intent, worker)).toBeNull();
    const byKey = await openWithContentKey(blob, secrets.key, intent, worker);
    const byRecipient = first === undefined ? null : await openDeliveryV4(blob, first.opener, intent, worker);
    expect(byKey).toEqual(byRecipient);
    expect(byKey?.url).toBe(URL_A);
    const wrong = Uint8Array.from(secrets.key, (b, i) => (i === 0 ? b ^ 1 : b));
    expect(await openWithContentKey(blob, wrong, intent, worker)).toBeNull();
    expect(await openWithContentKey(blob, secrets.key.slice(0, 31), intent, worker)).toBeNull();
  });

  it("does not open when copied under another worker or another intent", async () => {
    const { intent, worker, sig } = await job();
    const members = await committee(2, (i) => i === 1);
    const recipients = members.map((m) => m.recipient);
    const { secrets, blob } = await seal(URL_A, recipients, intent, worker, sig);
    const [copier, elsewhere] = [wallet().address, wallet().address];
    for (const [i, w] of [
      [intent, copier],
      [elsewhere, worker],
    ] as const) {
      for (const m of members) {
        expect(await openDeliveryV4(blob, m.opener, i, w)).toBeNull();
      }
      expect(await openWithContentKey(blob, secrets.key, i, w)).toBeNull();
      expect(await openWithEsk(blob, secrets.esk, recipients, i, w)).toBeNull();
    }
    expect((await openWithContentKey(blob, secrets.key, intent, worker))?.url).toBe(URL_A);
  });

  it("gives the same blob for the same signature, url and recipients, and new secrets for another url", async () => {
    const { intent, worker, sig } = await job();
    const members = await committee(3, (i) => i !== 2);
    const recipients = members.map((m) => m.recipient);
    const a = await seal(URL_A, recipients, intent, worker, sig);
    const again = await seal(URL_A, [...recipients], intent, worker, Uint8Array.from(sig));
    const b = await seal(URL_B, recipients, intent, worker, sig);
    expect(hex(again.blob)).toBe(hex(a.blob));
    expect(hex(b.secrets.esk)).not.toBe(hex(a.secrets.esk));
    expect(hex(b.secrets.key)).not.toBe(hex(a.secrets.key));
    expect(hex(b.secrets.salt)).toBe(hex(a.secrets.salt));
    expect(hex(b.blob)).not.toBe(hex(a.blob));
    expect(hex(a.blob.subarray(27, 59))).not.toBe(hex(b.blob.subarray(27, 59)));
  });

  it("binds the recipient list, so resealing a url to other recipients never reuses the key or nonce", async () => {
    const { intent, worker, sig } = await job();
    const members = await committee(4, (i) => i === 0);
    const recipients = members.map((m) => m.recipient);
    const lists: SealRecipient[][] = [recipients, recipients.slice(0, 3), [...recipients].reverse(), recipients.map((r) => (typeof r === "string" ? r : r.wallet))];
    const sealed = await Promise.all(lists.map((list) => seal(URL_A, list, intent, worker, sig)));
    const field = (pick: (s: (typeof sealed)[number]) => Uint8Array) => new Set(sealed.map((s) => hex(pick(s)))).size;
    expect(field((s) => s.secrets.key)).toBe(lists.length);
    expect(field((s) => s.secrets.esk)).toBe(lists.length);
    expect(field((s) => s.blob.subarray(s.blob.length - 16 - 16 - URL_A.length))).toBe(lists.length);
    expect(field((s) => s.secrets.salt)).toBe(1);
    for (const s of sealed) {
      expect(hex(s.secrets.binding)).toBe(hex(s.blob.subarray(1, 3 + 8 * s.secrets.recipients.length)));
      expect(hex(s.secrets.binding)).toBe(hex(await recipientBinding(s.secrets.recipients)));
    }
  });

  it("keeps the random bytes a device-signed worker uses in place of the signature", async () => {
    const { intent, worker } = await job();
    const member = await profileMember();
    const first = await deliverySecrets(URL_A, [member.recipient]);
    const second = await deliverySecrets(URL_A, [member.recipient]);
    expect(first.source.length).toBe(RANDOM_SOURCE_LEN);
    expect(hex(first.source)).not.toBe(hex(second.source));
    const kept = await deliverySecrets(URL_A, [member.recipient], first.source);
    expect(kept).toEqual(first);
    const blob = await sealDeliveryV4(first, intent, worker);
    expect(hex(await sealDeliveryV4(kept, intent, worker))).toBe(hex(blob));
    expect((await openDeliveryV4(blob, member.opener, intent, worker))?.url).toBe(URL_A);
    await expect(deliverySecrets(URL_A, [member.recipient], new Uint8Array(33))).rejects.toThrow(InvalidInput);
  });

  it("lets a third party rebuild every wrap from the revealed ephemeral secret", async () => {
    const { intent, worker, sig } = await job();
    const members = await committee(8, (i) => i % 2 === 0);
    const recipients = members.map((m) => m.recipient);
    const { secrets, blob } = await seal(URL_A, recipients, intent, worker, sig);
    const confirmed = await openWithEsk(blob, secrets.esk, recipients, intent, worker);
    expect(confirmed?.url).toBe(URL_A);
    expect(hex(confirmed?.key ?? new Uint8Array())).toBe(hex(secrets.key));
    expect(hex(blob.subarray(3 + 8 * 8, 3 + 8 * 8 + 32))).toBe(hex(await ephemeralPublic(secrets.esk)));
    const garbage = Uint8Array.from(blob, (b, i) => (i < 3 + 8 * 8 ? b : crypto.getRandomValues(new Uint8Array(1))[0] ?? b));
    expect(delivery.blobHead(garbage).count).toBe(8);
    expect(await openWithEsk(garbage, secrets.esk, recipients, intent, worker)).toBeNull();
    const otherEsk = (await deliverySecrets(URL_B, recipients, sig)).esk;
    expect(await openWithEsk(blob, otherEsk, recipients, intent, worker)).toBeNull();
    expect(await openWithEsk(blob, secrets.esk, [...recipients].reverse(), intent, worker)).toBeNull();
    expect(await openWithEsk(blob, secrets.esk, recipients.slice(1), intent, worker)).toBeNull();
    const lied = recipients.map((r) => (typeof r === "string" ? r : r.wallet));
    expect(await openWithEsk(blob, secrets.esk, lied, intent, worker)).toBeNull();
    const flipped = Uint8Array.from(blob);
    flipped[3 + 8 * 8 + 64 + 32 * 5] = (flipped[3 + 8 * 8 + 64 + 32 * 5] ?? 0) ^ 1;
    expect(await openWithEsk(flipped, secrets.esk, recipients, intent, worker)).toBeNull();
    const member = members[0];
    expect(member === undefined ? null : (await openDeliveryV4(flipped, member.opener, intent, worker))?.url).toBe(URL_A);
  });

  it("refuses a revealed ephemeral secret that does not match what the recipients can open", async () => {
    const { intent, worker, sig } = await job();
    const members = await committee(3, (i) => i === 2);
    const recipients = members.map((m) => m.recipient);
    const keys = members.map((m) => ({ key: m.key, profile: m.profile }));
    const base = { source: sig, url: URL_A, intent, worker };
    const honest = referenceBlob({ ...base, recipients: keys });
    const eskOf = (blob: Uint8Array) => refSecrets(sig, URL_A, refBinding(blob)).esk;
    expect((await openWithEsk(honest, eskOf(honest), recipients, intent, worker))?.url).toBe(URL_A);
    const other = crypto.getRandomValues(new Uint8Array(32));
    const fake = clamp(crypto.getRandomValues(new Uint8Array(32)));
    const forged = {
      uncommitted: referenceBlob({ ...base, recipients: keys, slotKey: () => other, contentKey: () => other }),
      fingerprint: referenceBlob({ ...base, recipients: keys, fingerprint: (i, fp) => (i === 1 ? fp.map((b) => b ^ 0xff) : fp) }),
      mask: referenceBlob({ ...base, recipients: keys.map((k, i) => (i === 2 ? { ...k, profile: false } : k)) }),
      ephemeral: referenceBlob({ ...base, recipients: keys, wrapEsk: fake }),
    };
    for (const [name, blob] of Object.entries(forged)) {
      expect(await openWithEsk(blob, name === "ephemeral" ? fake : eskOf(blob), recipients, intent, worker), name).toBeNull();
    }
    for (const m of members) {
      expect(await openDeliveryV4(forged.uncommitted, m.opener, intent, worker)).toBeNull();
      expect(await openDeliveryV4(forged.ephemeral, m.opener, intent, worker)).toBeNull();
    }
    expect(await openDeliveryV4(forged.fingerprint, members[1]?.opener ?? new Uint8Array(), intent, worker)).toBeNull();
  });

  it("seals only blobs blobHead accepts, with the head it reads back", async () => {
    const { intent, worker, sig } = await job();
    for (const n of [1, 2, 5, 8]) {
      for (const length of [24, 117, 200]) {
        const members = await committee(n, (i) => (i + length) % 2 === 0);
        const { blob } = await seal(urlOf(length), members.map((m) => m.recipient), intent, worker, sig);
        const head = delivery.blobHead(blob);
        expect(blob.length).toBe(99 + 40 * n + length);
        expect(head.count).toBe(n);
        expect(head.urlLen).toBe(length);
        expect(head.mask).toBe(members.reduce((m, x, i) => (x.profile ? m | (1 << i) : m), 0));
        expect(head.fps.slice(0, n).map(hex)).toEqual(Array.from({ length: n }, (_, i) => hex(blob.subarray(3 + 8 * i, 11 + 8 * i))));
      }
    }
  });

  it("refuses recipients, urls and sources outside the format", async () => {
    const { intent, worker, sig } = await job();
    const nine = await committee(9, () => false);
    const one = nine[0];
    if (one === undefined) {
      throw new Error("no member");
    }
    await expect(deliverySecrets(URL_A, [], sig)).rejects.toThrow(SealedError);
    await expect(deliverySecrets(URL_A, nine.map((m) => m.recipient), sig)).rejects.toThrow(SealedError);
    await expect(deliverySecrets(URL_A, [one.recipient, one.recipient], sig)).rejects.toThrow(SealedError);
    const weak = { wallet: wallet().address, encryptionKey: new Uint8Array(32) };
    await expect(deliverySecrets(URL_A, [weak], sig)).rejects.toThrow(SealedError);
    await expect(deliverySecrets("http://example.org/plain", [one.recipient], sig)).rejects.toThrow(InvalidInput);
    await expect(deliverySecrets(urlOf(201), [one.recipient], sig)).rejects.toThrow(InvalidInput);
    const secrets = await deliverySecrets(URL_A, [one.recipient], sig);
    await expect(sealDeliveryV4({ ...secrets, url: urlOf(201) }, intent, worker)).rejects.toThrow(InvalidInput);
    await expect(sealDeliveryV4({ ...secrets, recipients: [] }, intent, worker)).rejects.toThrow(SealedError);
    const relabelled = await sealDeliveryV4({ ...secrets, url: URL_B }, intent, worker);
    expect(hex(relabelled)).toBe(hex((await seal(URL_B, [one.recipient], intent, worker, sig)).blob));
    const moved = await sealDeliveryV4({ ...secrets, recipients: [nine[1]?.recipient ?? one.recipient] }, intent, worker);
    expect(hex(moved)).toBe(hex((await seal(URL_A, [nine[1]?.recipient ?? one.recipient], intent, worker, sig)).blob));
    const zeroed: DeliverySecrets = { ...secrets, binding: new Uint8Array(10), key: new Uint8Array(32), esk: new Uint8Array(32) };
    expect(hex(await sealDeliveryV4(zeroed, intent, worker))).toBe(hex(await sealDeliveryV4(secrets, intent, worker)));
    expect(await openDeliveryV4(new Uint8Array([4, 1, 0]), one.opener, intent, worker)).toBeNull();
  });

  it("round-trips any canonical url for any set of recipients, and keeps the url out of the blob", async () => {
    const { intent, worker } = await job();
    const pool = await committee(4, (i) => i % 2 === 1);
    await fc.assert(
      fc.asyncProperty(fc.stringMatching(/^[a-z0-9]{1,60}$/), fc.subarray(pool, { minLength: 1 }), fc.uint8Array({ minLength: 32, maxLength: 32 }), async (path, chosen, source) => {
        const url = "https://example.org/" + path;
        const { secrets, blob } = await seal(url, chosen.map((m) => m.recipient), intent, worker, source);
        expect(Buffer.from(blob).toString("latin1")).not.toContain("example.org");
        for (const m of chosen) {
          const opened = await openDeliveryV4(blob, m.opener, intent, worker);
          expect([opened?.url, hex(opened?.salt ?? new Uint8Array())]).toEqual([url, hex(secrets.salt)]);
        }
      }),
      { numRuns: 15 },
    );
  });
});

describe("delivery salts", () => {
  const saltOf = async (signer: Wallet, intent: Address, sha256: string): Promise<Uint8Array> =>
    (await deliverySecrets(URL_A, [wallet().address], saltSignature(signer, intent, sha256))).salt;

  it("derive the salt from the worker's own signature of the salt message, so only its key recomputes it", async () => {
    const [worker, other] = [wallet(), wallet()];
    const intent = wallet().address;
    const salt = hex(await saltOf(worker, intent, WORK));
    expect(isSaltHex(salt)).toBe(true);
    expect(hex(await saltOf(worker, intent, WORK))).toBe(salt);
    expect(hex(await saltOf(other, intent, WORK))).not.toBe(salt);
    expect(hex(await saltOf(worker, wallet().address, WORK))).not.toBe(salt);
    expect(hex(await saltOf(worker, intent, YES))).not.toBe(salt);
    expect(SALT_TAG).toBe(`${PRODUCT_SLUG}-delivery-salt-v3`);
    expect(saltMessage(intent, WORK)).toEqual(Uint8Array.from([...Buffer.from(SALT_TAG), ...getAddressEncoder().encode(intent), ...Buffer.from(WORK, "hex")]));
    expect(() => saltMessage(intent, "zz")).toThrow(InvalidInput);
    expect(() => saltMessage(intent, WORK.toUpperCase())).toThrow(InvalidInput);
    expect(["ab".repeat(16), "AB".repeat(16), "ab".repeat(15), "ab".repeat(17), "zz".repeat(16)].map(isSaltHex)).toEqual([true, false, false, false, false]);
  });

  it("leave a copier who knows a two-value candidate set unable to match an honest commitment before it is opened", async () => {
    const [worker, copier] = [wallet(), wallet()];
    const intent = wallet().address;
    const commit = async (salt: Uint8Array, sha256: string) =>
      hex(await announcementCommitment(intent, worker.address, { delivered: Uint8Array.from(Buffer.from(sha256, "hex")), salt }));
    const honest = await commit(await saltOf(worker, intent, YES), YES);
    const guesses = await Promise.all(
      [YES, NO].flatMap((sha256) => [new Uint8Array(16), new Uint8Array(16).fill(0xff), new Uint8Array(16).fill(0xab)].map((guessed) => commit(guessed, sha256))),
    );
    expect(guesses).not.toContain(honest);
    const copied = await Promise.all([YES, NO].map(async (sha256) => commit(await saltOf(copier, intent, sha256), sha256)));
    expect(copied).not.toContain(honest);
  });
});
