import { type Address, getAddressDecoder } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  ATTEST_DELIVERY_PREIMAGE_LEN,
  ATTEST_DELIVERY_TAG,
  ATTEST_PROOF_TAG,
  ATTEST_SPLIT_DELIVERY_PREIMAGE_LEN,
  ATTEST_SPLIT_DELIVERY_TAG,
  ATTEST_SPLIT_TAG,
  ATTEST_TAG,
  COMMITTEE_COSIGN_TAG,
  COMMITTEE_TAG,
  INTENT_TAG,
  SPLIT_COSIGN_TAG,
  type AttestedDeliveryFields,
  attestedDeliveryPreimage,
  attestedSplitDeliveryPreimage,
  delivery,
  IntentCoreError,
} from "../src/index.js";

const {
  BLOB_FIXED_LEN,
  BLOB_PER_RECIPIENT_LEN,
  BLOB_VERSION,
  COMMITMENT_TAG,
  FINGERPRINT_TAG,
  MAX_BLOB_RECIPIENTS,
  MAX_BLOB_URL,
  MAX_SEALED_BLOB,
  MAX_SPLIT_RECIPIENTS,
  REFUTE_WINDOW_SECS,
  blobHead,
  closable,
  commitmentPreimage,
  decodeAnnState,
  encodeAnnState,
  fingerprintPreimage,
  mayAnnounce,
  refutes,
  splitHashPreimage,
} = delivery;

const I64_MAX = (1n << 63n) - 1n;
const ascii = (s: string) => new TextEncoder().encode(s);
const fill = (byte: number, length = 32) => new Uint8Array(length).fill(byte);
const address = (byte: number): Address => getAddressDecoder().decode(fill(byte));
const le = (v: bigint, length: number) => Uint8Array.from({ length }, (_, i) => Number((v >> BigInt(8 * i)) & 0xffn));

const INTENT = address(1);
const WORKER = address(2);
const OTHER = address(3);
const SALT = fill(4, 16);
const SHA = fill(5);

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof IntentCoreError) {
      return error.code;
    }
    throw error;
  }
  return "accepted";
}

function blob(count: number, mask: number, url: number): Uint8Array {
  const head = [BLOB_VERSION, count, mask];
  const fps = Array.from({ length: count }, (_, i) => Array.from(fill((i + 10) & 0xff, 8)));
  const rest = Math.max(0, BLOB_FIXED_LEN - 3) + Math.max(0, BLOB_PER_RECIPIENT_LEN - 8) * count + url;
  return Uint8Array.from([...head, ...fps.flat(), ...new Array<number>(rest).fill(0xab)]);
}

describe("commitment and fingerprint preimages", () => {
  it("lays out the commitment as tag, intent, worker, salt, sha256", () => {
    const p = commitmentPreimage(INTENT, WORKER, SALT, SHA);
    expect(COMMITMENT_TAG).toEqual(ascii("intent-engine-dc"));
    expect(p.length).toBe(128);
    expect(p.slice(0, 16)).toEqual(COMMITMENT_TAG);
    expect(p.slice(16, 48)).toEqual(fill(1));
    expect(p.slice(48, 80)).toEqual(fill(2));
    expect(p.slice(80, 96)).toEqual(SALT);
    expect(p.slice(96, 128)).toEqual(SHA);
    expect(commitmentPreimage(INTENT, OTHER, SALT, SHA)).not.toEqual(p);
  });

  it("binds the whole sha256", () => {
    const sha = fill(5);
    sha[31] = 5 ^ 1;
    expect(commitmentPreimage(INTENT, WORKER, SALT, sha)).not.toEqual(commitmentPreimage(INTENT, WORKER, SALT, SHA));
  });

  it("lays out the fingerprint as tag and key", () => {
    const p = fingerprintPreimage(fill(9));
    expect(FINGERPRINT_TAG).toEqual(ascii("intent-engine-fp"));
    expect(p.length).toBe(48);
    expect(p.slice(0, 16)).toEqual(FINGERPRINT_TAG);
    expect(p.slice(16)).toEqual(fill(9));
  });

  it("refuses inputs of the wrong length", () => {
    expect(() => commitmentPreimage(INTENT, WORKER, fill(4, 15), SHA)).toThrow(RangeError);
    expect(() => commitmentPreimage(INTENT, WORKER, SALT, fill(5, 31))).toThrow(RangeError);
    expect(() => fingerprintPreimage(fill(9, 33))).toThrow(RangeError);
  });
});

