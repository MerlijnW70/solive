import { createHash, generateKeyPairSync } from "node:crypto";
import { type Address, getAddressDecoder } from "@solana/kit";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  COMMITMENT_TAG,
  commitmentPreimage,
  DELIVERY_V2_MEMO_PREFIX,
  deliveryCommitment,
  deliveryMemoV2,
  MAX_COMMITTEE_MEMBERS,
  MAX_DELIVERY_V2_MEMO,
  MAX_MEMO_URL,
  maxSealedUrl,
  openUrl,
  parseDeliveryMemoV2,
  PRODUCT_SLUG,
  sealedUrlRecipients,
  sealedUrlTooLong,
  sealUrl,
} from "../src/index.js";

function wallet(): { address: Address; keypair: Uint8Array } {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  const keypair = Uint8Array.from([...Buffer.from(jwk.d ?? "", "base64url"), ...Buffer.from(jwk.x ?? "", "base64url")]);
  return { address: getAddressDecoder().decode(keypair.slice(32)), keypair };
}

const WORK = createHash("sha256").update("the work").digest("hex");
const URL = "https://example.org/work.tar";
const urlOf = (length: number) => "https://example.org/" + "a".repeat(length - "https://example.org/".length);

describe("sealed delivery memos", () => {
  it("bind the work's hash to the intent and the announcing wallet", async () => {
    const [intent, worker, copier] = [wallet().address, wallet().address, wallet().address];
    const c = await deliveryCommitment({ intent, worker, sha256: WORK });
    const preimage = commitmentPreimage({ intent, worker, sha256: WORK });
    expect(c).toBe(createHash("sha256").update(preimage).digest("hex"));
    expect(Buffer.from(preimage.subarray(0, COMMITMENT_TAG.length)).toString()).toBe(COMMITMENT_TAG);
    expect(preimage.length).toBe(COMMITMENT_TAG.length + 96);
    expect(await deliveryCommitment({ intent, worker: copier, sha256: WORK })).not.toBe(c);
    expect(await deliveryCommitment({ intent: copier, worker, sha256: WORK })).not.toBe(c);
    expect(await deliveryCommitment({ intent, worker, sha256: "cd".repeat(32) })).not.toBe(c);
    expect(() => commitmentPreimage({ intent, worker, sha256: "zz".repeat(32) })).toThrow(RangeError);
  });

  it("seal the url so each committee member opens it and an outsider reads nothing", async () => {
    const members = Array.from({ length: MAX_COMMITTEE_MEMBERS }, wallet);
    const outsider = wallet();
    const intent = wallet().address;
    const blob = await sealUrl(URL, members.map((m) => m.address), intent);
    expect(sealedUrlRecipients(blob)).toBe(MAX_COMMITTEE_MEMBERS);
    for (const member of members) {
      expect(await openUrl(blob, member.keypair, intent)).toBe(URL);
    }
    expect(await openUrl(blob, outsider.keypair, intent)).toBeNull();
    expect(await openUrl(blob, members[0]?.keypair ?? new Uint8Array(), wallet().address)).toBeNull();
    const memo = deliveryMemoV2({ intent, commitment: await deliveryCommitment({ intent, worker: outsider.address, sha256: WORK }), blob });
    expect(memo).not.toContain("example.org");
    expect(memo).not.toContain(WORK);
    expect(Buffer.from(blob, "base64").toString("latin1")).not.toContain("example.org");
  });

  it("round-trip any canonical url for any number of recipients", async () => {
    const pool = Array.from({ length: 4 }, wallet);
    const intent = wallet().address;
    await fc.assert(
      fc.asyncProperty(fc.stringMatching(/^[a-z0-9]{1,60}$/), fc.subarray(pool, { minLength: 1 }), async (path, chosen) => {
        const url = "https://example.org/" + path;
        const blob = await sealUrl(url, chosen.map((w) => w.address), intent);
        for (const w of chosen) {
          expect(await openUrl(blob, w.keypair, intent)).toBe(url);
        }
      }),
      { numRuns: 15 },
    );
  });

  it("refuse a changed blob", async () => {
    const judge = wallet();
    const intent = wallet().address;
    const bytes = Buffer.from(await sealUrl(URL, [judge.address], intent), "base64");
    for (const at of [2, 40, bytes.length - 1]) {
      const changed = Buffer.from(bytes);
      changed[at] = (changed[at] ?? 0) ^ 1;
      expect(await openUrl(changed.toString("base64"), judge.keypair, intent)).toBeNull();
    }
    expect(sealedUrlRecipients("not base64!")).toBeNull();
    expect(sealedUrlRecipients(Buffer.from([2, 1, ...new Uint8Array(200)]).toString("base64"))).toBeNull();
    expect(sealedUrlRecipients(Buffer.from([1, 0, ...new Uint8Array(200)]).toString("base64"))).toBeNull();
    expect(sealedUrlRecipients(Buffer.from([1, 9, ...new Uint8Array(600)]).toString("base64"))).toBeNull();
  });

  it("parse back what they write, and nothing else", async () => {
    const judge = wallet();
    const intent = wallet().address;
    const commitment = await deliveryCommitment({ intent, worker: judge.address, sha256: WORK });
    const blob = await sealUrl(URL, [judge.address], intent);
    const memo = deliveryMemoV2({ intent, commitment, blob });
    expect(memo.startsWith(DELIVERY_V2_MEMO_PREFIX)).toBe(true);
    expect(parseDeliveryMemoV2(memo)).toEqual({ intent, commitment, blob });
    expect(parseDeliveryMemoV2(`${PRODUCT_SLUG}-delivery:${intent}:${WORK}:${URL}`)).toBeNull();
    for (const bad of [`${memo}:x`, `${memo} `, memo.replace(commitment, commitment.toUpperCase()), `${DELIVERY_V2_MEMO_PREFIX}${intent}:${commitment}:`, `${DELIVERY_V2_MEMO_PREFIX}x:${commitment}:${blob}`]) {
      expect(parseDeliveryMemoV2(bad)).toBeNull();
    }
    expect(() => deliveryMemoV2({ intent, commitment: "zz", blob })).toThrow(RangeError);
    expect(() => deliveryMemoV2({ intent, commitment, blob: "AAAA" })).toThrow(RangeError);
    expect(() => deliveryMemoV2({ intent: "x" as Address, commitment, blob })).toThrow(RangeError);
  });

  it("refuse a url too long for one transaction before sealing, naming the limit", async () => {
    const members = Array.from({ length: MAX_COMMITTEE_MEMBERS }, wallet);
    const intent = wallet().address;
    const limit = maxSealedUrl(MAX_COMMITTEE_MEMBERS);
    expect(maxSealedUrl(1)).toBe(MAX_MEMO_URL);
    expect(limit).toBeLessThan(MAX_MEMO_URL);
    const fits = await sealUrl(urlOf(limit), members.map((m) => m.address), intent);
    const commitment = await deliveryCommitment({ intent, worker: intent, sha256: WORK });
    expect(deliveryMemoV2({ intent, commitment, blob: fits }).length).toBeLessThanOrEqual(MAX_DELIVERY_V2_MEMO);
    const long = urlOf(limit + 1);
    await expect(sealUrl(long, members.map((m) => m.address), intent)).rejects.toThrow(sealedUrlTooLong(long.length, MAX_COMMITTEE_MEMBERS));
    expect(sealedUrlTooLong(long.length, MAX_COMMITTEE_MEMBERS)).toContain(`at most ${limit}`);
    await expect(sealUrl(URL, [], intent)).rejects.toThrow("between 1 and");
    await expect(sealUrl("ftp://example.org/x", [intent], intent)).rejects.toThrow(RangeError);
  });
});
