import { createHash } from "node:crypto";
import { type Address, generateKeyPairSigner, type KeyPairSigner, lamports, none } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { getMintEncoder, getMintSize } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { feedbackMemo, findIntentPda, Kind, NATIVE_MINT, parseFeedbackMemo, PRODUCT_SLUG, signCommitteeVote, TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import { createClient, memoInstruction, NotSettleable } from "../src/index.js";
import { svmTransport } from "../src/svm.js";
import { world } from "./svm.js";

const LOCAL = "http://127.0.0.1:8899";
const SOL = 1_000_000_000n;
const SPEC = new Uint8Array(createHash("sha256").update("the reputation spec").digest());
const PAY = 1_000_000n;

async function setup() {
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
  const transport = svmTransport(w.chain.svm);
  const client = createClient({ url: LOCAL, transport });
  const fresh = async () => {
    const signer = await generateKeyPairSigner();
    w.chain.svm.airdrop(signer.address, lamports(10n * SOL));
    return signer;
  };
  const escrow = async (owner: KeyPairSigner, judge: Address) => {
    const { nonce } = await client.createIntent({
      signer: owner,
      params: { kind: Kind.AttestedResult, amountIn: PAY, minResult: 1n, maxResult: 1n, attestor: judge, specHash: SPEC, judgeFee: 0n },
      inputMint: NATIVE_MINT,
      outputMint: w.outputMint,
    });
    const [intent] = await findIntentPda({ owner: owner.address, nonce });
    return { nonce, intent };
  };
  const job = async (owner: KeyPairSigner, judge: KeyPairSigner, worker: KeyPairSigner, sha256: string, payTo: Address = worker.address) => {
    const { nonce, intent } = await escrow(owner, judge.address);
    await client.deliver({ worker, intent, sha256, url: "https://example.org/work" });
    await client.settleProof({ judge, owner: owner.address, nonce, payTo, result: 1n, deliveredSha256: sha256 });
    return intent;
  };
  return { w, client, fresh, escrow, job, transport };
}

describe("reputation from verifiable history", () => {
  it("counts only work released to the worker for the hash it announced, at arm's length, with its payers' feedback", async () => {
    const { client, fresh, escrow, job } = await setup();
    const worker = await fresh();
    const [alice, bob, judge, other] = await Promise.all([fresh(), fresh(), fresh(), fresh()]);
    const first = await job(alice, judge, worker, "a1".repeat(32));
    await job(bob, judge, worker, "b2".repeat(32));
    await job(alice, judge, worker, "c3".repeat(32), other.address);
    const { intent: pending } = await escrow(bob, judge.address);
    await client.deliver({ worker, intent: pending, sha256: "d4".repeat(32), url: "https://example.org/work" });

    await expect(client.feedback({ owner: bob, intent: first, score: 10 })).rejects.toThrow(NotSettleable);
    await client.feedback({ owner: alice, intent: first, score: 90 });
    await expect(client.feedback({ owner: alice, intent: first, score: 20 })).rejects.toThrow("already has its owner's feedback");

    const rep = await client.reputation(worker.address);
    expect(rep).toMatchObject({ wallet: worker.address, complete: true, announced: 4, paid: 2, selfDealt: 0, payers: 2, judges: 1, committeeJudged: 0 });
    expect(rep.feedback).toEqual({ count: 1, average: 90 });
    expect(rep.records.map((r) => r.outcome).sort()).toEqual(["open", "paid", "paid", "paid-other"]);
    const [earned] = rep.earned;
    expect(rep.earned).toHaveLength(1);
    expect(earned?.mint).toBe(NATIVE_MINT);
    expect(earned?.amount).toBe(rep.records.reduce((sum, r) => sum + (r.outcome === "paid" ? (r.earned ?? 0n) : 0n), 0n));
    expect(earned?.amount).toBeGreaterThan(0n);
  });

  it("marks a release the worker paid or judged for itself as self-dealt and leaves it out", async () => {
    const { client, fresh, job } = await setup();
    const worker = await fresh();
    const [judge, owner] = await Promise.all([fresh(), fresh()]);
    await job(worker, judge, worker, "e5".repeat(32));
    await job(owner, worker, worker, "f6".repeat(32));
    await job(owner, owner, worker, "07".repeat(32));
    const rep = await client.reputation(worker.address);
    expect(rep).toMatchObject({ announced: 3, paid: 0, selfDealt: 3, payers: 0, judges: 0, earned: [] });
    expect(rep.records.every((r) => r.outcome === "paid" && r.selfDealt)).toBe(true);
  });

  it("credits a committee's release, and calls it self-dealt when the worker sits on the committee", async () => {
    const { client, fresh, escrow } = await setup();
    const [worker, owner, a, b] = await Promise.all([fresh(), fresh(), fresh(), fresh()]);
    const run = async (members: KeyPairSigner[], sha256: string) => {
      const { committee } = await client.createCommittee({ payer: owner, members: members.map((m) => m.address), threshold: 2, feeWallet: owner.address });
      const { nonce, intent } = await escrow(owner, committee);
      await client.deliver({ worker, intent, sha256, url: "https://example.org/work" });
      const target = { owner: owner.address, nonce, payTo: worker.address, result: 1n };
      const { digest } = await client.committeeBallot(target);
      const votes = await Promise.all(members.slice(0, 2).map((m) => signCommitteeVote(m, digest)));
      const solver = members[0] as KeyPairSigner;
      await client.settleCommittee({ ...target, solver, votes, deliveredSha256: sha256 });
    };
    await run([a, b], "1a".repeat(32));
    expect(await client.reputation(worker.address)).toMatchObject({ paid: 1, selfDealt: 0, committeeJudged: 1, judges: 1 });
    await run([worker, a], "2b".repeat(32));
    expect(await client.reputation(worker.address)).toMatchObject({ paid: 1, selfDealt: 1, committeeJudged: 1 });
  });

  it("says it is incomplete when the node does not hold the whole ledger", async () => {
    const { fresh, job, transport } = await setup();
    const [worker, owner, judge] = await Promise.all([fresh(), fresh(), fresh()]);
    await job(owner, judge, worker, "3c".repeat(32));
    const pruned = createClient({ url: LOCAL, transport: { ...transport, firstAvailableSlot: async () => 5n } });
    expect(await pruned.reputation(worker.address)).toMatchObject({ complete: false, paid: 1 });
  });

  it("counts no clear v1 announcement, even one a release paid", async () => {
    const { client, fresh, escrow, transport } = await setup();
    const [worker, owner, judge] = await Promise.all([fresh(), fresh(), fresh()]);
    const sha256 = "4d".repeat(32);
    const { nonce, intent } = await escrow(owner, judge.address);
    const clear = `${PRODUCT_SLUG}-delivery:${intent}:${sha256}:` + "https://" + "example.org/work";
    await transport.send([memoInstruction(worker, clear), getTransferSolInstruction({ source: worker, destination: judge.address, amount: 0n })], worker);
    await client.settleProof({ judge, owner: owner.address, nonce, payTo: worker.address, result: 1n, deliveredSha256: sha256 });
    expect(await client.reputation(worker.address)).toMatchObject({ announced: 0, paid: 0, earned: [], records: [] });
  });

  it("knows nothing about a wallet that announced nothing", async () => {
    const { client, fresh } = await setup();
    const quiet = await fresh();
    expect(await client.reputation(quiet.address)).toMatchObject({ announced: 0, paid: 0, earned: [], feedback: { count: 0, average: null }, first: null, last: null });
  });

  it("writes and reads a feedback memo only in its exact form", () => {
    const intent = "11111111111111111111111111111112" as Address;
    const memo = feedbackMemo({ intent, score: 77, note: "ab".repeat(32) });
    expect(parseFeedbackMemo(memo)).toEqual({ intent, score: 77, note: "ab".repeat(32) });
    expect(parseFeedbackMemo(feedbackMemo({ intent, score: 0 }))).toEqual({ intent, score: 0 });
    for (const bad of [101, -1, 1.5]) {
      expect(() => feedbackMemo({ intent, score: bad })).toThrow(RangeError);
    }
    for (const text of [`${memo}:x`, memo.replace(":77:", ":077:"), memo.replace(":77:", ":101:"), memo.slice(0, -1)]) {
      expect(parseFeedbackMemo(text), text).toBeNull();
    }
  });
});
