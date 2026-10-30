import { type Address, generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { Kind, NATIVE_MINT } from "@intent-engine/core";
import { signCommitteeVote, signMessageBytes } from "@intent-engine/core/internal";
import { CosignRejected, createClient, NotSettleable } from "../src/index.js";
import { world, type World } from "./svm.js";
import { announced, fundedSigner, keyed, LOCAL, nativeMint, sha, specHash, tokensOf, workUrl } from "./work.js";

const WORK = sha("the released work");
const PAY = 1_000_000n;

async function escrowTo(w: World, attestor: Address) {
  nativeMint(w);
  const client = createClient({ url: LOCAL, transport: w.chain.transport });
  const owner = await fundedSigner(w);
  const params = { kind: Kind.AttestedResult, amountIn: PAY, minResult: 1n, maxResult: 1n, attestor, specHash: specHash("the released spec"), judgeFee: 0n } as const;
  const made = await client.createIntent({ signer: owner, params, inputMint: NATIVE_MINT, outputMint: w.outputMint });
  return { client, owner, intent: made.intent, nonce: made.nonce };
}

describe("a ballot for a proof escrow", () => {
  it("is drawn for a single judge and refused for a committee", async () => {
    const w = await world();
    const judge = await keyed(w);
    const single = await escrowTo(w, judge.signer.address);
    const worker = await fundedSigner(w);
    const made = await announced(single.client, worker, single.intent, WORK);
    const ballot = await single.client.proofBallot({ intent: { owner: single.owner.address, nonce: single.nonce }, ...made, result: 1n });
    expect(ballot).toMatchObject({ intent: single.intent, attestor: judge.signer.address });
    expect(ballot.message.length).toBeGreaterThan(0);
    expect(ballot.digest).toHaveLength(32);

    const members = await Promise.all([0, 1, 2].map(() => generateKeyPairSigner()));
    const payer = await fundedSigner(w);
    const { committee } = await single.client.createCommittee({ payer, members: members.map(({ address }) => address), threshold: 2, feeWallet: payer.address });
    const judged = await escrowTo(w, committee);
    const delivered = await announced(judged.client, worker, judged.intent, WORK);
    const refused = await judged.client.proofBallot({ intent: { owner: judged.owner.address, nonce: judged.nonce }, ...delivered, result: 1n }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(NotSettleable);
    expect(refused).toMatchObject({ reason: "committee-judged", intent: judged.intent });
  });
});

describe("the votes a committee release carries", () => {
  it("are the first quorum in the committee's own order, whatever order they were given in", async () => {
    const w = await world();
    const members = await Promise.all([0, 1, 2].map(() => fundedSigner(w)));
    const payer = await fundedSigner(w);
    const probe = createClient({ url: LOCAL, transport: w.chain.transport });
    const { committee } = await probe.createCommittee({ payer, members: members.map(({ address }) => address), threshold: 2, feeWallet: payer.address });
    const { client, owner, intent, nonce } = await escrowTo(w, committee);
    const worker = await fundedSigner(w);
    const delivered = await announced(client, worker, intent, WORK);
    const target = { intent: { owner: owner.address, nonce }, ...delivered, result: 1n };
    const ballot = await client.committeeBallot(target);
    const order = ballot.committee.members;
    const byAddress = new Map(members.map((member) => [member.address, member]));
    const [first, second, third] = order.map((address) => byAddress.get(address) as KeyPairSigner);
    const votes = await Promise.all([third, second, first].map((member) => signCommitteeVote(member as KeyPairSigner, ballot.digest, order)));
    const solver = await fundedSigner(w);
    const plan = await client.plan.settleCommittee({ ...target, solver, votes });
    expect(plan.voters).toStrictEqual([(first as KeyPairSigner).address, (second as KeyPairSigner).address]);
    await client.settleCommittee({ ...target, solver, votes });
    expect(await tokensOf(w, worker.address)).toBeGreaterThan(0n);
    const attested = (await client.history(intent)).events.find((event) => event.name === "CommitteeAttested");
    expect(attested?.fields).toMatchObject({ signers: [(first as KeyPairSigner).address, (second as KeyPairSigner).address] });
  });
});

describe("a split release", () => {
  it("names the delivery on the release event alone, and refuses a co-signature that cannot be a signature", async () => {
    const w = await world();
    const judge = await keyed(w);
    const { client, owner, intent, nonce } = await escrowTo(w, judge.signer.address);
    const worker = await fundedSigner(w);
    const coauthor = await fundedSigner(w);
    const delivered = await announced(client, worker, intent, WORK);
    await announced(client, coauthor, intent, WORK, workUrl("mine.tar"));
    const recipients = [
      { wallet: worker.address, weight: 7_000 },
      { wallet: coauthor.address, weight: 3_000 },
    ];
    const target = { intent: { owner: owner.address, nonce }, ...delivered, result: 1n, recipients };
    const ballot = await client.splitBallot(target);
    const signed = await Promise.all([worker, coauthor].map(async (signer) => ({ wallet: signer.address, signature: await signMessageBytes(signer, ballot.message) })));
    const refusing = async (signatures: { wallet: Address; signature: Uint8Array }[]) =>
      client.plan.settleSplit({ ...target, judge: judge.signer, signatures, payer: owner }).catch((error: unknown) => error);
    const [own, theirs] = signed as [(typeof signed)[number], (typeof signed)[number]];

    const short = await refusing([own, { ...theirs, signature: theirs.signature.slice(0, 63) }]);
    expect(short).toBeInstanceOf(CosignRejected);
    expect(short).toMatchObject({ wallet: coauthor.address, intent });
    const long = await refusing([own, { ...theirs, signature: new Uint8Array([...theirs.signature, 0]) }]);
    expect(long).toBeInstanceOf(CosignRejected);
    const unreadable = await refusing([own, { ...theirs, signature: Array.from({ length: 64 }, () => 1) as unknown as Uint8Array }]);
    expect(unreadable).toBeInstanceOf(CosignRejected);
    const forged = await refusing([own, { ...theirs, signature: new Uint8Array(64) }]);
    expect(forged).toBeInstanceOf(CosignRejected);
    expect(await refusing(signed)).toMatchObject({ payer: owner.address });

    await client.settleSplit({ ...target, judge: judge.signer, signatures: signed, payer: owner });
    const events = (await client.history(intent)).events;
    expect(events.find((event) => event.name === "IntentSplit")).toMatchObject({ deliveredSha256: WORK, deliveredSalt: delivered.opening.salt });
    for (const event of events.filter((other) => other.name !== "IntentSplit")) {
      expect("deliveredSha256" in event).toBe(false);
      expect("deliveredSalt" in event).toBe(false);
    }
    expect(events.length).toBeGreaterThan(1);
  });

  it("carries the delivery on the release event alone", async () => {
    const w = await world();
    const judge = await keyed(w);
    const { client, owner, intent, nonce } = await escrowTo(w, judge.signer.address);
    const worker = await fundedSigner(w);
    const delivered = await announced(client, worker, intent, WORK);
    await client.settleProof({ judge: judge.signer, intent: { owner: owner.address, nonce }, ...delivered, result: 1n });
    const events = (await client.history(intent)).events;
    expect(events.find((event) => event.name === "IntentAttested")).toMatchObject({ deliveredSha256: WORK, deliveredSalt: delivered.opening.salt });
    for (const event of events.filter((other) => other.name !== "IntentAttested")) {
      expect("deliveredSha256" in event).toBe(false);
    }
    expect(events.length).toBeGreaterThan(1);
  });
});
