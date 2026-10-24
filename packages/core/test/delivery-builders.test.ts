import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AccountRole,
  type Address,
  createNoopSigner,
  getAddressDecoder,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Instruction,
} from "@solana/kit";
import { describe, expect, expectTypeOf, it } from "vitest";
import { findBookPda, findRefutationPda as generatedRefutationPda } from "../generated/client/index.js";
import {
  announcementAddress,
  announcementCommitment,
  attestedDeliveryPreimage,
  attestedProofMessage,
  attestedSplitDeliveryPreimage,
  attestedSplitDigest,
  attestedSplitMessage,
  buildAnnounceDelivery,
  buildCloseAnnouncement,
  buildCloseDeliveryBook,
  buildFillAttested,
  buildFillAttestedCommittee,
  buildFillAttestedSplit,
  buildFillAttestedSplitCommittee,
  buildRefuteRelease,
  buildSetAnnounceFee,
  buildSyncCommitteeKeys,
  cosignEnvelope,
  delivery,
  deliveryBookAddress,
  type FillAttestedSpec,
  type FillAttestedSplitSpec,
  findAnnouncementPda,
  findDeliveryBookPda,
  findRefutationPda,
  getAnnounceDeliveryInstructionDataDecoder,
  getFillAttestedCommitteeInstructionDataDecoder,
  getFillAttestedInstructionDataDecoder,
  getFillAttestedSplitCommitteeInstructionDataDecoder,
  getRefuteReleaseInstructionDataDecoder,
  getSetAnnounceFeeInstructionDataDecoder,
  type IdlLike,
  IntentCoreError,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  MAX_CREATE_FEE,
  offchainEnvelope,
  profileAddress,
  refutationAddress,
  SPLIT_COSIGN_TAG,
  sortMembers,
  validateIxAgainstIdl,
} from "../src/index.js";

const idl = JSON.parse(readFileSync(fileURLToPath(new URL("../generated/idl.json", import.meta.url)), "utf8")) as IdlLike;
const keyOf = (n: number) => getAddressDecoder().decode(new Uint8Array(32).fill(n));
const [intent, worker, judge, mint, owner, earlier] = [1, 2, 3, 4, 5, 6].map(keyOf) as [Address, Address, Address, Address, Address, Address];
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
const signer = createNoopSigner(worker);
const opening = { delivered: new Uint8Array(32).fill(0xd1), salt: new Uint8Array(16).fill(0x5a) };
const announced = { announcement: keyOf(9), opening };
const base = { solver: signer, owner, nonce: 7n, inputMint: mint, inputTokenProgram: TOKEN, amountIn: 400n, result: 1n, maxFeeBps: 100 };
const sha256 = async (bytes: Uint8Array) => new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice()));

const slotOf = (ix: Instruction, name: string, account: string) => {
  const at = idl.instructions.find((x) => x.name === name)?.accounts.findIndex((a) => a.name === account) ?? -1;
  return ix.accounts?.[at]?.address;
};

function blob(count: number): Uint8Array {
  const out = new Uint8Array(delivery.BLOB_FIXED_LEN + delivery.BLOB_PER_RECIPIENT_LEN * count + 10).fill(7);
  out.set([delivery.BLOB_VERSION, count, 0], 0);
  return out;
}

describe("delivery addresses", () => {
  it("derive the announcement from its intent, worker and blob hash, and the book and refutation like the program seeds", async () => {
    const sealed = blob(1);
    const hash = await sha256(sealed);
    const encode = getAddressEncoder().encode;
    const seed = (s: string) => new TextEncoder().encode(s);
    const [expected] = await getProgramDerivedAddress({ programAddress: INTENT_ENGINE_PROGRAM_ADDRESS, seeds: [seed("announcement"), encode(intent), encode(worker), hash] });
    expect((await findAnnouncementPda({ intent, worker, blobHash: hash }))[0]).toBe(expected);
    expect(await announcementAddress(intent, worker, sealed)).toBe(expected);
    expect(await announcementAddress(intent, judge, sealed)).not.toBe(expected);
    await expect(findAnnouncementPda({ intent, worker, blobHash: hash.slice(1) })).rejects.toThrow(RangeError);
    expect(await findDeliveryBookPda({ intent })).toEqual(await findBookPda({ intent }));
    expect(await deliveryBookAddress(intent)).toBe((await findBookPda({ intent }))[0]);
    expect(await findRefutationPda({ earlier })).toEqual(await generatedRefutationPda({ earlier }));
    expect(await refutationAddress(earlier)).toBe((await generatedRefutationPda({ earlier }))[0]);
  });
});

