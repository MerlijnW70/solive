import { describe, expect, it } from "vitest";
import { Kind, NATIVE_MINT } from "@intent-engine/core";
import { delivery, refutationAddress } from "@intent-engine/core/internal";
import { createClient } from "../src/index.js";
import { world } from "./svm.js";
import { announced, fundedSigner, keyed, LOCAL, nativeMint, sha, specHash, workUrl } from "./work.js";

const WORK = sha("the copied work");
const EARLY_URL = workUrl("early.tar");

async function copierPaid() {
  const w = await world();
  nativeMint(w);
  const client = createClient({ url: LOCAL, transport: w.chain.transport });
  const judge = await keyed(w);
  const owner = await fundedSigner(w);
  const params = { kind: Kind.AttestedResult, amountIn: 1_000_000n, minResult: 1n, maxResult: 1n, attestor: judge.signer.address, specHash: specHash("the spec"), judgeFee: 0n } as const;
  const made = await client.createIntent({ signer: owner, params, inputMint: NATIVE_MINT, outputMint: w.outputMint });
  const intent = made.intent;
  const [early, copier] = [await fundedSigner(w), await fundedSigner(w)];
  const earlier = await announced(client, early, intent, WORK, EARLY_URL);
  const paid = await announced(client, copier, intent, WORK);
  await client.settleProof({ judge: judge.signer, intent: { owner: owner.address, nonce: made.nonce }, ...paid, result: 1n });
  const paidView = (await client.announcements(intent)).announcements.find(({ address }) => address === paid.announcement);
  const until = (paidView?.paidAt ?? 0n) + delivery.REFUTE_WINDOW_SECS;
  const at = (seconds: bigint): void => {
    const clock = w.chain.svm.getClock();
    clock.unixTimestamp = seconds;
    w.chain.svm.setClock(clock);
  };
  const refute = { worker: early, earlier: earlier.announcement, paid: paid.announcement, sha256: WORK, url: EARLY_URL };
  return { w, client, intent, early, copier, earlier, paid, until, at, refute };
}

describe("reclaiming after a copier was paid", () => {
  it("keeps the earlier announcement that can refute the paid release, says why, and still refutes with it", async () => {
    const { client, intent, early, earlier, paid, until, refute } = await copierPaid();
    const reclaimed = await client.reclaim({ worker: early });
    expect(reclaimed).toMatchObject({ closed: [], kept: [earlier.announcement], signatures: [] });
    expect(reclaimed.reasons).toEqual([
      { announcement: earlier.announcement, reason: `it is earlier than ${paid.announcement}, which escrow ${intent} paid, so it can refute that release until ${new Date(Number(until) * 1000).toISOString()}` },
    ]);
    const refuted = await client.refute(refute);
    expect(refuted.refutation).toBe(await refutationAddress(earlier.announcement));
  });

  it("keeps it through the window's last second and closes it once the window has passed", async () => {
    const { w, client, early, earlier, until, at } = await copierPaid();
    at(until - 1n);
    expect((await client.reclaim({ worker: early })).kept).toEqual([earlier.announcement]);
    at(until);
    const reclaimed = await client.reclaim({ worker: early });
    expect(reclaimed).toMatchObject({ closed: [earlier.announcement], kept: [], reasons: [] });
    expect(w.chain.svm.getAccount(earlier.announcement).exists).toBe(false);
  });

  it("closes an earlier announcement that has already refuted the paid release", async () => {
    const { w, client, early, earlier, refute } = await copierPaid();
    await client.refute(refute);
    const reclaimed = await client.reclaim({ worker: early });
    expect(reclaimed).toMatchObject({ closed: [earlier.announcement], kept: [] });
    expect(w.chain.svm.getAccount(earlier.announcement).exists).toBe(false);
  });

  it("keeps the paid announcement for its window with a reason, and never keeps it as a refuter", async () => {
    const { client, copier, paid, until } = await copierPaid();
    const reclaimed = await client.reclaim({ worker: copier });
    expect(reclaimed).toMatchObject({ closed: [], kept: [paid.announcement] });
    expect(reclaimed.reasons).toEqual([
      { announcement: paid.announcement, reason: `it was paid, and the program keeps it for the refutation window until ${new Date(Number(until) * 1000).toISOString()}` },
    ]);
  });
});
