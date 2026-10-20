import { createHash, createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { type Address, getAddressDecoder } from "@solana/kit";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  COMMITMENT_TAG,
  commitmentPreimage,
  DELIVERY_MEMO_PREFIX,
  deliveryCommitment,
  deliveryMemo,
  MAX_COMMITTEE_MEMBERS,
  MAX_DELIVERY_MEMO,
  MAX_MEMO_URL,
  MAX_OPENED_SALTS,
  MAX_OPENING_MEMO,
  MAX_SEALED_URL_RECIPIENTS,
  maxSealedUrl,
  OPENING_MEMO_PREFIX,
  openDelivery,
  openingMemo,
  parseDeliveryMemo,
  parseOpeningMemo,
  parseRelease,
  parseReleaseMemo,
  PRODUCT_SLUG,
  releaseMemo,
  SALT_BYTES,
  saltCheck,
  saltCheckPreimage,
  saltMessage,
  saltOfSignature,
  sealDelivery,
  sealedUrlRecipients,
  sealedUrlTooLong,
} from "../src/index.js";

type Wallet = { address: Address; keypair: Uint8Array; sign: (message: Uint8Array) => Uint8Array };

function wallet(): Wallet {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  const keypair = Uint8Array.from([...Buffer.from(jwk.d ?? "", "base64url"), ...Buffer.from(jwk.x ?? "", "base64url")]);
  const key = createPrivateKey({ key: jwk, format: "jwk" });
  return { address: getAddressDecoder().decode(keypair.slice(32)), keypair, sign: (message) => new Uint8Array(sign(null, message, key)) };
}

const WORK = createHash("sha256").update("the work").digest("hex");
const YES = createHash("sha256").update("yes").digest("hex");
const NO = createHash("sha256").update("no").digest("hex");
const URL = "https://example.org/work.tar";
const SALT = "ab".repeat(SALT_BYTES);
const urlOf = (length: number) => "https://example.org/" + "a".repeat(length - "https://example.org/".length);
const saltOf = (worker: Wallet, intent: Address, sha256: string) => saltOfSignature(worker.sign(saltMessage(intent, sha256)));
const signatureText = "5".repeat(87);

