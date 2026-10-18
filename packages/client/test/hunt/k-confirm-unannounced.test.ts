import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { findAssociatedTokenAddress, findIntentPda, IntentStatus, Kind, TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import { confirmOnBoth, createClient } from "../../src/index.js";
import { svmTransport } from "../../src/svm.js";
import { funded, world } from "../svm.js";

const LOCAL = "http://127.0.0.1:8899";
const SPEC = new Uint8Array(createHash("sha256").update("a confirmed release for work nobody announced").digest());

const tokenAmount = (data: Uint8Array): bigint => new DataView(data.buffer, data.byteOffset).getBigUint64(64, true);

describe("a confirmed release whose recorded hash was never announced", () => {
  it("K-1: the worker is paid by a confirmed release for a hash the chain records no announcer of", async () => {
    const w = await world();
    const transport = svmTransport(w.chain.svm);
    const client = createClient({ url: LOCAL, transport });
    const judge = await funded(w.chain);
    const worker = await funded(w.chain);
    const { nonce } = await client.createIntent({
      signer: w.owner,
      params: { kind: Kind.AttestedResult, amountIn: 400n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: SPEC, judgeFee: 0n },
      inputMint: w.inputMint,
      outputMint: w.outputMint,
    });
    const [intent] = await findIntentPda({ owner: w.owner.address, nonce });

    const announced = "aa".repeat(32);
    await client.deliver({ worker, intent, sha256: announced, url: "https://example.org/work" });

    const neverAnnounced = "bb".repeat(32);
    const target = { intent, attestor: judge.address, sha256: neverAnnounced, payees: [worker.address] };
    const refused = await confirmOnBoth(transport, transport, target).then(
      () => false,
      () => true,
    );

    const payeeAta = await findAssociatedTokenAddress({ owner: worker.address, mint: w.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const read = () => {
      const account = w.chain.svm.getAccount(payeeAta);
      return account.exists ? tokenAmount(account.data) : 0n;
    };
    const before = read();
    await client.settleProof({ judge, owner: w.owner.address, nonce, payTo: worker.address, result: 1n, deliveredSha256: neverAnnounced });
    const received = read() - before;

    expect(received).toBeGreaterThan(0n);
    expect((await client.intent(w.owner.address, nonce))?.intent.status).toBe(IntentStatus.Filled);
    expect(refused).toBe(true);
  });
});
