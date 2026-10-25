import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { Kind, NATIVE_MINT, splitFees } from "@intent-engine/core";
import { signMessageBytes, splitN } from "@intent-engine/core/internal";
import { createClient } from "../../src/index.js";
import { FEE_BPS, world } from "../svm.js";
import { announced, fundedSigner, keyed, LOCAL, nativeMint, sha, specHash, workUrl } from "../work.js";

const WORK = sha("the refuted split work");
const PAY = 1_000_000n;

async function job() {
  const w = await world();
  nativeMint(w);
  const client = createClient({ url: LOCAL, transport: w.chain.transport });
  const judge = await keyed(w);
  const owner = await fundedSigner(w);
  const attestor: Address = judge.signer.address;
  const params = { kind: Kind.AttestedResult, amountIn: PAY, minResult: 1n, maxResult: 1n, attestor, specHash: specHash("the refuted split spec"), judgeFee: 0n } as const;
  const made = await client.createIntent({ signer: owner, params, inputMint: NATIVE_MINT, outputMint: w.outputMint });
  return { w, client, judge, owner, intent: made.intent, nonce: made.nonce };
}

describe("standing of a co-author paid by a refuted split release", () => {
  it("DC-3 keeps a co-author's share of a release whose substantiated refutation removes the announcer's", async () => {
    const { w, client, judge, owner, intent, nonce } = await job();
    const [early, front, ring] = [await fundedSigner(w), await fundedSigner(w), await fundedSigner(w)];
    const earlier = await announced(client, early, intent, WORK, workUrl("first.tar"));
    const paid = await announced(client, front, intent, WORK, workUrl("copied.tar"));
    await announced(client, ring, intent, sha("a placeholder"), workUrl("ring.tar"));
    const claim = { recipients: [front.address, ring.address], weights: [100, 9_900] };
    const target = { intent: { owner: owner.address, nonce }, ...paid, result: 1n, recipients: claim.recipients.map((wallet, i) => ({ wallet, weight: claim.weights[i] ?? 0 })) };
    const ballot = await client.splitBallot(target);
    const signatures = await Promise.all([front, ring].map(async (signer) => ({ wallet: signer.address, signature: await signMessageBytes(signer, ballot.message) })));
    const release = await client.settleSplit({ ...target, judge: judge.signer, signatures, payer: owner });
    const { refutation } = await client.refute({ worker: early, earlier: earlier.announcement, paid: paid.announcement, sha256: WORK, url: workUrl("first.tar"), claim });

    const announcer = await client.reputation(front.address);
    expect(announcer.records).toMatchObject([{ announcement: paid.announcement, role: "announcer", release, refutedBy: refutation, refutations: [{ refutation, standing: "substantiated" }] }]);
    expect(announcer).toMatchObject({ paid: 0, refuted: 1, earned: [] });

    const share = splitN(splitFees(PAY, FEE_BPS, 0, 0).net, claim.weights)[1];
    const coauthor = await client.reputation(ring.address);
    expect(coauthor.records).toMatchObject([{ announcement: paid.announcement, role: "co-author", outcome: "paid", release, earned: share }]);
    expect(coauthor.records[0]?.refutedBy).toBe(refutation);
    expect(coauthor).toMatchObject({ paid: 0, refuted: 1, earned: [] });
  });
});