describe("blob head", () => {
  it("fits a full committee with the longest url", () => {
    expect(BLOB_FIXED_LEN).toBe(99);
    expect(BLOB_PER_RECIPIENT_LEN).toBe(40);
    expect(MAX_BLOB_RECIPIENTS).toBe(8);
    expect(MAX_BLOB_URL).toBe(200);
    expect(MAX_SEALED_BLOB).toBe(624);
    expect(BLOB_FIXED_LEN + BLOB_PER_RECIPIENT_LEN * MAX_BLOB_RECIPIENTS + MAX_BLOB_URL).toBeLessThanOrEqual(MAX_SEALED_BLOB);
  });

  it("reads count, mask, fingerprints and url length", () => {
    const fps = Array.from({ length: MAX_BLOB_RECIPIENTS }, () => fill(0, 8));
    fps[0] = fill(10, 8);
    fps[1] = fill(11, 8);
    fps[2] = fill(12, 8);
    expect(blobHead(blob(3, 0b101, 42))).toEqual({ count: 3, mask: 0b101, fps, urlLen: 42 });
    expect(blobHead(blob(1, 0, 1)).urlLen).toBe(1);
    expect(blobHead(blob(8, 0xff, MAX_BLOB_URL))).toMatchObject({ count: 8, mask: 0xff, urlLen: MAX_BLOB_URL });
  });

  it("refuses every malformed shape", () => {
    const old = blob(1, 1, 10);
    old[0] = 3;
    const short = blob(2, 0, 10).slice(0, 3 + 8 + 4);
    const cases = [
      new Uint8Array(),
      Uint8Array.of(BLOB_VERSION, 1),
      old,
      blob(0, 0, 10),
      blob(9, 0, 10),
      blob(2, 0b100, 10),
      blob(1, 0b10, 10),
      blob(1, 0, 0),
      blob(1, 0, MAX_BLOB_URL + 1),
      blob(8, 0, MAX_BLOB_URL + 6),
      short,
    ];
    cases.forEach((bytes, i) => {
      expect(refusal(() => blobHead(bytes)), `case ${i}`).toBe("BlobMalformed");
    });
  });
});

describe("announcement rules", () => {
  it("lets only the holder announce while a claim is held", () => {
    expect(refusal(() => mayAnnounce({ state: "free" }, WORKER))).toBe("accepted");
    expect(refusal(() => mayAnnounce({ state: "lapsed", worker: OTHER }, WORKER))).toBe("accepted");
    expect(refusal(() => mayAnnounce({ state: "held", worker: WORKER, until: 9n }, WORKER))).toBe("accepted");
    expect(refusal(() => mayAnnounce({ state: "held", worker: OTHER, until: 9n }, WORKER))).toBe("ClaimHeld");
  });

  it("decodes announcement states and refuses unknown bytes", () => {
    expect(decodeAnnState(0)).toBe("announced");
    expect(decodeAnnState(1)).toBe("paid");
    expect(refusal(() => decodeAnnState(2))).toBe("AnnouncementState");
    expect(refusal(() => decodeAnnState(255))).toBe("AnnouncementState");
    expect(refusal(() => decodeAnnState(-1))).toBe("AnnouncementState");
    expect(refusal(() => decodeAnnState(0.5))).toBe("AnnouncementState");
    expect(encodeAnnState("announced")).toBe(0);
    expect(encodeAnnState("paid")).toBe(1);
  });

  it("closes an unpaid announcement for its worker once the intent stops being open", () => {
    expect(refusal(() => closable("announced", true, true, 500n, 1_000n, 0n))).toBe("AnnouncementOpen");
    expect(refusal(() => closable("announced", true, false, 500n, 1_000n, 0n))).toBe("accepted");
  });

  it("closes an unpaid announcement for others only after the refute window", () => {
    const expires = 1_000n;
    const edge = expires + REFUTE_WINDOW_SECS;
    expect(REFUTE_WINDOW_SECS).toBe(30n * 86_400n);
    expect(refusal(() => closable("announced", false, false, edge - 1n, expires, 0n))).toBe("AnnouncementRetained");
    expect(refusal(() => closable("announced", false, false, edge, expires, 0n))).toBe("accepted");
    expect(refusal(() => closable("announced", false, true, edge, expires, 0n))).toBe("accepted");
  });

  it("closes a paid announcement for anyone only after the refute window", () => {
    const paid = 2_000n;
    const edge = paid + REFUTE_WINDOW_SECS;
    for (const byWorker of [true, false]) {
      expect(refusal(() => closable("paid", byWorker, false, edge - 1n, 1_000n, paid))).toBe("AnnouncementRetained");
      expect(refusal(() => closable("paid", byWorker, false, edge, 1_000n, paid))).toBe("accepted");
    }
  });

  it("never overflows at the edge of time", () => {
    expect(refusal(() => closable("announced", false, false, I64_MAX, I64_MAX, 0n))).toBe("Overflow");
    expect(refusal(() => closable("paid", false, false, I64_MAX, 0n, I64_MAX))).toBe("Overflow");
    const last = I64_MAX - REFUTE_WINDOW_SECS;
    expect(refusal(() => closable("paid", false, false, I64_MAX, 0n, last))).toBe("accepted");
    expect(refusal(() => closable("paid", false, false, I64_MAX, 0n, last + 1n))).toBe("Overflow");
  });

  it("needs an earlier seq from a wallet that was not paid to refute", () => {
    expect(refusal(() => refutes(1n, 2n, OTHER, [WORKER]))).toBe("accepted");
    expect(refusal(() => refutes(2n, 2n, OTHER, [WORKER]))).toBe("RefuteNotEarlier");
    expect(refusal(() => refutes(3n, 2n, OTHER, [WORKER]))).toBe("RefuteNotEarlier");
    expect(refusal(() => refutes(1n, 2n, WORKER, [WORKER]))).toBe("RefuteSamePayee");
    expect(refusal(() => refutes(1n, 2n, OTHER, [WORKER, OTHER]))).toBe("RefuteSamePayee");
  });
});

