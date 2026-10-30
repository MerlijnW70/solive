import { createHash } from "node:crypto";
import { type Address, generateKeyPairSigner, type KeyPairSigner, lamports, none } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { getMintEncoder, getMintSize } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { Kind, NATIVE_MINT, TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import { findIntentPda, parseFeedbackMemo } from "@intent-engine/core/internal";
import { createClient } from "../src/index.js";
import { feedbackInstructions } from "../src/internal.js";
import { MEMO_PROGRAM_ADDRESS } from "../src/transport.js";
import { svmTransport } from "../src/svm.js";
import { world } from "./svm.js";
import { announced } from "./work.js";

const LOCAL = "http://127.0.0.1:8899";
const SOL = 1_000_000_000n;
const SPEC = new Uint8Array(createHash("sha256").update("the kill reputation spec").digest());
const PAY = 1_000_000n;
const NOTE = createHash("sha256").update("quick and clean").digest("hex");

async function setup() {
  const w = await world();
  const space = BigInt(getMintSize());
  w.chain.svm.setAccount({
    address: NATIVE_MINT,
    data: Uint8Array.from(getMintEncoder().encode({ mintAuthority: none(), supply: 0n, decimals: 9, isInitialized: true, freezeAuthority: none() })),
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
  const fundedBy = async (source: KeyPairSigner) => {
    const signer = await generateKeyPairSigner();
    await transport.send([getTransferSolInstruction({ source, destination: signer.address, amount: 3n * SOL })], source);
    return signer;
  };
  const later = (seconds: bigint, slots: bigint) => {
    const clock = w.chain.svm.getClock();
    clock.unixTimestamp += seconds;
    clock.slot += slots;
    w.chain.svm.setClock(clock);
  };
  const job = async (owner: KeyPairSigner, judge: KeyPairSigner, worker: KeyPairSigner, sha256: string) => {
    const { nonce } = await client.createIntent({
      signer: owner,
      params: { kind: Kind.AttestedResult, amountIn: PAY, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: SPEC, judgeFee: 0n },
      inputMint: NATIVE_MINT,
      outputMint: w.outputMint,
    });
    const [intent] = await findIntentPda({ owner: owner.address, nonce });
    const delivered = await announced(client, worker, intent, sha256);
    await client.settleProof({ judge, intent: { owner: owner.address, nonce }, ...delivered, result: 1n });
    return intent;
  };
  return { client, fresh, fundedBy, later, job, transport };
}

describe("the standing of a worker, record by record", () => {
  it("lists the records oldest slot first, and keeps the read order within one slot", async () => {
    const { client, fresh, later, job } = await setup();
    const [worker, owner, judge] = await Promise.all([fresh(), fresh(), fresh()]);
    const intents: Address[] = [];
    intents.push(await job(owner, judge, worker, "11".repeat(32)));
    later(60n, 10n);
    intents.push(await job(owner, judge, worker, "22".repeat(32)));
    intents.push(await job(owner, judge, worker, "33".repeat(32)));
    later(60n, 10n);
    intents.push(await job(owner, judge, worker, "44".repeat(32)));
    const rep = await client.reputation(worker.address);
    const slots = rep.records.map((r) => r.slot);
    expect(slots).toStrictEqual([...slots].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(new Set(slots).size).toBe(3);
    expect(rep.records.map((r) => r.intent)).toStrictEqual([intents[0], intents[2], intents[1], intents[3]]);
  });

  it("states the first and the last time of its records", async () => {
    const { client, fresh, later, job } = await setup();
    const [worker, owner, judge] = await Promise.all([fresh(), fresh(), fresh()]);
    await job(owner, judge, worker, "55".repeat(32));
    later(500n, 5n);
    await job(owner, judge, worker, "66".repeat(32));
    later(500n, 5n);
    await job(owner, judge, worker, "77".repeat(32));
    const rep = await client.reputation(worker.address);
    const times = rep.records.map((r) => r.blockTime as bigint);
    expect(new Set(times).size).toBe(3);
    expect(rep.first).toBe(times[0]);
    expect(rep.last).toBe(times[2]);
    expect((rep.last as bigint) - (rep.first as bigint)).toBe(1_000n);
  });

  it("averages the feedback of its payers", async () => {
    const { client, fresh, job } = await setup();
    const [worker, alice, bob, judge] = await Promise.all([fresh(), fresh(), fresh(), fresh()]);
    const first = await job(alice, judge, worker, "88".repeat(32));
    const second = await job(bob, judge, worker, "99".repeat(32));
    await client.feedback({ owner: alice, intent: first, score: 60 });
    await client.feedback({ owner: bob, intent: second, score: 81 });
    expect((await client.reputation(worker.address)).feedback).toStrictEqual({ count: 2, average: 70.5 });
  });

  it("counts a self-dealt release only as self-dealt, even when its payer was funded by the worker", async () => {
    const { client, fresh, fundedBy, job } = await setup();
    const worker = await fresh();
    const payer = await fundedBy(worker);
    await job(payer, worker, worker, "aa".repeat(32));
    expect(await client.reputation(worker.address)).toMatchObject({ paid: 0, selfDealt: 1, fundedByWorker: 0, fundingUnknown: 0 });
  });
});

describe("the memo of a feedback", () => {
  it("carries the note when one is given and none when it is not", async () => {
    const { fresh, job, transport } = await setup();
    const [worker, owner, judge] = await Promise.all([fresh(), fresh(), fresh()]);
    const intent = await job(owner, judge, worker, "bb".repeat(32));
    const memoOf = async (note?: string) => {
      const found = await feedbackInstructions(transport, { owner, intent, score: 42, ...(note === undefined ? {} : { note }) });
      const memo = found.find(({ programAddress }) => programAddress === MEMO_PROGRAM_ADDRESS);
      return parseFeedbackMemo(new TextDecoder().decode(Uint8Array.from(memo?.data ?? [])));
    };
    expect(await memoOf(NOTE)).toStrictEqual({ intent, score: 42, note: NOTE });
    expect(await memoOf()).toStrictEqual({ intent, score: 42 });
  });
});
