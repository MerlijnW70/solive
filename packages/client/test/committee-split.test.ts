import type { Address, Instruction, KeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { IntentStatus, Kind, NATIVE_MINT, splitFees } from "@intent-engine/core";
import { signMessageBytes, splitN } from "@intent-engine/core/internal";
import { type Client, createClient, InvalidInput, NotSettleable, VoteRejected } from "../src/index.js";
import { budgeted, PACKET_DATA_SIZE, transactionBytes } from "../src/internal.js";
import { FEE_BPS, world, type World } from "./svm.js";
import { announced, fundedSigner, LOCAL, nativeMint, sha, specHash, tokensOf } from "./work.js";

const WORK = sha("the split work");
const PAY = 1_000_000n;
const JUDGE_FEE = 50_000n;
const WEIGHTS = [6_000, 4_000];

async function escrowTo(w: World, attestor: Address, judgeFee = 0n) {
  nativeMint(w);
  const client = createClient({ url: LOCAL, transport: w.chain.transport });
  const owner = await fundedSigner(w);
  const params = { kind: Kind.AttestedResult, amountIn: PAY, minResult: 1n, maxResult: 1n, attestor, specHash: specHash("the split spec"), judgeFee } as const;
  const made = await client.createIntent({ signer: owner, params, inputMint: NATIVE_MINT, outputMint: w.outputMint });
  return { client, owner, intent: made.intent, nonce: made.nonce };
}

async function committeeJob(w: World, judgeFee = 0n) {
  const members = await Promise.all([0, 1, 2].map(() => fundedSigner(w)));
  const feeWallet = await fundedSigner(w);
  nativeMint(w);
  const probe = createClient({ url: LOCAL, transport: w.chain.transport });
  const { committee } = await probe.createCommittee({ payer: feeWallet, members: members.map(({ address }) => address), threshold: 2, feeWallet: feeWallet.address });
  return { members, feeWallet, committee, ...(await escrowTo(w, committee, judgeFee)) };
}

const cosign = (message: Uint8Array) => async (signer: KeyPairSigner) => ({ wallet: signer.address, signature: await signMessageBytes(signer, message) });

const sizeOf = async (client: Client, instructions: readonly Instruction[], payer: Address) =>
  transactionBytes(client.transport, await budgeted(client.transport, 0n, instructions, payer), payer);

const vote = (message: Uint8Array) => async (signer: KeyPairSigner) => ({ member: signer.address, signature: await signMessageBytes(signer, message) });

describe("a committee-judged split", () => {
  it("pays every recipient its weight on a quorum of member votes over the split", async () => {
    const w = await world();
    const { client, owner, intent, nonce, members, feeWallet, committee } = await committeeJob(w, JUDGE_FEE);
    const [worker, coauthor, solver] = await Promise.all([fundedSigner(w), fundedSigner(w), fundedSigner(w)]);
    const delivered = await announced(client, worker, intent, WORK);
    const recipients = [
      { wallet: worker.address, weight: WEIGHTS[0] ?? 0 },
      { wallet: coauthor.address, weight: WEIGHTS[1] ?? 0 },
    ];
    const target = { intent: { owner: owner.address, nonce }, ...delivered, result: 1n, recipients };
    const ballot = await client.splitBallot(target);
    expect(ballot).toMatchObject({ intent, attestor: committee, committee: { address: committee, threshold: 2 }, worker: worker.address });
    expect([...ballot.cosigners].sort()).toEqual([worker.address, coauthor.address, ...members.map(({ address }) => address)].sort());
    const signatures = await Promise.all([worker, coauthor].map(cosign(ballot.message)));
    const [first, second, third] = members;
    if (first === undefined || second === undefined || third === undefined) throw new Error("three members");
    const votes = await Promise.all([third, first, third].map(vote(ballot.message)));
    const planned = await client.plan.settleSplit({ ...target, solver, votes, signatures });
    expect(await sizeOf(client, planned.instructions, solver.address)).toBeGreaterThan(PACKET_DATA_SIZE);
    await client.settleSplit({ ...target, solver, votes, signatures });
    const { net } = splitFees(PAY - JUDGE_FEE, FEE_BPS, 0, 0);
    expect([await tokensOf(w, worker.address), await tokensOf(w, coauthor.address)]).toEqual(splitN(net, WEIGHTS));
    expect(await tokensOf(w, feeWallet.address)).toBe(JUDGE_FEE);
    expect((await client.intent({ owner: owner.address, nonce }))?.intent).toMatchObject({ status: IntentStatus.Filled, filled: PAY });
    const { events } = await client.history(intent);
    const voted = ballot.committee?.members.filter((member) => member === first.address || member === third.address);
    expect(events.find((e) => e.name === "CommitteeAttested")?.fields).toMatchObject({ committee, signers: voted });
    expect(events.find((e) => e.name === "IntentSplit")?.fields).toMatchObject({ attestor: committee, recipients: 2, splitHash: ballot.splitHash });
  });

  it("refuses a stranger's or forged vote, a vote over another split, too few votes and a single judge before sending", async () => {
    const w = await world();
    const { client, owner, intent, nonce, members, committee } = await committeeJob(w);
    const [worker, coauthor, solver, stranger] = await Promise.all([fundedSigner(w), fundedSigner(w), fundedSigner(w), fundedSigner(w)]);
    const delivered = await announced(client, worker, intent, WORK);
    const recipients = [
      { wallet: worker.address, weight: 5_000 },
      { wallet: coauthor.address, weight: 5_000 },
    ];
    const target = { intent: { owner: owner.address, nonce }, ...delivered, result: 1n, recipients };
    const ballot = await client.splitBallot(target);
    const other = await client.splitBallot({ ...target, recipients: [{ wallet: worker.address, weight: 10_000 }] });
    const signatures = await Promise.all([worker, coauthor].map(cosign(ballot.message)));
    const [a, b] = members;
    if (a === undefined || b === undefined) throw new Error("two members");
    const good = await vote(ballot.message)(a);
    const strangers = { member: stranger.address, signature: (await vote(ballot.message)(stranger)).signature };
    const forged = { member: b.address, signature: strangers.signature };
    const elsewhere = await vote(other.message)(b);
    for (const bad of [strangers, forged, elsewhere]) {
      await expect(client.plan.settleSplit({ ...target, solver, votes: [good, bad], signatures })).rejects.toBeInstanceOf(VoteRejected);
    }
    await expect(client.plan.settleSplit({ ...target, solver, votes: [good, good], signatures })).rejects.toBeInstanceOf(InvalidInput);
    const single = await client.plan.settleSplit({ ...target, judge: a, signatures }).catch((error: unknown) => error);
    expect(single).toBeInstanceOf(NotSettleable);
    expect(single).toMatchObject({ reason: "committee-judged", intent });
    expect(await tokensOf(w, worker.address)).toBeNull();
    expect((await client.intent({ owner: owner.address, nonce }))?.intent).toMatchObject({ status: IntentStatus.Open });
    expect(committee).toBe(ballot.attestor);
  });

  it("settles when a voting member is also a recipient, signing the split once", async () => {
    const w = await world();
    const { client, owner, intent, nonce, members } = await committeeJob(w);
    const [worker, solver] = await Promise.all([fundedSigner(w), fundedSigner(w)]);
    const [member, other] = members;
    if (member === undefined || other === undefined) throw new Error("two members");
    const delivered = await announced(client, worker, intent, WORK);
    const recipients = [
      { wallet: worker.address, weight: WEIGHTS[0] ?? 0 },
      { wallet: member.address, weight: WEIGHTS[1] ?? 0 },
    ];
    const target = { intent: { owner: owner.address, nonce }, ...delivered, result: 1n, recipients };
    const ballot = await client.splitBallot(target);
    const signatures = await Promise.all([worker].map(cosign(ballot.message)));
    const votes = await Promise.all([member, other].map(vote(ballot.message)));
    await client.settleSplit({ ...target, solver, votes, signatures });
    const { net } = splitFees(PAY, FEE_BPS, 0, 0);
    expect([await tokensOf(w, worker.address), await tokensOf(w, member.address)]).toEqual(splitN(net, WEIGHTS));
  });
});

describe("a single-judge split with the judge among the recipients", () => {
  it("settles on the judge's one signature and pays the judge its share", async () => {
    const w = await world();
    const judge = await fundedSigner(w);
    const { client, owner, intent, nonce } = await escrowTo(w, judge.address);
    const worker = await fundedSigner(w);
    const delivered = await announced(client, worker, intent, WORK);
    const recipients = [
      { wallet: worker.address, weight: WEIGHTS[0] ?? 0 },
      { wallet: judge.address, weight: WEIGHTS[1] ?? 0 },
    ];
    const target = { intent: { owner: owner.address, nonce }, ...delivered, result: 1n, recipients };
    const ballot = await client.splitBallot(target);
    expect(ballot.committee).toBeNull();
    expect([...ballot.cosigners].sort()).toEqual([worker.address, judge.address].sort());
    const signatures = await Promise.all([worker, judge].map(cosign(ballot.message)));
    const votes = await Promise.all([judge].map(vote(ballot.message)));
    const asCommittee = await client.plan.settleSplit({ ...target, solver: judge, votes, signatures }).catch((error: unknown) => error);
    expect(asCommittee).toMatchObject({ reason: "not-a-committee", intent });
    const plan = await client.plan.settleSplit({ ...target, judge, signatures });
    expect(plan.instructions[0]?.data?.[0]).toBe(2);
    await client.settleSplit({ ...target, judge, signatures: signatures.slice(0, 1) });
    const { net } = splitFees(PAY, FEE_BPS, 0, 0);
    expect([await tokensOf(w, worker.address), await tokensOf(w, judge.address)]).toEqual(splitN(net, WEIGHTS));
  });
});