describe("sealed delivery memos", () => {
  it("bind the work's hash to the intent, the announcing wallet and its salt", async () => {
    const [intent, worker, copier] = [wallet().address, wallet().address, wallet().address];
    const c = await deliveryCommitment({ intent, worker, salt: SALT, sha256: WORK });
    const preimage = commitmentPreimage({ intent, worker, salt: SALT, sha256: WORK });
    expect(c).toBe(createHash("sha256").update(preimage).digest("hex"));
    expect(Buffer.from(preimage.subarray(0, COMMITMENT_TAG.length)).toString()).toBe(COMMITMENT_TAG);
    expect(preimage.length).toBe(COMMITMENT_TAG.length + 96 + SALT_BYTES);
    expect(await deliveryCommitment({ intent, worker: copier, salt: SALT, sha256: WORK })).not.toBe(c);
    expect(await deliveryCommitment({ intent: copier, worker, salt: SALT, sha256: WORK })).not.toBe(c);
    expect(await deliveryCommitment({ intent, worker, salt: "cd".repeat(SALT_BYTES), sha256: WORK })).not.toBe(c);
    expect(await deliveryCommitment({ intent, worker, salt: SALT, sha256: "cd".repeat(32) })).not.toBe(c);
    expect(() => commitmentPreimage({ intent, worker, salt: SALT, sha256: "zz".repeat(32) })).toThrow(RangeError);
    expect(() => commitmentPreimage({ intent, worker, salt: "ab", sha256: WORK })).toThrow(RangeError);
  });

  it("derive the salt from the worker's own deterministic signature, so only its key recomputes it", async () => {
    const [worker, other] = [wallet(), wallet()];
    const intent = wallet().address;
    const salt = await saltOf(worker, intent, WORK);
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    expect(await saltOf(worker, intent, WORK)).toBe(salt);
    expect(await saltOf(other, intent, WORK)).not.toBe(salt);
    expect(await saltOf(worker, wallet().address, WORK)).not.toBe(salt);
    expect(await saltOf(worker, intent, YES)).not.toBe(salt);
    expect(() => saltMessage(intent, "zz")).toThrow(RangeError);
    await expect(saltOfSignature(new Uint8Array(63))).rejects.toThrow(RangeError);
  });

  it("leave a copier who knows a two-value candidate set unable to match an honest commitment before it is opened", async () => {
    const [worker, copier] = [wallet(), wallet()];
    const intent = wallet().address;
    const salt = await saltOf(worker, intent, YES);
    const honest = await deliveryCommitment({ intent, worker: worker.address, salt, sha256: YES });
    const guesses = [YES, NO].flatMap((sha256) =>
      ["00".repeat(SALT_BYTES), "ff".repeat(SALT_BYTES), SALT].map((guessed) => deliveryCommitment({ intent, worker: worker.address, salt: guessed, sha256 })),
    );
    expect(await Promise.all(guesses)).not.toContain(honest);
    const copied = await Promise.all([YES, NO].map(async (sha256) => deliveryCommitment({ intent, worker: worker.address, salt: await saltOf(copier, intent, sha256), sha256 })));
    expect(copied).not.toContain(honest);
  });

  it("seal the salt and url so each committee member opens both and an outsider reads nothing", async () => {
    const members = Array.from({ length: MAX_COMMITTEE_MEMBERS }, wallet);
    const outsider = wallet();
    const intent = wallet().address;
    const salt = await saltOf(outsider, intent, WORK);
    const blob = await sealDelivery({ salt, url: URL }, members.map((m) => m.address), intent);
    expect(sealedUrlRecipients(blob)).toBe(MAX_COMMITTEE_MEMBERS);
    for (const member of members) {
      expect(await openDelivery(blob, member.keypair, intent)).toEqual({ salt, url: URL });
    }
    expect(await openDelivery(blob, outsider.keypair, intent)).toBeNull();
    expect(await openDelivery(blob, members[0]?.keypair ?? new Uint8Array(), wallet().address)).toBeNull();
    const check = await saltCheck(salt);
    const memo = deliveryMemo({ intent, commitment: await deliveryCommitment({ intent, worker: outsider.address, salt, sha256: WORK }), check, blob });
    expect(memo).not.toContain("example.org");
    expect(memo).not.toContain(WORK);
    expect(memo).not.toContain(salt);
    expect(Buffer.from(blob, "base64").toString("latin1")).not.toContain("example.org");
  });

  it("round-trip any canonical url and salt for any number of recipients", async () => {
    const pool = Array.from({ length: 4 }, wallet);
    const intent = wallet().address;
    await fc.assert(
      fc.asyncProperty(fc.stringMatching(/^[a-z0-9]{1,60}$/), fc.subarray(pool, { minLength: 1 }), fc.uint8Array({ minLength: 16, maxLength: 16 }), async (path, chosen, raw) => {
        const url = "https://example.org/" + path;
        const salt = Buffer.from(raw).toString("hex");
        const blob = await sealDelivery({ salt, url }, chosen.map((w) => w.address), intent);
        for (const w of chosen) {
          expect(await openDelivery(blob, w.keypair, intent)).toEqual({ salt, url });
        }
      }),
      { numRuns: 15 },
    );
  });

  it("refuse a changed blob", async () => {
    const judge = wallet();
    const intent = wallet().address;
    const bytes = Buffer.from(await sealDelivery({ salt: SALT, url: URL }, [judge.address], intent), "base64");
    for (const at of [2, 40, bytes.length - 1]) {
      const changed = Buffer.from(bytes);
      changed[at] = (changed[at] ?? 0) ^ 1;
      expect(await openDelivery(changed.toString("base64"), judge.keypair, intent)).toBeNull();
    }
    expect(sealedUrlRecipients("not base64!")).toBeNull();
    expect(sealedUrlRecipients(Buffer.from([1, 1, ...new Uint8Array(200)]).toString("base64"))).toBeNull();
    expect(sealedUrlRecipients(Buffer.from([2, 0, ...new Uint8Array(200)]).toString("base64"))).toBeNull();
    expect(sealedUrlRecipients(Buffer.from([2, 9, ...new Uint8Array(600)]).toString("base64"))).toBeNull();
  });

  it("parse back what they write, and nothing else", async () => {
    const judge = wallet();
    const intent = wallet().address;
    const commitment = await deliveryCommitment({ intent, worker: judge.address, salt: SALT, sha256: WORK });
    const check = await saltCheck(SALT);
    const blob = await sealDelivery({ salt: SALT, url: URL }, [judge.address], intent);
    const memo = deliveryMemo({ intent, commitment, check, blob });
    expect(memo.startsWith(DELIVERY_MEMO_PREFIX)).toBe(true);
    expect(parseDeliveryMemo(memo)).toEqual({ intent, commitment, check, blob });
    expect(parseDeliveryMemo(`${PRODUCT_SLUG}-delivery2:${intent}:${commitment}:${blob}`)).toBeNull();
    const bad = [
      `${memo}:x`,
      `${memo} `,
      memo.replace(commitment, commitment.toUpperCase()),
      memo.replace(check, "zz".repeat(SALT_BYTES)),
      `${DELIVERY_MEMO_PREFIX}${intent}:${commitment}:${check}:`,
      `${DELIVERY_MEMO_PREFIX}x:${commitment}:${check}:${blob}`,
    ];
    for (const text of bad) {
      expect(parseDeliveryMemo(text)).toBeNull();
    }
    expect(() => deliveryMemo({ intent, commitment: "zz", check, blob })).toThrow(RangeError);
    expect(() => deliveryMemo({ intent, commitment, check: "ab", blob })).toThrow(RangeError);
    expect(() => deliveryMemo({ intent, commitment, check, blob: "AAAA" })).toThrow(RangeError);
    expect(() => deliveryMemo({ intent: "x" as Address, commitment, check, blob })).toThrow(RangeError);
  });

  it("refuse a url too long for one transaction before sealing, naming the limit", async () => {
    const members = Array.from({ length: MAX_COMMITTEE_MEMBERS }, wallet);
    const intent = wallet().address;
    const limit = maxSealedUrl(MAX_COMMITTEE_MEMBERS);
    expect(maxSealedUrl(1)).toBe(MAX_MEMO_URL);
    expect(limit).toBeLessThan(MAX_MEMO_URL);
    const fits = await sealDelivery({ salt: SALT, url: urlOf(limit) }, members.map((m) => m.address), intent);
    const commitment = await deliveryCommitment({ intent, worker: intent, salt: SALT, sha256: WORK });
    expect(deliveryMemo({ intent, commitment, check: await saltCheck(SALT), blob: fits }).length).toBeLessThanOrEqual(MAX_DELIVERY_MEMO);
    const long = urlOf(limit + 1);
    await expect(sealDelivery({ salt: SALT, url: long }, members.map((m) => m.address), intent)).rejects.toThrow(sealedUrlTooLong(long.length, MAX_COMMITTEE_MEMBERS));
    expect(sealedUrlTooLong(long.length, MAX_COMMITTEE_MEMBERS)).toContain(`at most ${limit}`);
    await expect(sealDelivery({ salt: SALT, url: URL }, [], intent)).rejects.toThrow("between 1 and");
    await expect(sealDelivery({ salt: SALT, url: "ftp://example.org/x" }, [intent], intent)).rejects.toThrow(RangeError);
    await expect(sealDelivery({ salt: "ab", url: URL }, [intent], intent)).rejects.toThrow(RangeError);
  });
});

