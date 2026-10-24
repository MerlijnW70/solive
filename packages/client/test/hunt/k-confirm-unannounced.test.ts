import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { findAssociatedTokenAddress, findIntentPda, IntentStatus, Kind, TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import { ConfirmMismatch, confirmOnBoth, createClient, NotSettleable } from "../../src/index.js";
import { svmTransport } from "../../src/svm.js";
import { funded, world } from "../svm.js";
import { announced, keyed } from "../work.js";

const LOCAL = "http://127.0.0.1:8899";
const SPEC = new Uint8Array(createHash("sha256").update("a confirmed release for work nobody announced").digest());

const tokenAmount = (data: Uint8Array): bigint => new DataView(data.buffer, data.byteOffset).getBigUint64(64, true);

describe("a confirmed release whose hash was never announced", () => {
  it("K-1: neither the confirmation nor the release pays a hash no announcement on chain opens to", async () => {
    const w = await world();
    const transport = svmTransport(w.chain.svm);
    const client = createClient({ url: LOCAL, transport });
    const judge = await keyed(w);
    const worker = await funded(w.chain);
    const { nonce } = await client.createIntent({
      signer: w.owner,
      params: { kind: Kind.AttestedResult, amountIn: 400n, minResult: 1n, maxResult: 1n, attestor: judge.signer.address, specHash: SPEC, judgeFee: 0n },
      inputMint: w.inputMint,
      outputMint: w.outputMint,
    });
    const [intent] = await findIntentPda({ owner: w.owner.address, nonce });
    const delivered = await announced(client, worker, intent, "aa".repeat(32));

    const neverAnnounced = "bb".repeat(32);
    const target = { intent, attestor: judge.signer.address, sha256: neverAnnounced, payees: [worker.address], keypair: judge.keypair };
    await expect(confirmOnBoth(transport, transport, target)).rejects.toThrow(ConfirmMismatch);

    const payeeAta = await findAssociatedTokenAddress({ owner: worker.address, mint: w.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const read = () => {
      const account = w.chain.svm.getAccount(payeeAta);
      return account.exists ? tokenAmount(account.data) : 0n;
    };
    const opening = { sha256: neverAnnounced, salt: delivered.opening.salt };
    await expect(client.settleProof({ judge: judge.signer, intent: { owner: w.owner.address, nonce }, announcement: delivered.announcement, opening, result: 1n })).rejects.toThrow(NotSettleable);
    expect(read()).toBe(0n);
    expect((await client.intent({ owner: w.owner.address, nonce }))?.intent.status).toBe(IntentStatus.Open);
    expect(await confirmOnBoth(transport, transport, { ...target, sha256: delivered.opening.sha256 })).toMatchObject({ announcer: `${worker.address} in ${delivered.announcement}` });
  });
});
