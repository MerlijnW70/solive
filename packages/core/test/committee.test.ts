import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Address, generateKeyPairSigner, getAddressDecoder, getAddressEncoder, signBytes } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  attestedProofPreimage,
  buildCommitteeBatch,
  buildCreateCommittee,
  checkCommittee,
  COMMITTEE_COSIGN_TAG,
  committeeEnvelope,
  committeeMask,
  committeeOf,
  committeeProofDigest,
  committeePreimage,
  committeeSigners,
  ED25519_PROGRAM_ADDRESS,
  IntentCoreError,
  MAX_COMMITTEE_MEMBERS,
  sortMembers,
} from "../src/index.js";

type MaskCase = { mask: number; outcome: { ok: Address[] } | { err: string } };
type CommitteeCase = {
  members: Address[];
  threshold: number;
  fee_wallet: Address;
  preimage?: string;
  id?: string;
  address?: Address;
  masks?: MaskCase[];
  err?: string;
};
type Vectors = {
  committees: CommitteeCase[];
  sig: { attest_proof_preimage: string; committee_message: string; committee_members: Address[]; committee_batch_with_ab_signatures: string };
};

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("./golden/vectors.json", import.meta.url)), "utf8"),
) as Vectors;

const hexOf = (bytes: ArrayLike<number>) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const bytesOfHex = (hex: string) => Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));

function termsOf(c: CommitteeCase) {
  return { members: c.members, threshold: c.threshold, feeWallet: c.fee_wallet };
}

async function sha256(bytes: Uint8Array) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice()));
}

describe("committee terms match the program byte for byte", () => {
  it("covers valid and invalid committees", () => {
    expect(vectors.committees.some((c) => c.err === undefined)).toBe(true);
    expect(vectors.committees.some((c) => c.err !== undefined)).toBe(true);
  });

  for (const c of vectors.committees) {
    it(`${c.members.length} members, threshold ${c.threshold}`, async () => {
      if (c.err !== undefined) {
        expect(() => committeePreimage(termsOf(c))).toThrow(new IntentCoreError("CommitteeInvalid"));
        return;
      }
      expect(hexOf(committeePreimage(termsOf(c)))).toBe(c.preimage);
      const committee = await committeeOf(termsOf(c));
      expect(hexOf(committee.id)).toBe(c.id);
      expect(committee.address).toBe(c.address);
      for (const { mask, outcome } of c.masks ?? []) {
        if ("ok" in outcome) {
          expect(committeeSigners(termsOf(c), mask), `mask ${mask}`).toEqual(outcome.ok);
          expect(committeeMask(termsOf(c), outcome.ok)).toBe(mask);
        } else {
          expect(() => committeeSigners(termsOf(c), mask), `mask ${mask}`).toThrow(
            new IntentCoreError("CommitteeSigners"),
          );
        }
      }
    });
  }

  it("signs one envelope that lists every member, over the tagged release digest", async () => {
    const members = vectors.sig.committee_members;
    const digest = await sha256(new Uint8Array([...COMMITTEE_COSIGN_TAG, ...bytesOfHex(vectors.sig.attest_proof_preimage)]));
    expect(hexOf(committeeEnvelope(digest, [...members].reverse()))).toBe(vectors.sig.committee_message);
    expect(() => committeeEnvelope(new Uint8Array(31), members)).toThrow(RangeError);
    const [first, , third] = members;
    if (first === undefined || third === undefined) throw new Error("three members");
    const terms = { members, threshold: 2, feeWallet: first };
    const votes = [third, first].map((member) => ({ member, signature: new Uint8Array(64).fill(0xab) }));
    const { instruction, mask } = buildCommitteeBatch(terms, digest, votes);
    expect(mask).toBe(0b101);
    expect(hexOf(instruction.data ?? new Uint8Array())).toBe(vectors.sig.committee_batch_with_ab_signatures);
  });

  it("hashes the tag and then the whole proof preimage into the committee digest", async () => {
    const [intent, payee] = vectors.sig.committee_members as [Address, Address];
    const fields = { domain: new Uint8Array(32).fill(3), intent, payee, amountIn: 10n, result: 1n, filled: 10n, revision: 1, maxFeeBps: 0, specHash: new Uint8Array(32).fill(4) };
    const preimage = await attestedProofPreimage(fields);
    const digest = await committeeProofDigest(fields);
    expect(hexOf(digest)).toBe(hexOf(await sha256(new Uint8Array([...COMMITTEE_COSIGN_TAG, ...preimage]))));
    expect(hexOf(await committeeProofDigest({ ...fields, specHash: new Uint8Array(32).fill(5) }))).not.toBe(hexOf(digest));
  });
});