describe("settlement builders", () => {
  it("carry the fill, the opening and the announcement of a proof release", async () => {
    const ix = await buildFillAttested({ ...base, payee: worker, ...announced });
    const data = getFillAttestedInstructionDataDecoder().decode(ix.data);
    expect(data.fill).toEqual({ amountIn: 400n, result: 1n, maxFeeBps: 100 });
    expect(data.opening).toEqual(opening);
    expect(slotOf(ix, "fill_attested", "announcement")).toBe(announced.announcement);
    expect(validateIxAgainstIdl(ix, idl)).toEqual([]);
    const committee = await buildFillAttestedCommittee({ ...base, payee: worker, ...announced, committee: judge, signers: 0b11 });
    const committeeData = getFillAttestedCommitteeInstructionDataDecoder().decode(committee.data);
    expect([committeeData.signers, committeeData.opening]).toEqual([0b11, opening]);
    expect(slotOf(committee, "fill_attested_committee", "announcement")).toBe(announced.announcement);
    expect(validateIxAgainstIdl(committee, idl)).toEqual([]);
  });

  it("leave the announcement out and the opening zero for a plain attested release", async () => {
    const ix = await buildFillAttested({ ...base, payee: worker });
    const data = getFillAttestedInstructionDataDecoder().decode(ix.data);
    expect(data.opening).toEqual({ delivered: new Uint8Array(32), salt: new Uint8Array(16) });
    expect(slotOf(ix, "fill_attested", "announcement")).toBe(INTENT_ENGINE_PROGRAM_ADDRESS);
  });

  it("refuse at runtime an opening without its announcement, the reverse, or a mis-sized opening", async () => {
    const loose = { ...base, payee: worker } as FillAttestedSpec;
    await expect(buildFillAttested({ ...loose, opening } as FillAttestedSpec)).rejects.toThrow(RangeError);
    await expect(buildFillAttested({ ...loose, announcement: judge } as FillAttestedSpec)).rejects.toThrow(RangeError);
    await expect(buildFillAttested({ ...loose, announcement: judge, opening: { ...opening, salt: new Uint8Array(15) } })).rejects.toThrow("opening.salt must be 16 bytes");
    await expect(buildFillAttested({ ...loose, announcement: judge, opening: { ...opening, delivered: new Uint8Array(31) } })).rejects.toThrow("opening.delivered must be 32 bytes");
  });

  it("type an announcement and its opening as one pair, required for a split", () => {
    const plain = { ...base, payee: worker };
    expectTypeOf(plain).toExtend<FillAttestedSpec>();
    expectTypeOf({ ...plain, ...announced }).toExtend<FillAttestedSpec>();
    expectTypeOf({ ...plain, opening }).not.toExtend<FillAttestedSpec>();
    expectTypeOf({ ...plain, announcement: judge }).not.toExtend<FillAttestedSpec>();
    const split = { ...base, recipients: [worker], weights: [10_000] };
    expectTypeOf({ ...split, ...announced }).toExtend<FillAttestedSplitSpec>();
    expectTypeOf(split).not.toExtend<FillAttestedSplitSpec>();
    expectTypeOf({ ...split, opening }).not.toExtend<FillAttestedSplitSpec>();
  });

  it("seat the announcement of a split release and carry its opening", async () => {
    const ix = await buildFillAttestedSplitCommittee({ ...base, ...announced, recipients: [worker, owner], weights: [6000, 4000], committee: judge, signers: 0b1 });
    const data = getFillAttestedSplitCommitteeInstructionDataDecoder().decode(ix.data);
    expect([data.fill.amountIn, data.opening, data.claim.recipients]).toEqual([400n, opening, [worker, owner]]);
    expect(slotOf(ix, "fill_attested_split_committee", "announcement")).toBe(announced.announcement);
    expect(validateIxAgainstIdl(ix, idl)).toEqual([]);
    await expect(buildFillAttestedSplit({ ...base, ...announced, opening: { ...opening, salt: new Uint8Array(17) }, recipients: [worker], weights: [10_000] })).rejects.toThrow(RangeError);
  });
});