describe("split hash preimage", () => {
  it("lists each wallet with its weight", () => {
    const expected = new Uint8Array(34 * MAX_SPLIT_RECIPIENTS);
    expected.set(fill(2), 0);
    expected.set(le(7_000n, 2), 32);
    expected.set(fill(3), 34);
    expected.set(le(3_000n, 2), 66);
    expect(splitHashPreimage([WORKER, OTHER], [7_000, 3_000])).toEqual({ bytes: expected, len: 68 });
    expect(MAX_SPLIT_RECIPIENTS).toBe(8);
  });

  it("refuses bad counts", () => {
    expect(refusal(() => splitHashPreimage([], []))).toBe("SplitCountMismatch");
    expect(refusal(() => splitHashPreimage([WORKER], [1, 2]))).toBe("SplitCountMismatch");
    expect(refusal(() => splitHashPreimage(new Array<Address>(9).fill(WORKER), new Array<number>(9).fill(1)))).toBe("SplitCountMismatch");
    expect(splitHashPreimage(new Array<Address>(8).fill(WORKER), new Array<number>(8).fill(1)).len).toBe(272);
  });
});

const fields = (): AttestedDeliveryFields => ({
  program: address(11),
  domain: fill(12),
  intent: address(13),
  payee: address(14),
  amountIn: 0x0102_0304_0506_0708n,
  result: 2n,
  filled: 3n,
  revision: 4,
  maxFeeBps: 5,
  extHash: fill(15),
  specHash: fill(16),
  announcement: address(17),
  seq: 0x1122_3344_5566_7788n,
  delivered: fill(18),
  salt: fill(19, 16),
});

