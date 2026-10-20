import { type Address, generateKeyPairSigner, getAddressDecoder, getAddressEncoder, getPublicKeyFromAddress, type SignatureBytes, verifySignature } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  buildEd25519CosignInstruction,
  COSIGN_KEYS_AT,
  cosignEnvelope,
  cosignerSet,
  ED25519_PROGRAM_ADDRESS,
  MAX_COSIGNERS,
  OFFCHAIN_PREFIX,
  offchainEnvelope,
  signCommitteeVote,
  signMessageBytes,
  verifyCommitteeVote,
} from "../src/index.js";

const bytes = (a: Address) => getAddressEncoder().encode(a);
const hexOf = (b: ArrayLike<number>) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const digest = new Uint8Array(32).fill(0x5a);

async function keys(n: number): Promise<Address[]> {
  return Promise.all(Array.from({ length: n }, async () => (await generateKeyPairSigner()).address));
}

describe("cosign envelope", () => {
  it("lists the keys sorted and once, in the off-chain v1 signer field", async () => {
    const [a, b, c] = await keys(3);
    if (a === undefined || b === undefined || c === undefined) throw new Error("three keys");
    const listed = cosignerSet([c, a, b, a]);
    expect(listed).toHaveLength(3);
    expect(listed.map((k) => hexOf(bytes(k)))).toEqual([a, b, c].map((k) => hexOf(bytes(k))).sort());
    const message = cosignEnvelope([c, a, b, c], digest);
    expect(message.slice(0, 16)).toEqual(OFFCHAIN_PREFIX);
    expect([...message.slice(16, 18)]).toEqual([1, 3]);
    expect(hexOf(message.slice(COSIGN_KEYS_AT, COSIGN_KEYS_AT + 96))).toBe(listed.map((k) => hexOf(bytes(k))).join(""));
    expect(new TextDecoder().decode(message.slice(COSIGN_KEYS_AT + 96))).toBe(hexOf(digest));
    expect(cosignEnvelope([a], digest)).toEqual(offchainEnvelope(a, digest));
  });

  it("refuses no keys, too many keys and a short digest", async () => {
    const many = await keys(MAX_COSIGNERS + 1);
    expect(cosignEnvelope(many.slice(0, MAX_COSIGNERS), digest)).toHaveLength(COSIGN_KEYS_AT + 32 * MAX_COSIGNERS + 64);
    expect(() => cosignEnvelope(many, digest)).toThrow(RangeError);
    expect(() => cosignEnvelope([], digest)).toThrow(RangeError);
    expect(() => cosignEnvelope(many.slice(0, 2), new Uint8Array(31))).toThrow(RangeError);
  });
});

