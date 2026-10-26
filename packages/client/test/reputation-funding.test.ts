import { createHash } from "node:crypto";
import { type Address, generateKeyPairSigner, type KeyPairSigner, lamports, none } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { getMintEncoder, getMintSize } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { Kind, NATIVE_MINT, TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import { findIntentPda } from "@intent-engine/core/internal";
import { createClient, type ListedSignature, type Transport } from "../src/index.js";
import { FUNDING_PAGES } from "../src/internal.js";
import { svmTransport } from "../src/svm.js";
import { testSignature } from "../src/testing.js";
import { world } from "./svm.js";
import { announced } from "./work.js";

const LOCAL = "http://127.0.0.1:8899";
const SOL = 1_000_000_000n;
const SPEC = new Uint8Array(createHash("sha256").update("the funding spec").digest());
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
  const fundedBy = async (source: KeyPairSigner, amount = 3n * SOL) => {
    const signer = await generateKeyPairSigner();
    await transport.send([getTransferSolInstruction({ source, destination: signer.address, amount })], source);
    return signer;
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
  return { client, fresh, fundedBy, job, transport };
}

const marks = (records: readonly { intent: Address; fundedByWorker?: string }[]) => Object.fromEntries(records.map((r) => [r.intent, r.fundedByWorker]));

describe("reputation a worker may have paid for itself", () => {
  it("marks a release whose payer the worker funded, and leaves it out of the totals", async () => {
    const { client, fresh, fundedBy, job } = await setup();
    const [worker, judge] = await Promise.all([fresh(), fresh()]);
    const payer = await fundedBy(worker);
    const intent = await job(payer, judge, worker, "a1".repeat(32));
    const rep = await client.reputation(worker.address);
    expect(rep).toMatchObject({ complete: true, announced: 1, paid: 0, selfDealt: 0, fundedByWorker: 1, payers: 0, judges: 0, earned: [] });
    expect(marks(rep.records)).toEqual({ [intent]: "yes" });
  });

  it("marks a payer funded through one wallet the worker funded first", async () => {
    const { client, fresh, fundedBy, job } = await setup();
    const [worker, judge] = await Promise.all([fresh(), fresh()]);
    const between = await fundedBy(worker, 6n * SOL);
    const payer = await fundedBy(between);
    const intent = await job(payer, judge, worker, "b2".repeat(32));
    const rep = await client.reputation(worker.address);
    expect(rep).toMatchObject({ complete: true, paid: 0, fundedByWorker: 1 });
    expect(marks(rep.records)).toEqual({ [intent]: "yes" });
  });

  it("looks no further than two hops back", async () => {
    const { client, fresh, fundedBy, job } = await setup();
    const [worker, judge] = await Promise.all([fresh(), fresh()]);
    const first = await fundedBy(worker, 8n * SOL);
    const second = await fundedBy(first, 6n * SOL);
    const payer = await fundedBy(second);
    const intent = await job(payer, judge, worker, "c3".repeat(32));
    const rep = await client.reputation(worker.address);
    expect(rep).toMatchObject({ complete: true, paid: 1, fundedByWorker: 0 });
    expect(marks(rep.records)).toEqual({ [intent]: "no" });
  });

  it("counts a payer a stranger funded, even when the worker sent it SOL later", async () => {
    const { client, fresh, fundedBy, job, transport } = await setup();
    const [worker, judge, stranger] = await Promise.all([fresh(), fresh(), fresh()]);
    const payer = await fundedBy(stranger);
    await transport.send([getTransferSolInstruction({ source: worker, destination: payer.address, amount: SOL })], worker);
    const intent = await job(payer, judge, worker, "d4".repeat(32));
    const rep = await client.reputation(worker.address);
    expect(rep).toMatchObject({ complete: true, paid: 1, fundedByWorker: 0, payers: 1 });
    expect(marks(rep.records)).toEqual({ [intent]: "no" });
  });

  it("marks a release unknown, never clean, when the payer's funding history is cut short", async () => {
    const { fresh, fundedBy, job, transport } = await setup();
    const [worker, judge, stranger] = await Promise.all([fresh(), fresh(), fresh()]);
    const payer = await fundedBy(stranger);
    const intent = await job(payer, judge, worker, "e5".repeat(32));
    const listed: Address[] = [];
    const endless: Transport = {
      ...transport,
      signaturesOf: async (of, limit, before) => {
        listed.push(of);
        if (of !== payer.address) {
          return (transport.signaturesOf as NonNullable<Transport["signaturesOf"]>)(of, limit, before);
        }
        const page = listed.filter((at) => at === of).length;
        return Array.from({ length: limit }, (_, i): ListedSignature => ({ signature: testSignature(`long-${page}-${i}`), slot: 1n, blockTime: null, failed: false, memo: null }));
      },
    };
    const cut = await createClient({ url: LOCAL, transport: endless }).reputation(worker.address);
    expect(cut).toMatchObject({ complete: false, paid: 1, paidVerified: 0, fundedByWorker: 0, fundingUnknown: 1 });
    expect(marks(cut.records)).toEqual({ [intent]: "unknown" });
    expect(listed.filter((at) => at === payer.address)).toHaveLength(FUNDING_PAGES);
    const pruned = await createClient({ url: LOCAL, transport: { ...transport, firstAvailableSlot: async () => 5n } }).reputation(worker.address);
    expect(marks(pruned.records)).toEqual({ [intent]: "unknown" });
    const bare: Transport = { ...transport };
    delete bare.signaturesOf;
    delete bare.transactionsOf;
    const unlisted = await createClient({ url: LOCAL, transport: bare }).reputation(worker.address);
    expect(Object.values(marks(unlisted.records))).toEqual(["unknown"]);
  });

  it("stops at a funder too busy to read back and counts the release", async () => {
    const { fresh, fundedBy, job, transport } = await setup();
    const [worker, judge, faucet] = await Promise.all([fresh(), fresh(), fresh()]);
    const payer = await fundedBy(faucet);
    const clean = await job(payer, judge, worker, "18".repeat(32));
    const linked = await job(await fundedBy(await fundedBy(worker, 6n * SOL)), judge, worker, "29".repeat(32));
    const listed: Address[] = [];
    const busy: Transport = {
      ...transport,
      signaturesOf: async (of, limit, before) => {
        listed.push(of);
        if (of !== faucet.address) {
          return (transport.signaturesOf as NonNullable<Transport["signaturesOf"]>)(of, limit, before);
        }
        const page = listed.filter((at) => at === of).length;
        return Array.from({ length: limit }, (_, i): ListedSignature => ({ signature: testSignature(`busy-${page}-${i}`), slot: 1n, blockTime: null, failed: false, memo: null }));
      },
    };
    const rep = await createClient({ url: LOCAL, transport: busy }).reputation(worker.address);
    expect(rep).toMatchObject({ complete: true, paid: 1, fundedByWorker: 1, payers: 1 });
    expect(marks(rep.records)).toEqual({ [clean]: "no", [linked]: "yes" });
    expect(listed.filter((at) => at === faucet.address)).toHaveLength(FUNDING_PAGES);
  });

  it("marks a release unknown when the payer's funder's history cannot be read", async () => {
    const { fresh, fundedBy, job, transport } = await setup();
    const [worker, judge, stranger] = await Promise.all([fresh(), fresh(), fresh()]);
    const intent = await job(await fundedBy(stranger), judge, worker, "3a".repeat(32));
    const failing: Transport = {
      ...transport,
      signaturesOf: async (of, limit, before) => {
        if (of === stranger.address) {
          throw new Error("rpc failed");
        }
        return (transport.signaturesOf as NonNullable<Transport["signaturesOf"]>)(of, limit, before);
      },
    };
    const failed = await createClient({ url: LOCAL, transport: failing }).reputation(worker.address);
    expect(failed).toMatchObject({ complete: false, paid: 1, paidVerified: 0, fundedByWorker: 0, fundingUnknown: 1 });
    expect(marks(failed.records)).toEqual({ [intent]: "unknown" });
  });

  it("reads a payer's funding history once for all its releases", async () => {
    const { client, fresh, fundedBy, job, transport } = await setup();
    const [worker, judge, stranger] = await Promise.all([fresh(), fresh(), fresh()]);
    const payer = await fundedBy(stranger, 5n * SOL);
    await job(payer, judge, worker, "f6".repeat(32));
    await job(payer, judge, worker, "07".repeat(32));
    const reads: Address[] = [];
    const counting: Transport = {
      ...transport,
      signaturesOf: async (of, limit, before) => {
        reads.push(of);
        return (transport.signaturesOf as NonNullable<Transport["signaturesOf"]>)(of, limit, before);
      },
    };
    const rep = await createClient({ url: LOCAL, transport: counting }).reputation(worker.address);
    expect(rep).toMatchObject({ complete: true, paid: 2, fundedByWorker: 0 });
    expect(reads.filter((at) => at === payer.address)).toHaveLength(2);
    await expect(client.reputation(worker.address)).resolves.toMatchObject({ paid: 2 });
  });
});