describe("judge messages", () => {
  const terms = { domain: new Uint8Array(32).fill(2), intent, payee: worker, amountIn: 400n, result: 1n, maxFeeBps: 100, specHash: new Uint8Array(32).fill(4), announcement: announced.announcement, seq: 3n, ...opening };

  it("sign the delivery preimage over the hash of the release extension", async () => {
    const extHash = await sha256(new Uint8Array());
    const digest = await sha256(attestedDeliveryPreimage({ ...terms, extHash }));
    expect(await attestedProofMessage(judge, terms)).toEqual(offchainEnvelope(judge, digest));
    for (const changed of [{ seq: 4n }, { announcement: intent }, { delivered: new Uint8Array(32) }, { salt: new Uint8Array(16) }]) {
      expect(await attestedProofMessage(judge, { ...terms, ...changed })).not.toEqual(offchainEnvelope(judge, digest));
    }
    await expect(attestedProofMessage(judge, { ...terms, ext: new Uint8Array([9, 0, 0]) })).rejects.toThrow(new IntentCoreError("ExtUnknown"));
  });

  it("cosign a split over the tagged split delivery preimage", async () => {
    const split = {
      domain: terms.domain,
      intent,
      amountIn: 400n,
      result: 1n,
      maxFeeBps: 100,
      specHash: terms.specHash,
      splitHash: new Uint8Array(32).fill(8),
      announcement: announced.announcement,
      seq: 3n,
      ...opening,
    };
    const preimage = attestedSplitDeliveryPreimage({ ...split, extHash: await sha256(new Uint8Array()) });
    const digest = await sha256(new Uint8Array([...SPLIT_COSIGN_TAG, ...preimage]));
    expect(await attestedSplitDigest(split)).toEqual(digest);
    expect(await attestedSplitMessage(split, [worker, judge])).toEqual(cosignEnvelope([worker, judge], digest));
    expect(await attestedSplitDigest({ ...split, seq: 9n })).not.toEqual(digest);
  });
});

