import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { NATIVE_MINT } from "@intent-engine/core";
import { deliveryBookAddress, refutationAddress, signCommitteeVote, signMessageBytes } from "@intent-engine/core/internal";
import { createTestWorld, type TestWallet, type TestWorld } from "../src/testing.js";
import { checkCase, delivered, escrow, sha, statusOf, workUrl } from "./plan-driver.js";

async function announcedTo(world: TestWorld, attestor?: Address) {
  const job = await escrow(world, attestor);
  const worker = await world.wallet();
  return { ...job, worker, delivery: await delivered(world, job.intent, worker) };
}

async function paid(world: TestWorld) {
  const lane = await announcedTo(world);
  await world.client.settleProof({ judge: lane.judge, intent: lane.intent, ...lane.delivery, result: 1n });
  return lane;
}

const pay = async (world: TestWorld, wallet: TestWallet) => world.tokenBalance(wallet.address, NATIVE_MINT);

describe("every release write is its plan, sent", () => {
  it("announce", async () => {
    const world = await createTestWorld();
    await checkCase(world, {
      lane: async (w) => ({ ...(await escrow(w)), worker: await w.wallet() }),
      plan: (client, { worker, intent }) => client.plan.announce({ worker, intent, sha256: sha("announced"), url: workUrl() }),
      write: (client, { worker, intent }) => client.announce({ worker, intent, sha256: sha("announced"), url: workUrl() }),
      payer: ({ worker }) => worker,
      observe: async (w, { intent }) => (await w.client.announcements(intent)).announcements.map(({ seq, state }) => ({ seq, state })),
    });
  });

  it("settleProof", async () => {
    const world = await createTestWorld();
    await checkCase(world, {
      lane: (w) => announcedTo(w),
      plan: (client, { judge, intent, delivery }) => client.plan.settleProof({ judge, intent, ...delivery, result: 1n }),
      write: (client, { judge, owner, nonce, delivery }) => client.settleProof({ judge, intent: { owner: owner.address, nonce }, ...delivery, result: 1n }),
      payer: ({ judge }) => judge,
      observe: async (w, { intent, worker }) => ({ status: await statusOf(w, intent), worker: await pay(w, worker) }),
    });
  });

  it("settleCommittee", async () => {
    const world = await createTestWorld();
    const lane = async (w: TestWorld) => {
      const members = [await w.wallet(), await w.wallet()];
      const made = await w.client.createCommittee({ payer: members[0] as TestWallet, members: members.map(({ address }) => address), threshold: 2, feeWallet: (members[0] as TestWallet).address });
      const job = await announcedTo(w, made.committee);
      const target = { intent: job.intent, ...job.delivery, result: 1n };
      const ballot = await w.client.committeeBallot(target);
      const votes = await Promise.all(members.map((member) => signCommitteeVote(member, ballot.digest, ballot.committee.members)));
      return { ...job, solver: await w.wallet(), target, votes };
    };
    await checkCase(world, {
      lane,
      plan: (client, { solver, target, votes }) => client.plan.settleCommittee({ ...target, solver, votes }),
      write: (client, { solver, target, votes }) => client.settleCommittee({ ...target, solver, votes }),
      payer: ({ solver }) => solver,
      observe: async (w, { intent, worker }) => ({ status: await statusOf(w, intent), worker: await pay(w, worker) }),
    });
  });

  it("settleSplit", async () => {
    const world = await createTestWorld();
    const lane = async (w: TestWorld) => {
      const job = await announcedTo(w);
      const coauthor = await w.wallet();
      const recipients = [
        { wallet: job.worker.address, weight: 6_000 },
        { wallet: coauthor.address, weight: 4_000 },
      ];
      const target = { intent: job.intent, ...job.delivery, result: 1n, recipients };
      const ballot = await w.client.splitBallot(target);
      const signatures = await Promise.all([job.worker, coauthor].map(async (signer) => ({ wallet: signer.address, signature: await signMessageBytes(signer, ballot.message) })));
      return { ...job, coauthor, target, signatures };
    };
    await checkCase(world, {
      lane,
      plan: (client, { judge, target, signatures }) => client.plan.settleSplit({ ...target, judge, signatures }),
      write: (client, { judge, target, signatures }) => client.settleSplit({ ...target, judge, signatures }),
      payer: ({ judge }) => judge,
      observe: async (w, { intent, worker, coauthor }) => ({ status: await statusOf(w, intent), worker: await pay(w, worker), coauthor: await pay(w, coauthor) }),
    });
  });

  it("feedback", async () => {
    const world = await createTestWorld();
    await checkCase(world, {
      lane: (w) => paid(w),
      plan: (client, { owner, intent }) => client.plan.feedback({ owner, intent, score: 80 }),
      write: (client, { owner, intent }) => client.feedback({ owner, intent, score: 80 }),
      payer: ({ owner }) => owner,
      observe: async (w, { worker }) => (await w.client.reputation(worker.address)).feedback,
    });
  });

  it("refute", async () => {
    const world = await createTestWorld();
    const work = sha("the refuted plan work");
    const lane = async (w: TestWorld) => {
      const job = await escrow(w);
      const [early, late] = [await w.wallet(), await w.wallet()];
      const earlier = await delivered(w, job.intent, early, work, workUrl("first.tar"));
      const later = await delivered(w, job.intent, late, work);
      await w.client.settleProof({ judge: job.judge, intent: job.intent, ...later, result: 1n });
      return { early, late, refute: { worker: early, earlier: earlier.announcement, paid: later.announcement, sha256: work, url: workUrl("first.tar") } };
    };
    await checkCase(world, {
      lane,
      plan: (client, { refute }) => client.plan.refute(refute),
      write: (client, { refute }) => client.refute(refute),
      payer: ({ early }) => early,
      observe: async (w, { refute, late }) => ({
        recorded: w.svm.getAccount(await refutationAddress(refute.earlier)).exists,
        refuted: (await w.client.reputation(late.address)).refuted,
      }),
    });
  });

  it("reclaim, in batches", async () => {
    const world = await createTestWorld();
    const result = await checkCase(world, {
      lane: async (w) => {
        const job = await escrow(w);
        const worker = await w.wallet();
        await delivered(w, job.intent, worker);
        await w.client.cancel(job.owner, job.intent);
        return { ...job, worker };
      },
      plan: (client, { worker }) => client.plan.reclaim({ worker }),
      write: (client, { worker }) => client.reclaim({ worker }),
      payer: ({ worker }) => worker,
      observe: async (w, { intent }) => ({ left: (await w.client.announcements(intent)).announcements.length }),
    });
    expect(result.written).toEqual({ left: 0 });
  });

  it("closeBook", async () => {
    const world = await createTestWorld();
    await checkCase(world, {
      lane: async (w) => {
        const job = await escrow(w);
        const worker = await w.wallet();
        await delivered(w, job.intent, worker);
        await w.client.cancel(job.owner, job.intent);
        await w.client.reclaim({ worker });
        return { ...job, closer: await w.wallet() };
      },
      plan: (client, { intent, closer }) => client.plan.closeBook(intent, closer),
      write: (client, { owner, nonce, closer }) => client.closeBook({ owner: owner.address, nonce }, closer),
      payer: ({ closer }) => closer,
      observe: async (w, { intent }) => ({ book: w.svm.getAccount(await deliveryBookAddress(intent)).exists, status: await statusOf(w, intent) }),
    });
  });
});
