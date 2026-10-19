import { createHash } from "node:crypto";
import { type Address, generateKeyPairSigner, type KeyPairSigner, lamports, none, signBytes } from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstructionAsync, getMintEncoder, getMintSize, getMintToInstruction } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import {
  attestedSplitMessage,
  buildEd25519BatchInstruction,
  buildFillAttestedSplit,
  buildUpdateEconomics,
  decodeEvent,
  feeBpsFor,
  findAssociatedTokenAddress,
  findIntentPda,
  formatAmount,
  Kind,
  NATIVE_MINT,
  splitCommit,
  splitFee,
  splitN,
  TOKEN_PROGRAM_ADDRESS,
} from "@intent-engine/core";
import { createClient, type Transport } from "../src/index.js";
import { followUpInstructions } from "../src/job-memos.js";
import { svmTransport } from "../src/svm.js";
import { FEE_BPS, world } from "./svm.js";

const LOCAL = "http://127.0.0.1:8899";
const SOL = 1_000_000_000n;
const SPEC = new Uint8Array(createHash("sha256").update("the backing spec").digest());
const PAY = 1_000_000n;
const CREATE_FEE = 7_000;
const ATTESTED_MASK = 1 << Kind.AttestedResult;

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
  const economics = async (createFee: number, attestedBps?: number) => {
    const settings = await client.config();
    const [a = 0, b = 0, c = 0, d = 0] = settings.kindFeeBps;
    await client.send(
      [
        await buildUpdateEconomics({
          admin: w.authority,
          economics: {
            kindFeeMask: attestedBps === undefined ? settings.kindFeeMask : settings.kindFeeMask | ATTESTED_MASK,
            kindFeeBps: [a, b, c, attestedBps ?? d],
            partnerCutBps: settings.partnerCutBps,
            crankBounty: settings.crankBounty,
            createFee,
          },
        }),
      ],
      w.authority,
    );
  };
  const escrow = async (owner: KeyPairSigner, judge: Address, inputMint: Address = NATIVE_MINT) => {
    const { nonce } = await client.createIntent({
      signer: owner,
      params: { kind: Kind.AttestedResult, amountIn: PAY, minResult: 1n, maxResult: 1n, attestor: judge, specHash: SPEC, judgeFee: 0n },
      inputMint,
      outputMint: w.outputMint,
    });
    const [intent] = await findIntentPda({ owner: owner.address, nonce });
    return { nonce, intent };
  };
  const job = async (owner: KeyPairSigner, judge: KeyPairSigner, worker: KeyPairSigner, sha256: string, inputMint: Address = NATIVE_MINT) => {
    const { nonce, intent } = await escrow(owner, judge.address, inputMint);
    await client.deliver({ worker, intent, sha256, url: "https://example.org/work" });
    await client.settleProof({ judge, owner: owner.address, nonce, payTo: worker.address, result: 1n, deliveredSha256: sha256 });
    return intent;
  };
  const tokens = async (owner: Address, amount: bigint) => {
    const account = await findAssociatedTokenAddress({ owner, mint: w.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    await transport.send(
      [
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: w.authority, owner, mint: w.inputMint }),
        getMintToInstruction({ mint: w.inputMint, token: account, mintAuthority: w.authority, amount }),
      ],
      w.authority,
    );
  };
  const split = async (owner: KeyPairSigner, judge: KeyPairSigner, coauthors: KeyPairSigner[], weights: number[], sha256: string) => {
    const { nonce, intent } = await escrow(owner, judge.address);
    for (const coauthor of coauthors) {
      await client.deliver({ worker: coauthor, intent, sha256, url: "https://example.org/work" });
    }
    const settings = await client.config();
    const recipients = coauthors.map((c) => c.address);
    await transport.send(
      await Promise.all(
        [...recipients, settings.feeRecipient].map((holder) => getCreateAssociatedTokenIdempotentInstructionAsync({ payer: judge, owner: holder, mint: NATIVE_MINT })),
      ),
      judge,
    );
    const maxFeeBps = feeBpsFor(settings, Kind.AttestedResult);
    const message = await attestedSplitMessage({
      domain: Uint8Array.from(settings.domain),
      intent,
      amountIn: PAY,
      result: 1n,
      filled: 0n,
      revision: 0,
      maxFeeBps,
      specHash: SPEC,
      splitHash: await splitCommit(recipients, weights),
    });
    const entries = await Promise.all(
      [...coauthors, judge].map(async (signer) => ({ publicKey: signer.address, signature: new Uint8Array(await signBytes(signer.keyPair.privateKey, message)) })),
    );
    const fill = await buildFillAttestedSplit({
      solver: judge,
      owner: owner.address,
      nonce,
      inputMint: NATIVE_MINT,
      inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      recipients,
      weights,
      feeRecipient: settings.feeRecipient,
      amountIn: PAY,
      result: 1n,
      maxFeeBps,
    });
    const release = await transport.send([buildEd25519BatchInstruction({ entries, message }), fill], judge);
    await transport.send(followUpInstructions(judge, intent, sha256, release), judge);
    return intent;
  };
  return { w, client, transport, fresh, economics, job, tokens, split };
}