describe("sealed delivery bounds", () => {
  const LONGEST = getAddressDecoder().decode(new Uint8Array(32).fill(0xff));
  const blobOf = (head: number[], length: number) => Buffer.from([...head, ...new Uint8Array(length - head.length)]).toString("base64");

  it("fit the longest url each recipient count allows into one memo, even for the longest intent", async () => {
    expect(LONGEST).toHaveLength(44);
    const members = Array.from({ length: MAX_SEALED_URL_RECIPIENTS }, wallet);
    const commitment = await deliveryCommitment({ intent: LONGEST, worker: LONGEST, salt: SALT, sha256: WORK });
    const check = await saltCheck(SALT);
    let bound = 0;
    for (let n = 1; n <= MAX_SEALED_URL_RECIPIENTS; n += 1) {
      const limit = maxSealedUrl(n);
      bound += limit < MAX_MEMO_URL ? 1 : 0;
      const blob = await sealDelivery({ salt: SALT, url: urlOf(limit) }, members.slice(0, n).map((m) => m.address), LONGEST);
      const memo = deliveryMemo({ intent: LONGEST, commitment, check, blob });
      expect(memo.length, `${n} recipients`).toBeLessThanOrEqual(MAX_DELIVERY_MEMO);
      const oneMore = memo.length - blob.length + 4 * Math.ceil((Buffer.from(blob, "base64").length + 1) / 3);
      expect(limit === MAX_MEMO_URL || oneMore > MAX_DELIVERY_MEMO, `${n} recipients`).toBe(true);
    }
    expect(bound).toBeGreaterThan(0);
    expect(maxSealedUrl(4 * MAX_SEALED_URL_RECIPIENTS)).toBe(0);
  });

  it("fit the most salts into one opening memo for the longest intent", () => {
    const full = openingMemo({ intent: LONGEST, salts: Array.from({ length: MAX_OPENED_SALTS }, () => SALT) });
    expect(full.length).toBeLessThanOrEqual(MAX_OPENING_MEMO);
    expect(full.length + 1 + 2 * SALT_BYTES).toBeGreaterThan(MAX_OPENING_MEMO);
  });

  it("name the wallet count and the salt length in their refusals", () => {
    expect(sealedUrlTooLong(300, 1)).toContain("sealed to 1 wallet it may");
    expect(sealedUrlTooLong(300, 2)).toContain("sealed to 2 wallets it may");
    expect(() => saltCheckPreimage("ab")).toThrow(`a salt is ${2 * SALT_BYTES} lowercase hex digits`);
  });

  it("read a sealed url's layout only when every header field is sound and the body is longer than an empty url", () => {
    const empty = 3 + 8 + 32 + 48 + 12 + 16 + 16;
    expect(sealedUrlRecipients(blobOf([3, 1, 0], 301))).toBe(1);
    expect(sealedUrlRecipients(blobOf([3, 1, 0], empty + 1))).toBe(1);
    expect(sealedUrlRecipients(blobOf([3, 1, 0], empty))).toBeNull();
    const canonical = blobOf([3, 1, 0], 301);
    expect(canonical.endsWith("A==")).toBe(true);
    const loose = `${canonical.slice(0, -3)}B==`;
    expect(Buffer.from(loose, "base64")).toEqual(Buffer.from(canonical, "base64"));
    expect(sealedUrlRecipients(loose)).toBeNull();
    expect(sealedUrlRecipients(blobOf([2, 1, 0], 301))).toBeNull();
    expect(sealedUrlRecipients(blobOf([3, 0, 0], 301))).toBeNull();
    expect(sealedUrlRecipients(blobOf([3, MAX_SEALED_URL_RECIPIENTS + 1, 0], 1000))).toBeNull();
    expect(sealedUrlRecipients(blobOf([3, MAX_SEALED_URL_RECIPIENTS, 0], 1000))).toBe(MAX_SEALED_URL_RECIPIENTS);
    expect(sealedUrlRecipients(blobOf([3, 2, 0b100], 1000))).toBeNull();
    expect(sealedUrlRecipients(blobOf([3, 2, 0b10], 1000))).toBe(2);
  });

  it("parse a delivery memo of exactly the most bytes, and refuse one byte more", async () => {
    const intent = wallet().address;
    const head = `${DELIVERY_MEMO_PREFIX}${intent}:${WORK}:${await saltCheck(SALT)}:`;
    const exact = head + "A".repeat(MAX_DELIVERY_MEMO - head.length);
    expect(parseDeliveryMemo(exact)).toEqual({ intent, commitment: WORK, check: await saltCheck(SALT), blob: exact.slice(head.length) });
    expect(parseDeliveryMemo(`${exact}A`)).toBeNull();
  });

  it("refuse an opening memo with a foreign prefix or a trailing field", () => {
    const intent = wallet().address;
    const memo = openingMemo({ intent, announcement: signatureText, salt: SALT });
    expect(parseOpeningMemo(memo)).toEqual({ intent, announcement: signatureText, salt: SALT });
    expect(parseOpeningMemo(`${memo}:${SALT}`)).toBeNull();
    expect(parseOpeningMemo("x".repeat(OPENING_MEMO_PREFIX.length) + memo.slice(OPENING_MEMO_PREFIX.length))).toBeNull();
  });
});