describe("committee ergonomics", () => {
  const valid = vectors.committees.find((c) => c.err === undefined && c.members.length === 3);

  it("addresses a committee by its contents, whatever order its members are given in", async () => {
    if (valid === undefined) throw new Error("no three-member vector");
    const shuffled = { ...termsOf(valid), members: [...valid.members].reverse() };
    expect((await committeeOf(shuffled)).address).toBe(valid.address);
    expect(sortMembers(shuffled.members)).toEqual(valid.members);
    expect(() => checkCommittee(shuffled)).toThrow(new IntentCoreError("CommitteeInvalid"));
  });

  it("refuses a vote from a stranger, a repeated vote, or too few votes", () => {
    if (valid === undefined) throw new Error("no three-member vector");
    const terms = termsOf(valid);
    const [a, b] = valid.members as [Address, Address, Address];
    const stranger = getAddressDecoder().decode(new Uint8Array(32).fill(77));
    expect(committeeMask(terms, [b, a])).toBe(0b011);
    for (const votes of [[a, stranger], [a, a], [a]]) {
      expect(() => committeeMask(terms, votes)).toThrow(new IntentCoreError("CommitteeSigners"));
    }
  });

  it("orders a batch by member and signs the committee envelope", async () => {
    const signers = await Promise.all([0, 1, 2].map(() => generateKeyPairSigner()));
    const terms = {
      members: sortMembers(signers.map((s) => s.address)),
      threshold: 2,
      feeWallet: signers[0]?.address ?? ("" as Address),
    };
    const digest = new Uint8Array(32).fill(9);
    const message = committeeEnvelope(digest, terms.members);
    const voters = [signers[2], signers[0]].filter((s) => s !== undefined);
    const votes = await Promise.all(
      voters.map(async (s) => ({
        member: s.address,
        signature: new Uint8Array(await signBytes(s.keyPair.privateKey, message)),
      })),
    );
    const { instruction, mask } = buildCommitteeBatch(terms, digest, votes);
    expect(instruction.programAddress).toBe(ED25519_PROGRAM_ADDRESS);
    expect(committeeSigners(terms, mask)).toEqual(terms.members.filter((m) => voters.some((v) => v.address === m)));
    const data = instruction.data ?? new Uint8Array();
    expect(data[0]).toBe(2);
    const messageAt = data.length - message.length;
    expect(hexOf(data.slice(messageAt))).toBe(hexOf(message));
    const keyAt = (k: number) => new DataView(data.buffer, data.byteOffset).getUint16(2 + 14 * k + 4, true);
    const listed = committeeSigners(terms, mask).map((m) => hexOf(getAddressEncoder().encode(m)));
    expect([0, 1].map((k) => hexOf(data.slice(keyAt(k), keyAt(k) + 32)))).toEqual(listed);
    expect([0, 1].every((k) => keyAt(k) >= messageAt + 18 && keyAt(k) < messageAt + 18 + 32 * 3)).toBe(true);
  });

  it("builds a create instruction for the content-addressed account", async () => {
    if (valid === undefined) throw new Error("no three-member vector");
    const payer = await generateKeyPairSigner();
    const { committee, instruction } = await buildCreateCommittee({ ...termsOf(valid), payer });
    expect(committee.address).toBe(valid.address);
    expect(instruction.accounts?.some((a) => a.address === valid.address)).toBe(true);
    expect(MAX_COMMITTEE_MEMBERS).toBe(8);
  });
});