describe("delivery builders", () => {
  it("announce a delivery to a key judge through its profile and to a committee directly", async () => {
    const sealed = blob(1);
    const commitment = await announcementCommitment(intent, worker, opening);
    expect(commitment).toEqual(await sha256(delivery.commitmentPreimage(intent, worker, opening.salt, opening.delivered)));
    const { announcement, instruction } = await buildAnnounceDelivery({ worker: signer, intent, attestor: judge, commitment, blob: sealed, feeRecipient: owner });
    expect(announcement).toBe(await announcementAddress(intent, worker, sealed));
    const at = (account: string) => slotOf(instruction, "announce_delivery", account);
    expect([at("announcement"), at("judge_profile"), at("committee"), at("book"), at("fee_to"), at("payer")]).toEqual([
      announcement,
      await profileAddress(judge),
      INTENT_ENGINE_PROGRAM_ADDRESS,
      await deliveryBookAddress(intent),
      owner,
      worker,
    ]);
    const data = getAnnounceDeliveryInstructionDataDecoder().decode(instruction.data);
    expect([data.commitment, data.blob]).toEqual([commitment, sealed]);
    expect(validateIxAgainstIdl(instruction, idl)).toEqual([]);
    const payer = createNoopSigner(owner);
    const board = keyOf(11);
    const toCommittee = await buildAnnounceDelivery({ worker: signer, payer, intent, attestor: judge, committee: true, claims: board, claimList: keyOf(12), commitment, blob: blob(3) });
    const on = (account: string) => slotOf(toCommittee.instruction, "announce_delivery", account);
    expect([on("committee"), on("judge_profile"), on("board"), on("claim_list"), on("payer"), on("fee_to")]).toEqual([judge, INTENT_ENGINE_PROGRAM_ADDRESS, board, keyOf(12), owner, INTENT_ENGINE_PROGRAM_ADDRESS]);
  });

  it("refuse a malformed blob or a zero or mis-sized commitment before anything is signed", async () => {
    const commitment = new Uint8Array(32).fill(1);
    const malformed = blob(1);
    malformed[0] = 3;
    await expect(buildAnnounceDelivery({ worker: signer, intent, attestor: judge, commitment, blob: malformed })).rejects.toThrow(new IntentCoreError("BlobMalformed"));
    await expect(buildAnnounceDelivery({ worker: signer, intent, attestor: judge, commitment: new Uint8Array(32), blob: blob(1) })).rejects.toThrow(RangeError);
    await expect(buildAnnounceDelivery({ worker: signer, intent, attestor: judge, commitment: new Uint8Array(31).fill(1), blob: blob(1) })).rejects.toThrow("commitment must be 32 bytes");
  });

  it("set the announce fee within the create fee cap", async () => {
    const admin = createNoopSigner(owner);
    const ix = await buildSetAnnounceFee({ admin, fee: MAX_CREATE_FEE });
    expect(getSetAnnounceFeeInstructionDataDecoder().decode(ix.data).fee).toBe(MAX_CREATE_FEE);
    expect(validateIxAgainstIdl(ix, idl)).toEqual([]);
    for (const fee of [MAX_CREATE_FEE + 1, -1, 0.5]) {
      await expect(buildSetAnnounceFee({ admin, fee }), String(fee)).rejects.toThrow(RangeError);
    }
  });

  it("pass every member profile in member order to the key sync", async () => {
    const members = [keyOf(40), keyOf(20), keyOf(30)];
    const ix = await buildSyncCommitteeKeys({ committee: judge, members });
    const profiles = await Promise.all(sortMembers(members).map(profileAddress));
    expect(ix.accounts.slice(-3)).toEqual(profiles.map((address) => ({ address, role: AccountRole.READONLY })));
    expect(ix.accounts[0]).toEqual({ address: judge, role: AccountRole.WRITABLE });
    expect(ix.accounts).toHaveLength(3 + 3);
    for (const bad of [[], Array.from({ length: 9 }, (_, i) => keyOf(i + 1)), [keyOf(1), keyOf(1)]]) {
      await expect(buildSyncCommitteeKeys({ committee: judge, members: bad }), String(bad.length)).rejects.toThrow(RangeError);
    }
  });

  it("close an announcement and a book against the intent's book, returning rent where told", async () => {
    const by = createNoopSigner(owner);
    const announcement = keyOf(9);
    const closed = await buildCloseAnnouncement({ by, announcement, intent, rentTo: worker });
    const at = (account: string) => slotOf(closed, "close_announcement", account);
    expect([at("by"), at("announcement"), at("intent"), at("book"), at("rent_to")]).toEqual([owner, announcement, intent, await deliveryBookAddress(intent), worker]);
    const book = await buildCloseDeliveryBook({ by, intent, rentTo: worker });
    const on = (account: string) => slotOf(book, "close_delivery_book", account);
    expect([on("by"), on("intent"), on("book"), on("rent_to")]).toEqual([owner, intent, await deliveryBookAddress(intent), worker]);
    expect([validateIxAgainstIdl(closed, idl), validateIxAgainstIdl(book, idl)]).toEqual([[], []]);
  });

  it("refute a release into the earlier announcement's refutation, with the split claim when there is one", async () => {
    const salt = new Uint8Array(16).fill(3);
    const esk = new Uint8Array(32).fill(0x45);
    const plain = await buildRefuteRelease({ earlierWorker: signer, paid: keyOf(8), earlier, salt, esk });
    expect(slotOf(plain, "refute_release", "refutation")).toBe(await refutationAddress(earlier));
    expect(slotOf(plain, "refute_release", "payer")).toBe(worker);
    const data = getRefuteReleaseInstructionDataDecoder().decode(plain.data);
    expect([data.salt, data.esk, data.claim]).toEqual([salt, esk, { __option: "None" }]);
    const claim = { recipients: [worker, owner], weights: [5000, 5000] };
    const split = await buildRefuteRelease({ earlierWorker: signer, paid: keyOf(8), earlier, salt, esk, claim });
    expect(getRefuteReleaseInstructionDataDecoder().decode(split.data).claim).toEqual({ __option: "Some", value: claim });
    await expect(buildRefuteRelease({ earlierWorker: signer, paid: keyOf(8), earlier, salt: salt.slice(1), esk })).rejects.toThrow("salt must be 16 bytes");
    await expect(buildRefuteRelease({ earlierWorker: signer, paid: keyOf(8), earlier, salt, esk: esk.slice(1) })).rejects.toThrow("esk must be 32 bytes");
    await expect(buildRefuteRelease({ earlierWorker: signer, paid: keyOf(8), earlier, salt, esk, claim: { recipients: [worker], weights: [] } })).rejects.toThrow(new IntentCoreError("SplitCountMismatch"));
  });
});