describe("salt checks", () => {
  it("let a revealed salt be matched to its announcement without the work's hash", async () => {
    const check = await saltCheck(SALT);
    expect(check).toMatch(/^[0-9a-f]{32}$/);
    expect(await saltCheck(SALT)).toBe(check);
    expect(await saltCheck("cd".repeat(SALT_BYTES))).not.toBe(check);
    await expect(saltCheck("AB".repeat(SALT_BYTES))).rejects.toThrow(RangeError);
  });
});

describe("opening memos", () => {
  it("list a judge's salts in order, with a dash for each it could not open", () => {
    const intent = wallet().address;
    const salts = [SALT, null, "cd".repeat(SALT_BYTES)];
    const memo = openingMemo({ intent, salts });
    expect(memo).toBe(`${OPENING_MEMO_PREFIX}${intent}:${SALT},-,${"cd".repeat(SALT_BYTES)}`);
    expect(parseOpeningMemo(memo)).toEqual({ intent, salts });
    expect(memo.startsWith(DELIVERY_MEMO_PREFIX)).toBe(false);
    expect(parseDeliveryMemo(memo)).toBeNull();
  });

  it("name one announcement when its announcer opens it", () => {
    const intent = wallet().address;
    const memo = openingMemo({ intent, announcement: signatureText, salt: SALT });
    expect(parseOpeningMemo(memo)).toEqual({ intent, announcement: signatureText, salt: SALT });
  });

  it("fit the most salts one memo holds, and refuse more or malformed ones", () => {
    const intent = wallet().address;
    const full = openingMemo({ intent, salts: Array.from({ length: MAX_OPENED_SALTS }, () => SALT) });
    expect(full.length).toBeLessThanOrEqual(MAX_DELIVERY_MEMO);
    expect(parseOpeningMemo(full)).not.toBeNull();
    expect(() => openingMemo({ intent, salts: Array.from({ length: MAX_OPENED_SALTS + 1 }, () => SALT) })).toThrow(RangeError);
    expect(() => openingMemo({ intent, salts: [] })).toThrow(RangeError);
    expect(() => openingMemo({ intent, salts: ["ab"] })).toThrow(RangeError);
    expect(() => openingMemo({ intent, announcement: "x", salt: SALT })).toThrow(RangeError);
    expect(() => openingMemo({ intent: "x" as Address, salts: [SALT] })).toThrow(RangeError);
    for (const text of [`${OPENING_MEMO_PREFIX}${intent}:ab`, `${OPENING_MEMO_PREFIX}${intent}:${signatureText}:ab`, `${OPENING_MEMO_PREFIX}x:${SALT}`, `${OPENING_MEMO_PREFIX}${intent}:a:b:c`]) {
      expect(parseOpeningMemo(text)).toBeNull();
    }
  });
});

describe("release memos", () => {
  it("record the payee's salt beside the work's hash and still read as that hash", () => {
    const memo = releaseMemo(WORK, SALT);
    expect(memo).toBe(`delivery sha256:${WORK} salt:${SALT}`);
    expect(parseRelease(memo)).toEqual({ sha256: WORK, salt: SALT });
    expect(parseReleaseMemo(memo)).toBe(WORK);
    expect(parseRelease(releaseMemo(WORK))).toEqual({ sha256: WORK });
    expect(parseRelease(`${memo} salt:${SALT}`)).toBeNull();
    expect(parseRelease(`delivery sha256:${WORK} salt:ab`)).toBeNull();
    expect(() => releaseMemo(WORK, "ab")).toThrow(RangeError);
  });
});
