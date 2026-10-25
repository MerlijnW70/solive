import { createHash } from "node:crypto";
import { generateKeyPairSigner, lamports } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { IntentStatus, Kind } from "@intent-engine/core";
import { buildClaimJob, buildOpenClaims, buildSettleClaims, claimBoardAddress, findIntentPda } from "@intent-engine/core/internal";
import { createClient } from "../../src/index.js";
import { world } from "../svm.js";

const SOL = 1_000_000_000n;
const STAKE = 50_000_000n;
const SPEC = new Uint8Array(createHash("sha256").update("a claimed job the owner cancels").digest());

describe("a claim held when its escrow is cancelled", () => {
  it("T-75: the owner cancels under a held claim, waits for it to lapse, settles and keeps the worker's stake", async () => {
    const w = await world();
    const client = createClient({ url: "https://" + "127.0.0.1:8899", transport: w.chain.transport });
    const owner = w.owner;
    const judge = await generateKeyPairSigner();
    const worker = await generateKeyPairSigner();
    w.chain.svm.airdrop(worker.address, lamports(10n * SOL));
    const { nonce } = await client.createIntent({
      signer: owner,
      params: { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: SPEC, judgeFee: 0n },
      inputMint: w.inputMint,
      outputMint: w.outputMint,
    });
    const [intent] = await findIntentPda({ owner: owner.address, nonce });
    await client.send([await buildOpenClaims({ owner, intent, maxSecs: 3_600, stake: STAKE })], owner);
    await client.send([await buildClaimJob({ worker, intent, owner: owner.address, secs: 600 })], worker);
    const claimedAt = w.chain.svm.getClock().unixTimestamp;
    const workerAfterClaim = w.chain.svm.getBalance(worker.address) ?? 0n;

    const clock = w.chain.svm.getClock();
    clock.unixTimestamp = claimedAt + 599n;
    w.chain.svm.setClock(clock);
    await client.cancel(owner, { owner: owner.address, nonce });
    expect((await client.intent({ owner: owner.address, nonce }))?.intent.status).toBe(IntentStatus.Cancelled);

    clock.unixTimestamp = claimedAt + 600n;
    w.chain.svm.setClock(clock);
    await client.send([await buildSettleClaims({ intent, owner: owner.address })], owner);

    expect(w.chain.svm.getAccount(await claimBoardAddress(intent)).exists).toBe(false);
    expect((w.chain.svm.getBalance(worker.address) ?? 0n) - workerAfterClaim).toBe(STAKE);
  });
});
