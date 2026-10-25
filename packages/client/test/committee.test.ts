import { createHash } from "node:crypto";
import { type Address, generateKeyPairSigner, type KeyPairSigner, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { findAssociatedTokenAddress, IntentStatus, Kind, NATIVE_MINT, TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import { findIntentPda, signCommitteeVote, sortMembers } from "@intent-engine/core/internal";
import { createClient, NotSettleable, VoteRejected } from "../src/index.js";
import { budgeted, PACKET_DATA_SIZE, transactionBytes } from "../src/internal.js";
import { svmTransport } from "../src/svm.js";
import { FEE_BPS, world } from "./svm.js";
import { announced, sha } from "./work.js";

const LOCAL = "http://127.0.0.1:8899";
const SOL = 1_000_000_000n;
const SPEC = new Uint8Array(createHash("sha256").update("the committee spec").digest());
const PAY = 1_000_000n;
const WORK = sha("the committee's work");

async function setup(judgeFee: bigint) {
  const w = await world();
  const space = BigInt(getMintSize());
  w.chain.svm.setAccount({
    address: NATIVE_MINT,
    data: Uint8Array.from(
      getMintEncoder().encode({ mintAuthority: none(), supply: 0n, decimals: 9, isInitialized: true, freezeAuthority: none() }),
    ),
    executable: false,
    lamports: lamports(w.chain.svm.minimumBalanceForRentExemption(space)),
    programAddress: TOKEN_PROGRAM_ADDRESS,
    space,
  });
  const client = createClient({ url: LOCAL, transport: svmTransport(w.chain.svm) });
  const fresh = async () => {
    const signer = await generateKeyPairSigner();
    w.chain.svm.airdrop(signer.address, lamports(10n * SOL));
    return signer;
  };
  const tokens = async (owner: Address) => {
    const found = w.chain.svm.getAccount(
      await findAssociatedTokenAddress({ owner, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
    );
    return found.exists ? new DataView(found.data.buffer, found.data.byteOffset).getBigUint64(64, true) : null;
  };
  const members = await Promise.all([0, 1, 2].map(() => generateKeyPairSigner()));
  const feeWallet = (await generateKeyPairSigner()).address;
  const creator = await fresh();
  const created = await client.createCommittee({
    payer: creator,
    members: members.map((m) => m.address).reverse(),
    threshold: 2,
    feeWallet,
  });
  const owner = await fresh();
  const { nonce } = await client.createIntent({
    signer: owner,
    params: { kind: Kind.AttestedResult, amountIn: PAY, minResult: 1n, maxResult: 3n, attestor: created.committee, specHash: SPEC, judgeFee },
    inputMint: NATIVE_MINT,
    outputMint: w.outputMint,
  });
  const byAddress = new Map(members.map((m) => [m.address, m]));
  const sorted = sortMembers(members.map((m) => m.address)).map((a) => byAddress.get(a) as KeyPairSigner);
  const [intent] = await findIntentPda({ owner: owner.address, nonce });
  const deliver = async (sha256 = WORK) => {
    const worker = await fresh();
    return { worker: worker.address, delivered: await announced(client, worker, intent, sha256) };
  };
  return { w, client, fresh, tokens, members: sorted, feeWallet, created, creator, owner, nonce, intent, deliver };
}

describe("a committee judges a proof escrow", () => {
  it("is created once at its content address and read back with its terms", async () => {
    const { client, created, creator, members, feeWallet } = await setup(0n);
    expect(typeof created.signature).toBe("string");
    const view = await client.committee(created.committee);
    expect(view).toMatchObject({ address: created.committee, threshold: 2, feeWallet, members: members.map((m) => m.address) });
    const again = await client.createCommittee({ payer: creator, members: members.map((m) => m.address), threshold: 2, feeWallet });
    expect(again).toEqual({ committee: created.committee, signature: null });
    expect(await client.committee(creator.address)).toBeNull();
  });

  it("releases on a quorum of votes over the ballot, pays the fee wallet, and records the delivery", async () => {
    const judgeFee = 100_000n;
    const { client, fresh, tokens, members, feeWallet, owner, nonce, deliver } = await setup(judgeFee);
    const { worker, delivered } = await deliver();
    const target = { intent: { owner: owner.address, nonce }, ...delivered, result: 2n };
    const ballot = await client.committeeBallot(target);
    const [intent] = await findIntentPda({ owner: owner.address, nonce });
    expect(ballot.intent).toBe(intent);
    const [first, , third] = members;
    if (first === undefined || third === undefined) throw new Error("three members");
    const votes = await Promise.all([third, first].map((m) => signCommitteeVote(m, ballot.digest, ballot.committee.members)));
    const payer = await fresh();
    await client.settleCommittee({ ...target, solver: payer, votes });
    const fee = ((PAY - judgeFee) * BigInt(FEE_BPS)) / 10_000n;
    expect(await tokens(worker)).toBe(PAY - judgeFee - fee);
    expect(await tokens(feeWallet)).toBe(judgeFee);
    expect((await client.intent({ owner: owner.address, nonce }))?.intent).toMatchObject({ status: IntentStatus.Filled, filled: PAY });
    const { events } = await client.history(intent);
    const attested = events.find((e) => e.name === "CommitteeAttested");
    expect(attested?.fields).toMatchObject({ signers: [first.address, third.address] });
    expect(events.find((e) => e.name === "IntentAttested")).toMatchObject({ deliveredSha256: WORK, deliveredSalt: delivered.opening.salt });
  });

  it("refuses a forged vote, a vote over another payee, and too few votes before sending anything", async () => {
    const { client, fresh, members, owner, nonce, tokens, deliver } = await setup(0n);
    const { worker, delivered } = await deliver();
    const target = { intent: { owner: owner.address, nonce }, ...delivered, result: 1n };
    const ballot = await client.committeeBallot(target);
    const other = await client.committeeBallot({ ...target, ...(await deliver(sha("other work"))).delivered });
    const [a, b] = members;
    if (a === undefined || b === undefined) throw new Error("three members");
    const solver = await fresh();
    const stranger = await generateKeyPairSigner();
    const forged = { member: b.address, signature: (await signCommitteeVote(stranger, ballot.digest, ballot.committee.members)).signature };
    await expect(
      client.settleCommittee({ ...target, solver, votes: [await signCommitteeVote(a, ballot.digest, ballot.committee.members), forged] }),
    ).rejects.toThrow(VoteRejected);
    await expect(
      client.settleCommittee({ ...target, solver, votes: [await signCommitteeVote(a, ballot.digest, ballot.committee.members), await signCommitteeVote(b, other.digest, other.committee.members)] }),
    ).rejects.toThrow(VoteRejected);
    await expect(
      client.settleCommittee({ ...target, solver, votes: [await signCommitteeVote(a, ballot.digest, ballot.committee.members)] }),
    ).rejects.toThrow("CommitteeSigners");
    expect(await tokens(worker)).toBeNull();
  });

  it("takes a worker's announcement at the committee's address and lists it as announced to that judge", async () => {
    const { client, created, intent, deliver } = await setup(0n);
    const { worker, delivered } = await deliver();
    expect((await client.announcementsTo(created.committee)).announcements).toMatchObject([{ address: delivered.announcement, intent, worker, attestor: created.committee, seq: 1n }]);
  });

  it("sends only the threshold's votes, and every transaction fits a packet", async () => {
    const { w, client, members, owner, nonce, fresh, deliver } = await setup(100_000n);
    const { delivered } = await deliver();
    const target = { intent: { owner: owner.address, nonce }, ...delivered, result: 1n };
    const { digest, committee } = await client.committeeBallot(target);
    const votes = await Promise.all(members.map((m) => signCommitteeVote(m, digest, committee.members)));
    const solver = members[2] as KeyPairSigner;
    w.chain.svm.airdrop(solver.address, lamports(SOL));
    const release = await client.plan.settleCommittee({ ...target, solver, votes });
    expect(release.voters).toHaveLength(2);
    expect(release.setup.length).toBeGreaterThan(0);
    for (const part of [release.setup, release.instructions]) {
      const size = await transactionBytes(client.transport, await budgeted(client.transport, 0n, part, solver.address), solver.address);
      expect(size).toBeLessThanOrEqual(PACKET_DATA_SIZE);
    }
    await fresh();
  });

  it("refuses to ballot an escrow judged by a single key", async () => {
    const { w, client, fresh } = await setup(0n);
    const owner = await fresh();
    const judge = await generateKeyPairSigner();
    const { nonce } = await client.createIntent({
      signer: owner,
      params: { kind: Kind.AttestedResult, amountIn: PAY, minResult: 1n, maxResult: 3n, attestor: judge.address, specHash: SPEC, judgeFee: 0n },
      inputMint: NATIVE_MINT,
      outputMint: w.outputMint,
    });
    await expect(
      client.committeeBallot({ intent: { owner: owner.address, nonce }, announcement: judge.address, opening: { sha256: WORK, salt: "00".repeat(16) }, result: 1n }),
    ).rejects.toThrow(NotSettleable);
  });
});