const fee = splitFee(PAY, FEE_BPS).fee;

describe("reputation backed by the fees its releases paid", () => {
  it("credits a single payee's SOL release with its protocol fee and create fee", async () => {
    const { client, fresh, economics, job } = await setup();
    await economics(CREATE_FEE);
    const [worker, owner, judge] = await Promise.all([fresh(), fresh(), fresh()]);
    await job(owner, judge, worker, "a1".repeat(32));
    const rep = await client.reputation(worker.address);
    expect(fee).toBeGreaterThan(0n);
    expect(rep).toMatchObject({ complete: true, paid: 1, backed: [{ mint: NATIVE_MINT, amount: fee }], backedSol: formatAmount(fee + BigInt(CREATE_FEE), 9) });
    expect(rep.records[0]).toMatchObject({ backed: fee, createBacked: BigInt(CREATE_FEE) });
  });

  it("credits each co-author of a split by its weight, and no more in total", async () => {
    const { client, fresh, economics, split } = await setup();
    await economics(CREATE_FEE);
    const [worker, partner, owner, judge] = await Promise.all([fresh(), fresh(), fresh(), fresh()]);
    const weights = [7_000, 3_000];
    await split(owner, judge, [worker, partner], weights, "b2".repeat(32));
    const shares = splitN(fee, weights);
    const creates = splitN(BigInt(CREATE_FEE), weights);
    const mine = await client.reputation(worker.address);
    const theirs = await client.reputation(partner.address);
    expect(mine).toMatchObject({ complete: true, paid: 1, backed: [{ mint: NATIVE_MINT, amount: shares[0] }], backedSol: formatAmount((shares[0] ?? 0n) + (creates[0] ?? 0n), 9) });
    expect(theirs).toMatchObject({ complete: true, paid: 1, backed: [{ mint: NATIVE_MINT, amount: shares[1] }], backedSol: formatAmount((shares[1] ?? 0n) + (creates[1] ?? 0n), 9) });
    expect((mine.backed[0]?.amount ?? 0n) + (theirs.backed[0]?.amount ?? 0n)).toBe(fee);
    expect(shares[0]).toBeLessThan(fee);
  });

  it("counts a fee paid in another token in backed but never in backed_sol", async () => {
    const { w, client, fresh, economics, job, tokens } = await setup();
    await economics(CREATE_FEE);
    const [worker, owner, judge] = await Promise.all([fresh(), fresh(), fresh()]);
    await tokens(owner.address, PAY);
    await job(owner, judge, worker, "c3".repeat(32), w.inputMint);
    const rep = await client.reputation(worker.address);
    expect(rep).toMatchObject({ complete: true, paid: 1, backed: [{ mint: w.inputMint, amount: fee }], backedSol: "0" });
  });

  it("credits nothing for a release with no protocol fee", async () => {
    const { client, fresh, economics, job } = await setup();
    await economics(0, 0);
    const [worker, owner, judge] = await Promise.all([fresh(), fresh(), fresh()]);
    await job(owner, judge, worker, "d4".repeat(32));
    const rep = await client.reputation(worker.address);
    expect(rep).toMatchObject({ complete: true, paid: 1, backed: [], backedSol: "0" });
    expect(rep.records[0]).toMatchObject({ backed: 0n, createBacked: 0n });
  });

  it("credits nothing for a self-dealt release", async () => {
    const { client, fresh, economics, job } = await setup();
    await economics(CREATE_FEE);
    const [worker, judge] = await Promise.all([fresh(), fresh()]);
    await job(worker, judge, worker, "e5".repeat(32));
    await job(judge, worker, worker, "f6".repeat(32));
    const rep = await client.reputation(worker.address);
    expect(rep).toMatchObject({ paid: 0, selfDealt: 2, backed: [], backedSol: "0" });
  });

  it("adds nothing and says it is incomplete when a release's events cannot be read", async () => {
    const { client, transport, fresh, economics, job } = await setup();
    await economics(CREATE_FEE);
    const [worker, owner, judge] = await Promise.all([fresh(), fresh(), fresh()]);
    await job(owner, judge, worker, "07".repeat(32));
    expect(await client.reputation(worker.address)).toMatchObject({ complete: true, backedSol: formatAmount(fee + BigInt(CREATE_FEE), 9) });
    const unread: Transport = {
      ...transport,
      engineTransactions: async (limit, of) =>
        (await transport.engineTransactions(limit, of)).map((tx) => ({ ...tx, emitted: tx.emitted.filter((data) => decodeEvent(data)?.name !== "IntentCreated") })),
    };
    const rep = await createClient({ url: LOCAL, transport: unread }).reputation(worker.address);
    expect(rep).toMatchObject({ complete: false, backed: [], backedSol: "0" });
  });
});
