import {
  type Address,
  getAddressEncoder,
  getPublicKeyFromAddress,
  type Instruction,
  type KeyPairSigner,
  signBytes,
  type SignatureBytes,
  type TransactionSigner,
  verifySignature,
} from "@solana/kit";
import { findCommitteePda, getCreateCommitteeInstructionAsync } from "../generated/client/index.js";
import { events } from "./builder-accounts.js";
import { IntentCoreError } from "./errors.js";
import { FILL_EXT_TAGS, validateExt } from "./ext.js";
import {
  type AttestedProofFields,
  attestedProofPreimage,
  buildEd25519BatchInstruction,
  ENVELOPE_LEN,
  OFFCHAIN_PREFIX,
} from "./sig.js";

const ascii = (s: string) => new TextEncoder().encode(s);

export const MAX_COMMITTEE_MEMBERS = 8;
export const COMMITTEE_TAG = ascii("intent-engine-cm");
export const COMMITTEE_COSIGN_TAG = ascii("intent-engine-committee-member\0\0");
export const COMMITTEE_PREIMAGE_LEN = 16 + 1 + 1 + 32 * MAX_COMMITTEE_MEMBERS + 32;

export type CommitteeTerms = {
  members: readonly Address[];
  threshold: number;
  feeWallet: Address;
};

export type ResolvedCommittee = CommitteeTerms & {
  id: Uint8Array;
  address: Address;
};

function bytesOf(address: Address): Uint8Array {
  return new Uint8Array(getAddressEncoder().encode(address));
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < 32; i += 1) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

const isZero = (bytes: Uint8Array) => bytes.every((b) => b === 0);

export function sortMembers(members: readonly Address[]): Address[] {
  return [...members].sort((a, b) => compareBytes(bytesOf(a), bytesOf(b)));
}

export function checkCommittee(terms: CommitteeTerms): CommitteeTerms {
  const keys = terms.members.map(bytesOf);
  const count = keys.length;
  const ascending = keys.every((k, i) => i === 0 || compareBytes(keys[i - 1] ?? k, k) < 0);
  if (
    count < 1 ||
    count > MAX_COMMITTEE_MEMBERS ||
    !ascending ||
    keys.some(isZero) ||
    !Number.isInteger(terms.threshold) ||
    terms.threshold < 1 ||
    terms.threshold > count ||
    isZero(bytesOf(terms.feeWallet))
  ) {
    throw new IntentCoreError("CommitteeInvalid");
  }
  return terms;
}

export function committeePreimage(terms: CommitteeTerms): Uint8Array {
  checkCommittee(terms);
  const out = new Uint8Array(COMMITTEE_PREIMAGE_LEN);
  out.set(COMMITTEE_TAG, 0);
  out[16] = terms.threshold;
  out[17] = terms.members.length;
  terms.members.forEach((member, i) => out.set(bytesOf(member), 18 + 32 * i));
  out.set(bytesOf(terms.feeWallet), 18 + 32 * MAX_COMMITTEE_MEMBERS);
  return out;
}

export async function committeeOf(terms: CommitteeTerms): Promise<ResolvedCommittee> {
  const members = sortMembers(terms.members);
  const sorted = { members, threshold: terms.threshold, feeWallet: terms.feeWallet };
  const preimage = committeePreimage(sorted);
  const id = new Uint8Array(await crypto.subtle.digest("SHA-256", preimage.slice()));
  const [address] = await findCommitteePda({ id });
  return { ...sorted, id, address };
}

export function committeeSigners(terms: CommitteeTerms, mask: number): Address[] {
  checkCommittee(terms);
  const count = terms.members.length;
  if (!Number.isInteger(mask) || mask < 0 || mask > 0xff || mask >> count !== 0) {
    throw new IntentCoreError("CommitteeSigners");
  }
  const signers = terms.members.filter((_, i) => (mask >> i) & 1);
  if (signers.length < terms.threshold) {
    throw new IntentCoreError("CommitteeSigners");
  }
  return signers;
}

export function committeeMask(terms: CommitteeTerms, signers: readonly Address[]): number {
  checkCommittee(terms);
  let mask = 0;
  for (const signer of signers) {
    const at = terms.members.indexOf(signer);
    if (at < 0 || (mask >> at) & 1) {
      throw new IntentCoreError("CommitteeSigners");
    }
    mask |= 1 << at;
  }
  committeeSigners(terms, mask);
  return mask;
}

export function committeeEnvelope(digest: Uint8Array): Uint8Array {
  if (digest.length !== 32) {
    throw new RangeError(`a committee digest is 32 bytes, got ${digest.length}`);
  }
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
  const out = new Uint8Array(ENVELOPE_LEN);
  out.set(OFFCHAIN_PREFIX, 0);
  out.set([1, 1], OFFCHAIN_PREFIX.length);
  out.set(COMMITTEE_COSIGN_TAG, OFFCHAIN_PREFIX.length + 2);
  out.set(ascii(hex), OFFCHAIN_PREFIX.length + 2 + 32);
  return out;
}

export type CommitteeVote = { member: Address; signature: Uint8Array };

export function buildCommitteeBatch(
  terms: CommitteeTerms,
  digest: Uint8Array,
  votes: readonly CommitteeVote[],
): { instruction: Instruction; mask: number } {
  const mask = committeeMask(
    terms,
    votes.map((v) => v.member),
  );
  const byMember = new Map(votes.map((v) => [v.member, v.signature]));
  const entries = committeeSigners(terms, mask).map((member) => ({
    publicKey: member,
    signature: byMember.get(member) ?? new Uint8Array(),
  }));
  return {
    instruction: buildEd25519BatchInstruction({ entries, message: committeeEnvelope(digest) }),
    mask,
  };
}

export async function buildCreateCommittee(input: CommitteeTerms & { payer: TransactionSigner }) {
  const committee = await committeeOf(input);
  const instruction = await getCreateCommitteeInstructionAsync({
    payer: input.payer,
    committee: committee.address,
    id: committee.id,
    members: [...committee.members],
    threshold: committee.threshold,
    feeWallet: committee.feeWallet,
    ...(await events()),
  });
  return { committee, instruction };
}

export async function committeeProofDigest(f: AttestedProofFields): Promise<Uint8Array> {
  validateExt(f.ext ?? new Uint8Array(), FILL_EXT_TAGS);
  const preimage = await attestedProofPreimage(f);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", preimage.slice()));
}

export async function signCommitteeVote(member: KeyPairSigner, digest: Uint8Array): Promise<CommitteeVote> {
  const signature = new Uint8Array(await signBytes(member.keyPair.privateKey, committeeEnvelope(digest)));
  return { member: member.address, signature };
}

export async function verifyCommitteeVote(vote: CommitteeVote, digest: Uint8Array): Promise<boolean> {
  if (vote.signature.length !== 64) return false;
  try {
    const key = await getPublicKeyFromAddress(vote.member);
    return await verifySignature(key, vote.signature as SignatureBytes, committeeEnvelope(digest));
  } catch {
    return false;
  }
}
