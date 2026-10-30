import { createHash } from "node:crypto";
import { generateKeyPairSigner, type KeyPairSigner, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { Kind, NATIVE_MINT, TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import { buildUpdateEconomics, findIntentPda, splitFee } from "@intent-engine/core/internal";
import { createClient, type EngineTransaction, type Transport, trustOf } from "../src/index.js";
import { RESTART } from "../src/internal.js";
import { svmTransport } from "../src/svm.js";
import { FEE_BPS, world } from "./svm.js";
import { announced } from "./work.js";

const LOCAL = "http://127.0.0.1:8899";
const SOL = 1_000_000_000n;
const SPEC = new Uint8Array(createHash("sha256").update("the kill trust spec").digest());
const PAY = 1_000_000n;
const CREATE_FEE = 7_000n;
const AMOUNT_PER_FEE = 2_000n;
const SPREAD = RESTART * (1 - RESTART);

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
  const fresh = async (sol = 10n) => {
    const signer = await generateKeyPairSigner();
    w.chain.svm.airdrop(signer.address, lamports(sol * SOL));
    return signer;
  };
  const judge = await fresh();
  let jobs = 0;
  const pays = async (owner: KeyPairSigner, worker: KeyPairSigner, amountIn: bigint = PAY) => {
    const { nonce } = await client.createIntent({
      signer: owner,
      params: { kind: Kind.AttestedResult, amountIn, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: SPEC, judgeFee: 0n },
      inputMint: NATIVE_MINT,
      outputMint: w.outputMint,
    });
    const [intent] = await findIntentPda({ owner: owner.address, nonce });
    const sha256 = (jobs++).toString(16).padStart(64, "0");
    const delivered = await announced(client, worker, intent, sha256);
    await client.settleProof({ judge, intent: { owner: owner.address, nonce }, ...delivered, result: 1n });
  };
  const createFee = async (fee: bigint) => {
    const settings = await client.config();
    const { kindFeeMask, partnerCutBps, crankBounty } = settings;
    const [k0 = 0, k1 = 0, k2 = 0, k3 = 0] = settings.kindFeeBps;
    const economics = { kindFeeMask, kindFeeBps: [k0, k1, k2, k3] as const, partnerCutBps, crankBounty, createFee: Number(fee) };
    await client.send([await buildUpdateEconomics({ admin: w.authority, economics })], w.authority);
  };
  return { transport, fresh, pays, createFee, judge };
}

const feeOf = (amount: bigint): bigint => splitFee(amount, FEE_BPS).fee;

describe("trust numbers", () => {
  it("weighs an edge against everything the payer paid, counted or not, fee and creation fee together", async () => {
    const { transport, fresh, pays, createFee, judge } = await setup();
    await createFee(CREATE_FEE);
    const reader = await fresh(100n);
    const worker = await fresh();
    await pays(reader, worker);
    await pays(reader, judge, 40n * PAY);
    const counted = feeOf(PAY) + CREATE_FEE;
    const cost = counted + feeOf(40n * PAY) + CREATE_FEE;
    const trust = await trustOf(transport, reader.address, worker.address);
    expect(trust.score).toBeCloseTo((SPREAD * Number(counted)) / Number(cost), 12);
  });

  it("carries the share of each edge into the trust of a path", async () => {
    const { transport, fresh, pays } = await setup();
    const [reader, a, b] = await Promise.all([fresh(), fresh(), fresh()]);
    await pays(reader, a);
    await pays(reader, b);
    const trust = await trustOf(transport, reader.address, a.address);
    expect(trust.score).toBeCloseTo(SPREAD / 2, 12);
    expect(trust.paths).toHaveLength(1);
    expect(trust.paths[0]?.trust).toBeCloseTo(SPREAD / 2, 12);
  });

  it("splits the restart over the seeds in the trust of a path", async () => {
    const { transport, fresh, pays } = await setup();
    const [reader, seed, worker] = await Promise.all([fresh(), fresh(), fresh()]);
    await pays(seed, worker);
    const trust = await trustOf(transport, reader.address, worker.address, { seeds: [seed.address] });
    expect(trust.score).toBeCloseTo(SPREAD / 2, 12);
    expect(trust.paths[0]?.trust).toBeCloseTo(SPREAD / 2, 12);
  });

  it("lists the strongest path first, whichever one the walk meets first", async () => {
    for (const first of ["direct", "indirect"]) {
      const { transport, fresh, pays } = await setup();
      const [reader, middle, worker] = await Promise.all([fresh(), fresh(), fresh()]);
      if (first === "direct") {
        await pays(reader, worker);
        await pays(reader, middle);
      } else {
        await pays(reader, middle);
        await pays(reader, worker);
      }
      await pays(middle, worker);
      const trust = await trustOf(transport, reader.address, worker.address);
      expect(trust.paths.map(({ wallets }) => wallets)).toEqual([
        [reader.address, worker.address],
        [reader.address, middle.address, worker.address],
      ]);
      const [strong, weak] = trust.paths;
      expect(strong?.trust).toBeGreaterThan(weak?.trust ?? 1);
    }
  });

  it("walks a cycle once: a wallet already on the path is not entered again", async () => {
    const { transport, fresh, pays } = await setup();
    const [reader, a, b, worker] = await Promise.all([fresh(), fresh(), fresh(), fresh()]);
    await pays(reader, a);
    await pays(a, b);
    await pays(b, a);
    await pays(a, worker);
    const trust = await trustOf(transport, reader.address, worker.address);
    expect(trust.paths.map(({ wallets }) => wallets)).toEqual([[reader.address, a.address, worker.address]]);
  });

  it("stops looking for paths once it has examined ten thousand edges, even for a worker it scored", async () => {
    const { transport, fresh, pays } = await setup();
    const names = ["R", "Z", "C1", "C2", "C3", "C4", "C5", "C6", "C7"] as const;
    const signers = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await fresh()] as const)));
    const at = (name: string): KeyPairSigner => signers[name] as KeyPairSigner;
    const core: Record<string, string[]> = {
      C1: ["C3", "C4", "C5", "C6", "C7"],
      C2: ["C3", "C4", "C6", "C7"],
      C3: ["C4", "C6", "C7"],
      C4: ["C1", "C2", "C3", "C5", "C6", "C7", "R"],
      C5: ["C1", "C2", "C4", "C6", "C7", "R"],
      C6: ["C1", "C4", "C7"],
      C7: ["C1", "C4", "C5", "C6", "R"],
    };
    await pays(at("R"), at("Z"));
    for (const name of ["C1", "C2", "C3", "C4", "C5", "C6", "C7"]) {
      await pays(at("R"), at(name));
    }
    for (const [from, targets] of Object.entries(core)) {
      for (const to of targets) {
        await pays(at(from), at(to));
      }
    }
    const trust = await trustOf(transport, at("R").address, at("Z").address);
    expect(trust.score).toBeGreaterThan(0);
    expect(trust.paths).toEqual([]);
    const near = await trustOf(transport, at("R").address, at("C1").address);
    expect(near.paths.length).toBeGreaterThan(0);
  }, 300_000);

  it("is complete when the wallets named just fit the limit", async () => {
    const { transport, fresh } = await setup();
    const [reader, seed, worker] = await Promise.all([fresh(), fresh(), fresh()]);
    expect(await trustOf(transport, reader.address, worker.address, { maxWallets: 1 })).toMatchObject({ complete: true, wallets: 1 });
    expect(await trustOf(transport, reader.address, worker.address, { maxWallets: 2, seeds: [seed.address] })).toMatchObject({ complete: true, wallets: 2 });
    expect(await trustOf(transport, reader.address, worker.address, { maxWallets: 1, seeds: [seed.address] })).toMatchObject({ complete: false, wallets: 1 });
  });

  it("calls a release incomplete when the wallet it paid cannot be told", async () => {
    const { transport, fresh, pays } = await setup();
    const [reader, a] = await Promise.all([fresh(), fresh()]);
    await pays(reader, a);
    const unnamed = (found: EngineTransaction): EngineTransaction => {
      const copy = { ...found };
      delete copy.tokens;
      return copy;
    };
    const stripped: Transport = {
      ...transport,
      engineTransactions: async (limit, of, memo) => (await transport.engineTransactions(limit, of, memo)).map(unnamed),
      transactionsOf: async (listed) => ((await transport.transactionsOf?.call(transport, listed)) ?? []).map(unnamed),
    };
    expect(await trustOf(transport, reader.address, a.address)).toMatchObject({ complete: true });
    expect(await trustOf(stripped, reader.address, a.address)).toMatchObject({ score: 0, complete: false });
  });

  it("reads the history of only the wallets it walks", async () => {
    const { transport, fresh, pays } = await setup();
    const [reader, a] = await Promise.all([fresh(), fresh()]);
    await pays(reader, a);
    const asked: unknown[] = [];
    const spied: Transport = {
      ...transport,
      signaturesOf: async (of, limit, before) => {
        asked.push(of);
        return transport.signaturesOf?.call(transport, of, limit, before) ?? [];
      },
    };
    await trustOf(spied, reader.address, a.address);
    expect(asked.length).toBeGreaterThan(0);
    expect(asked.every((of) => typeof of === "string")).toBe(true);
  });

  it("weighs an edge by what the worker's own history counts when the payer's history shows less", async () => {
    const { transport, fresh, pays } = await setup();
    const [reader, worker] = await Promise.all([fresh(), fresh()]);
    await pays(reader, worker);
    await pays(reader, worker);
    const listed = (await transport.signaturesOf?.call(transport, reader.address, 100)) ?? [];
    const dropped = listed.at(-1)?.signature;
    const shortened: Transport = {
      ...transport,
      signaturesOf: async (of, limit, before) => ((await transport.signaturesOf?.call(transport, of, limit, before)) ?? []).filter(({ signature }) => of !== reader.address || signature !== dropped),
    };
    const trust = await trustOf(shortened, reader.address, worker.address);
    expect(trust.score).toBeCloseTo(SPREAD, 12);
  });

  it("gives no score, and no path, to a worker whose trust falls below what is worth pushing on", async () => {
    const { transport, fresh, pays, judge } = await setup();
    const [reader, worker] = await Promise.all([fresh(), fresh()]);
    const middle = await fresh(1_000n);
    const forFee = (fee: bigint) => fee * AMOUNT_PER_FEE;
    await pays(reader, middle, forFee(1n));
    await pays(reader, judge, forFee(2_719n));
    await pays(middle, worker, forFee(1n));
    await pays(middle, judge, forFee(265_624_999n));
    const trust = await trustOf(transport, reader.address, worker.address);
    expect(trust).toMatchObject({ score: 0, paths: [], complete: true });
    expect(trust.reason).toBe(`no counted release path from a seed carries trust to ${worker.address}`);
    const near = await trustOf(transport, reader.address, middle.address);
    expect(near.score).toBeGreaterThan(0);
  });
});