describe("cosign instruction", () => {
  it("points each entry at its signer's slot inside the message, in key order", async () => {
    const listed = await keys(4);
    const message = cosignEnvelope(listed, digest);
    const sorted = cosignerSet(listed);
    const signers = [sorted[3], sorted[0], sorted[2]].filter((k): k is Address => k !== undefined);
    const ix = buildEd25519CosignInstruction({ entries: signers.map((publicKey) => ({ publicKey, signature: new Uint8Array(64).fill(1) })), message });
    expect(ix.programAddress).toBe(ED25519_PROGRAM_ADDRESS);
    const data = ix.data ?? new Uint8Array();
    const view = new DataView(data.buffer, data.byteOffset);
    const messageAt = 2 + 14 * 3 + 64 * 3;
    expect([data[0], data[1], data.length]).toEqual([3, 0, messageAt + message.length]);
    const pubkeys = [0, 1, 2].map((k) => view.getUint16(2 + 14 * k + 4, true));
    expect(pubkeys).toEqual([0, 2, 3].map((slot) => messageAt + COSIGN_KEYS_AT + 32 * slot));
    expect([0, 1, 2].map((k) => view.getUint16(2 + 14 * k + 8, true))).toEqual([messageAt, messageAt, messageAt]);
    expect(hexOf(data.slice(messageAt))).toBe(hexOf(message));
  });

  it("refuses a signer the envelope does not list, a signer twice, a short signature and no signers", async () => {
    const [a, b, stranger] = await keys(3);
    if (a === undefined || b === undefined || stranger === undefined) throw new Error("three keys");
    const message = cosignEnvelope([a, b], digest);
    const entry = (publicKey: Address, length = 64) => ({ publicKey, signature: new Uint8Array(length) });
    expect(() => buildEd25519CosignInstruction({ entries: [entry(a), entry(stranger)], message })).toThrow("is not listed");
    expect(() => buildEd25519CosignInstruction({ entries: [entry(a), entry(a)], message })).toThrow("twice");
    expect(() => buildEd25519CosignInstruction({ entries: [entry(a, 63)], message })).toThrow(RangeError);
    expect(() => buildEd25519CosignInstruction({ entries: [], message })).toThrow(RangeError);
  });

  it("reads the listed count from the byte before the keys, so a key starting with zero is still found", async () => {
    const zero = getAddressDecoder().decode(new Uint8Array(32));
    const [b] = await keys(1);
    if (b === undefined) throw new Error("one key");
    const message = cosignEnvelope([b, zero], digest);
    expect([...message.slice(COSIGN_KEYS_AT - 1, COSIGN_KEYS_AT + 1)]).toEqual([2, 0]);
    const ix = buildEd25519CosignInstruction({ entries: [{ publicKey: b, signature: new Uint8Array(64) }], message });
    const data = ix.data ?? new Uint8Array();
    const messageAt = 2 + 14 + 64;
    expect(new DataView(data.buffer, data.byteOffset).getUint16(2 + 4, true)).toBe(messageAt + COSIGN_KEYS_AT + 32);
  });

  it("takes every cosigner a batch holds and a message up to the largest offset the header names", async () => {
    const all = await keys(MAX_COSIGNERS);
    const entries = all.map((publicKey) => ({ publicKey, signature: new Uint8Array(64) }));
    const full = buildEd25519CosignInstruction({ entries, message: cosignEnvelope(all, digest) });
    expect((full.data ?? new Uint8Array())[0]).toBe(MAX_COSIGNERS);
    const [first] = all;
    if (first === undefined) throw new Error("one key");
    const longest = new Uint8Array(0xffff);
    longest.set(cosignEnvelope([first], digest));
    const ix = buildEd25519CosignInstruction({ entries: [{ publicKey: first, signature: new Uint8Array(64) }], message: longest });
    expect(ix.data?.length).toBe(2 + 14 + 64 + 0xffff);
    const over = new Uint8Array(0x10000);
    over.set(cosignEnvelope([first], digest));
    expect(() => buildEd25519CosignInstruction({ entries: [{ publicKey: first, signature: new Uint8Array(64) }], message: over })).toThrow(RangeError);
  });

  it("signs and verifies a committee vote through any message signer", async () => {
    const signers = await Promise.all([0, 1].map(() => generateKeyPairSigner()));
    const members = signers.map((s) => s.address);
    const [first] = signers;
    if (first === undefined) throw new Error("two members");
    const vote = await signCommitteeVote(first, digest, members);
    expect(await verifyCommitteeVote(vote, digest, members)).toBe(true);
    expect(await verifyCommitteeVote(vote, digest, [first.address])).toBe(false);
    expect(await verifyCommitteeVote({ ...vote, member: signers[1]?.address ?? first.address }, digest, members)).toBe(false);
    const stranger = await generateKeyPairSigner();
    const outside = await signCommitteeVote(stranger, digest, members);
    expect(await verifySignature(await getPublicKeyFromAddress(stranger.address), outside.signature as SignatureBytes, cosignEnvelope(members, digest))).toBe(true);
    expect(await verifyCommitteeVote(outside, digest, members)).toBe(false);
    expect(await verifyCommitteeVote({ ...vote, signature: vote.signature.slice(0, 63) }, digest, members)).toBe(false);
    const raw = await signMessageBytes(first, cosignEnvelope(members, digest));
    expect(await verifySignature(await getPublicKeyFromAddress(first.address), raw as SignatureBytes, cosignEnvelope(members, digest))).toBe(true);
  });
});
