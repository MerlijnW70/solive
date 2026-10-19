import { createHash } from "node:crypto";
import { type Address, generateKeyPairSigner, type KeyPairSigner, lamports, none } from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstructionAsync, getMintEncoder, getMintSize, getMintToInstruction } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { buildUpdateEconomics, findAssociatedTokenAddress, findIntentPda, Kind, NATIVE_MINT, splitFee, TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import { createClient, RESTART, type Transport, TRUST_HOPS, trustOf } from "../src/index.js";
import { svmTransport } from "../src/svm.js";
import { FEE_BPS, world } from "./svm.js";

const LOCAL = "http://127.0.0.1:8899";
const SOL = 1_000_000_000n;
const SPEC = new Uint8Array(createHash("sha256").update("the trust spec").digest());
const PAY = 1_000_000n;
const TOKEN_PAY = 1_000_000_000_000n;
const CREATE_FEE = 7_000n;

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
  const judge = await fresh();
  let jobs = 0;
  const pays = async (owner: KeyPairSigner, worker: KeyPairSigner, inputMint: Address = NATIVE_MINT, amountIn: bigint = PAY) => {
    const { nonce } = await client.createIntent({
      signer: owner,
      params: { kind: Kind.AttestedResult, amountIn, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: SPEC, judgeFee: 0n },
      inputMint,
      outputMint: w.outputMint,
    });
    const [intent] = await findIntentPda({ owner: owner.address, nonce });
    const sha256 = (jobs++).toString(16).padStart(64, "0");
    await client.deliver({ worker, intent, sha256, url: "https://example.org/work" });
    await client.settleProof({ judge, owner: owner.address, nonce, payTo: worker.address, result: 1n, deliveredSha256: sha256 });
  };
  const createFee = async (fee: bigint) => {
    const settings = await client.config();
    const { kindFeeMask, partnerCutBps, crankBounty } = settings;
    const [k0 = 0, k1 = 0, k2 = 0, k3 = 0] = settings.kindFeeBps;
    const economics = { kindFeeMask, kindFeeBps: [k0, k1, k2, k3] as const, partnerCutBps, crankBounty, createFee: Number(fee) };
    await client.send([await buildUpdateEconomics({ admin: w.authority, economics })], w.authority);
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
  return { transport, fresh, pays, createFee, tokens, inputMint: w.inputMint };
}

describe("reputation relative to the reader", () => {
  it("gives a ring paying each other, funded from outside the reader's graph, no trust", async () => {
    const { transport, fresh, pays } = await setup();
    const [reader, honest, outsider, x1, x2] = await Promise.all([fresh(), fresh(), fresh(), fresh(), fresh()]);
    await pays(reader, honest);
    await pays(outsider, x1);
    await pays(x1, x2);
    await pays(x2, x1);
    expect(await trustOf(transport, reader.address, honest.address)).toMatchObject({ complete: true });
    expect((await trustOf(transport, reader.address, honest.address)).score).toBeGreaterThan(0);
    for (const member of [x1, x2]) {
      const trust = await trustOf(transport, reader.address, member.address);
      expect(trust).toMatchObject({ score: 0, complete: true, paths: [] });
      expect(trust.reason).toContain("within");
    }
  });

  it("trusts a worker paid by a wallet the reader paid, along that path", async () => {
    const { transport, fresh, pays } = await setup();
    const [reader, middle, worker] = await Promise.all([fresh(), fresh(), fresh()]);
    await pays(reader, middle);
    await pays(middle, worker);
    const trust = await trustOf(transport, reader.address, worker.address);
    expect(trust).toMatchObject({ reader: reader.address, worker: worker.address, seeds: [reader.address], complete: true });
    expect(trust.score).toBeCloseTo(RESTART * (1 - RESTART) ** 2, 9);
    expect(trust.paths.map(({ wallets }) => wallets)).toEqual([[reader.address, middle.address, worker.address]]);
    expect(trust.paths[0]?.trust).toBeCloseTo(trust.score, 9);
    expect(trust.reason).toBeUndefined();
  });

  it("caps a ring's total behind one bribed edge at (1 - a) / a times the trust on that edge", async () => {
    const { transport, fresh, pays } = await setup();
    const [reader, x1, x2] = await Promise.all([fresh(), fresh(), fresh()]);
    await pays(reader, x1);
    await pays(x1, x2);
    await pays(x2, x1);
    const edge = (await trustOf(transport, reader.address, reader.address)).score;
    const ring = (await trustOf(transport, reader.address, x1.address)).score + (await trustOf(transport, reader.address, x2.address)).score;
    expect(edge).toBeCloseTo(RESTART, 9);
    expect(ring).toBeGreaterThan(0);
    expect(ring).toBeLessThanOrEqual(((1 - RESTART) / RESTART) * edge);
  });

  it("weighs a payer's edges only by the SOL its releases cost, never by a token's raw fee", async () => {
    const { transport, fresh, pays, createFee, tokens, inputMint } = await setup();
    await createFee(CREATE_FEE);
    const [reader, solWorker, tokenWorker] = await Promise.all([fresh(), fresh(), fresh()]);
    await tokens(reader.address, TOKEN_PAY);
    await pays(reader, solWorker);
    await pays(reader, tokenWorker, inputMint, TOKEN_PAY);
    const solFee = splitFee(PAY, FEE_BPS).fee;
    expect(splitFee(TOKEN_PAY, FEE_BPS).fee).toBeGreaterThan(1_000n * (solFee + CREATE_FEE));
    const sol = await trustOf(transport, reader.address, solWorker.address);
    const token = await trustOf(transport, reader.address, tokenWorker.address);
    const spread = RESTART * (1 - RESTART);
    expect(sol.score).toBeCloseTo((spread * Number(solFee + CREATE_FEE)) / Number(solFee + 2n * CREATE_FEE), 12);
    expect(token.score).toBeCloseTo((spread * Number(CREATE_FEE)) / Number(solFee + 2n * CREATE_FEE), 12);
    expect(token.score).toBeLessThan(sol.score);
  });

  it("adds no edge for a release that cost no SOL", async () => {
    const { transport, fresh, pays, tokens, inputMint } = await setup();
    const [reader, solWorker, tokenWorker] = await Promise.all([fresh(), fresh(), fresh()]);
    await tokens(reader.address, TOKEN_PAY);
    await pays(reader, solWorker);
    await pays(reader, tokenWorker, inputMint, TOKEN_PAY);
    expect((await trustOf(transport, reader.address, solWorker.address)).score).toBeCloseTo(RESTART * (1 - RESTART), 12);
    expect(await trustOf(transport, reader.address, tokenWorker.address)).toMatchObject({ score: 0, complete: true, paths: [] });
  });

  it("gives a reader with no paid releases and no seeds nothing, and says why", async () => {
    const { transport, fresh, pays } = await setup();
    const [reader, payer, worker] = await Promise.all([fresh(), fresh(), fresh()]);
    await pays(payer, worker);
    const trust = await trustOf(transport, reader.address, worker.address);
    expect(trust).toMatchObject({ score: 0, complete: true, seeds: [reader.address], paths: [] });
    expect(trust.reason).toBe(`${reader.address} paid no counted release and no other seed was named, so no trust flows from it`);
  });

  it("seeds only the reader unless the caller names more", async () => {
    const { transport, fresh, pays } = await setup();
    const [reader, seed, worker] = await Promise.all([fresh(), fresh(), fresh()]);
    await pays(seed, worker);
    expect((await trustOf(transport, reader.address, worker.address)).score).toBe(0);
    const trust = await trustOf(transport, reader.address, worker.address, { seeds: [seed.address] });
    expect(trust.seeds).toEqual([reader.address, seed.address]);
    expect(trust.score).toBeCloseTo((RESTART * (1 - RESTART)) / 2, 9);
    expect(trust.paths.map(({ wallets }) => wallets)).toEqual([[seed.address, worker.address]]);
  });

  it("says it is incomplete when it reaches the hop limit", async () => {
    const { transport, fresh, pays } = await setup();
    const [reader, a, b, c] = await Promise.all([fresh(), fresh(), fresh(), fresh()]);
    await pays(reader, a);
    await pays(a, b);
    await pays(b, c);
    const trust = await trustOf(transport, reader.address, c.address);
    expect(trust).toMatchObject({ score: 0, complete: false });
    expect(trust.reason).toContain(`within ${TRUST_HOPS} hops`);
  });

  it("says it is incomplete when it reaches the wallet limit", async () => {
    const { transport, fresh, pays } = await setup();
    const [reader, a] = await Promise.all([fresh(), fresh()]);
    await pays(reader, a);
    expect((await trustOf(transport, reader.address, a.address)).complete).toBe(true);
    expect(await trustOf(transport, reader.address, a.address, { maxWallets: 1 })).toMatchObject({ score: 0, complete: false, wallets: 1 });
  });

  it("says it is incomplete when a read fails", async () => {
    const { transport, fresh, pays } = await setup();
    const [reader, a] = await Promise.all([fresh(), fresh()]);
    await pays(reader, a);
    const failing: Transport = {
      ...transport,
      engineTransactions: async () => {
        throw new Error("the node is down");
      },
    };
    expect(await trustOf(failing, reader.address, a.address)).toMatchObject({ score: 0, complete: false });
  });
});