describe("attested delivery preimages", () => {
  it("binds the announcement, seq and opening", () => {
    const p = attestedDeliveryPreimage(fields());
    expect(ATTEST_DELIVERY_TAG).toEqual(ascii("intent-engine-dl"));
    expect(ATTEST_DELIVERY_PREIMAGE_LEN).toBe(326);
    expect(p.length).toBe(ATTEST_DELIVERY_PREIMAGE_LEN);
    expect(p.slice(0, 16)).toEqual(ATTEST_DELIVERY_TAG);
    expect(p.slice(16, 48)).toEqual(fill(11));
    expect(p.slice(48, 80)).toEqual(fill(12));
    expect(p.slice(80, 112)).toEqual(fill(13));
    expect(p.slice(112, 144)).toEqual(fill(14));
    expect(p.slice(144, 152)).toEqual(le(0x0102_0304_0506_0708n, 8));
    expect(p.slice(152, 160)).toEqual(le(2n, 8));
    expect(p.slice(160, 168)).toEqual(le(3n, 8));
    expect(p.slice(168, 172)).toEqual(le(4n, 4));
    expect(p.slice(172, 174)).toEqual(le(5n, 2));
    expect(p.slice(174, 206)).toEqual(fill(15));
    expect(p.slice(206, 238)).toEqual(fill(16));
    expect(p.slice(238, 270)).toEqual(fill(17));
    expect(p.slice(270, 278)).toEqual(le(0x1122_3344_5566_7788n, 8));
    expect(p.slice(278, 310)).toEqual(fill(18));
    expect(p.slice(310, 326)).toEqual(fill(19, 16));
  });

  it("changes with each bound field", () => {
    const base = attestedDeliveryPreimage(fields());
    const variants: Partial<AttestedDeliveryFields>[] = [
      { announcement: address(0) },
      { seq: 1n },
      { delivered: fill(0) },
      { salt: fill(0, 16) },
      { payee: address(0) },
    ];
    for (const v of variants) {
      expect(attestedDeliveryPreimage({ ...fields(), ...v })).not.toEqual(base);
    }
  });

  it("extends the split fields", () => {
    const p = attestedSplitDeliveryPreimage({
      program: address(11),
      domain: fill(12),
      intent: address(13),
      amountIn: 1n,
      result: 2n,
      filled: 3n,
      revision: 4,
      maxFeeBps: 5,
      extHash: fill(15),
      specHash: fill(16),
      splitHash: fill(20),
      announcement: address(17),
      seq: 9n,
      delivered: fill(18),
      salt: fill(19, 16),
    });
    expect(ATTEST_SPLIT_DELIVERY_TAG).toEqual(ascii("intent-engine-sd"));
    expect(ATTEST_SPLIT_DELIVERY_PREIMAGE_LEN).toBe(326);
    expect(p.length).toBe(ATTEST_SPLIT_DELIVERY_PREIMAGE_LEN);
    expect(p.slice(0, 16)).toEqual(ATTEST_SPLIT_DELIVERY_TAG);
    expect(p.slice(16, 48)).toEqual(fill(11));
    expect(p.slice(48, 80)).toEqual(fill(12));
    expect(p.slice(80, 112)).toEqual(fill(13));
    expect(p.slice(112, 120)).toEqual(le(1n, 8));
    expect(p.slice(120, 128)).toEqual(le(2n, 8));
    expect(p.slice(128, 136)).toEqual(le(3n, 8));
    expect(p.slice(136, 140)).toEqual(le(4n, 4));
    expect(p.slice(140, 142)).toEqual(le(5n, 2));
    expect(p.slice(142, 174)).toEqual(fill(15));
    expect(p.slice(174, 206)).toEqual(fill(16));
    expect(p.slice(206, 238)).toEqual(fill(20));
    expect(p.slice(238, 270)).toEqual(fill(17));
    expect(p.slice(270, 278)).toEqual(le(9n, 8));
    expect(p.slice(278, 310)).toEqual(fill(18));
    expect(p.slice(310, 326)).toEqual(fill(19, 16));
  });

  it("defaults filled and revision to zero and refuses short hashes", () => {
    const { filled, revision, ...rest } = fields();
    expect([filled, revision]).toEqual([3n, 4]);
    const p = attestedDeliveryPreimage(rest);
    expect(p.slice(160, 168)).toEqual(fill(0, 8));
    expect(p.slice(168, 172)).toEqual(fill(0, 4));
    expect(() => attestedDeliveryPreimage({ ...fields(), extHash: fill(15, 31) })).toThrow(RangeError);
    expect(() => attestedDeliveryPreimage({ ...fields(), salt: fill(19, 32) })).toThrow(RangeError);
  });
});

describe("domain tags", () => {
  it("are unique across core", () => {
    const tags = [
      INTENT_TAG,
      ATTEST_TAG,
      ATTEST_PROOF_TAG,
      ATTEST_SPLIT_TAG,
      ATTEST_DELIVERY_TAG,
      ATTEST_SPLIT_DELIVERY_TAG,
      SPLIT_COSIGN_TAG,
      COMMITTEE_TAG,
      COMMITTEE_COSIGN_TAG,
      COMMITMENT_TAG,
      FINGERPRINT_TAG,
    ];
    const seen = new Set(tags.map((tag) => Array.from(tag).join(",")));
    expect(seen.size).toBe(tags.length);
  });
});
