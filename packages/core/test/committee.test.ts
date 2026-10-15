import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Address, generateKeyPairSigner, getAddressDecoder, signBytes } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  buildCommitteeBatch,
  buildCreateCommittee,
  checkCommittee,
  committeeEnvelope,
  committeeMask,
  committeeOf,
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
  sig: { attest_proof_preimage: string; committee_message: string };
};

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("./golden/vectors.json", import.meta.url)), "utf8"),
) as Vectors;

const hexOf = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
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

  it("signs the committee envelope over the release digest", async () => {
    const digest = await sha256(bytesOfHex(vectors.sig.attest_proof_preimage));
    expect(hexOf(committeeEnvelope(digest))).toBe(vectors.sig.committee_message);
    expect(() => committeeEnvelope(new Uint8Array(31))).toThrow(RangeError);
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
    const message = committeeEnvelope(digest);
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
    expect(hexOf(data.slice(data.length - message.length))).toBe(hexOf(message));
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
