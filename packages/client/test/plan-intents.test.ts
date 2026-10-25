import { type Address, generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, findAssociatedTokenAddress, IntentStatus, NATIVE_MINT, swapExactIn, TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import { findIntentPda } from "@intent-engine/core/internal";
import { InvalidInput } from "../src/index.js";
import { PAYER_DIFFERS, submit } from "../src/internal.js";
import { createTestWorld, type TestWallet, type TestWorld } from "../src/testing.js";
import { checkCase, recording, statusOf } from "./plan-driver.js";

const SOL = 1_000_000_000n;
const SELL = SOL / 10n;

const swapped = (minOut = 5n) => swapExactIn({ amountIn: SELL, minOut });

async function placed(world: TestWorld, expiresIn?: bigint) {
  const owner = await world.wallet();
  const made = await world.client.createIntent({ signer: owner, inputMint: NATIVE_MINT, outputMint: DEVNET_TEST_MINT, params: swapped(), ...(expiresIn === undefined ? {} : { expiresIn }) });
  return { owner, intent: made.intent, nonce: made.nonce, cranker: await world.wallet() };
}

const held = async (world: TestWorld, owner: Address, mint: Address = NATIVE_MINT) => world.tokenBalance(owner, mint);

const wrapped = async (world: TestWorld, owner: Address) =>
  world.svm.getAccount(await findAssociatedTokenAddress({ owner, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS })).exists;

describe("every write is its plan, sent", () => {
  it("createIntent", async () => {
    const world = await createTestWorld();
    await checkCase(world, {
      lane: async (w) => ({ owner: await w.wallet() }),
      plan: (client, { owner }) => client.plan.createIntent({ signer: owner, inputMint: NATIVE_MINT, outputMint: DEVNET_TEST_MINT, params: swapped() }),
      write: (client, { owner }) => client.createIntent({ signer: owner, inputMint: NATIVE_MINT, outputMint: DEVNET_TEST_MINT, params: swapped() }),
      payer: ({ owner }) => owner,
      observe: async (w, { owner }) => {
        const found = await w.client.intent({ owner: owner.address, nonce: 0n });
        const { status, escrowed, kind, partnerBps, expiresAt } = found?.intent ?? {};
        return { status, escrowed, kind, partnerBps, expiresAt, sol: w.svm.getBalance(owner.address) };
      },
    });
  });

  it("cancel", async () => {
    const world = await createTestWorld();
    await checkCase(world, {
      lane: (w) => placed(w),
      plan: (client, { owner, intent }) => client.plan.cancel(owner, intent),
      write: (client, { owner, nonce }) => client.cancel(owner, { owner: owner.address, nonce }),
      payer: ({ owner }) => owner,
      observe: async (w, { owner, intent }) => ({ status: await statusOf(w, intent), refund: await held(w, owner.address) }),
    });
  });

  it("fill", async () => {
    const world = await createTestWorld();
    const output = await world.mint();
    await checkCase(world, {
      lane: async (w) => {
        const owner = await w.wallet();
        const made = await w.client.createIntent({ signer: owner, inputMint: NATIVE_MINT, outputMint: output, params: swapped(1_000n) });
        const solver = await w.wallet();
        await w.tokens(solver.address, output, 5_000n);
        return { owner, solver, intent: made.intent };
      },
      plan: (client, { solver, intent }) => client.plan.fill({ solver, intent }),
      write: (client, { solver, intent }) => client.fill({ solver, intent }),
      payer: ({ solver }) => solver,
      observe: async (w, { owner, solver, intent }) => ({
        status: await statusOf(w, intent),
        bought: await held(w, owner.address, output),
        sold: await held(w, solver.address),
        left: await held(w, solver.address, output),
      }),
    });
  });

  it("expire", async () => {
    const world = await createTestWorld();
    await checkCase(world, {
      lane: (w) => placed(w, 60n),
      before: (w) => {
        w.warp(61);
      },
      plan: (client, { cranker, intent }) => client.plan.expire(cranker, intent),
      write: (client, { cranker, owner, nonce }) => client.expire(cranker, { owner: owner.address, nonce }),
      payer: ({ cranker }) => cranker,
      observe: async (w, { owner, intent }) => ({ status: await statusOf(w, intent), refund: await held(w, owner.address) }),
    });
  });

  it("close", async () => {
    const world = await createTestWorld();
    await checkCase(world, {
      lane: async (w) => {
        const lane = await placed(w);
        await w.client.cancel(lane.owner, lane.intent);
        return lane;
      },
      plan: (client, { cranker, intent }) => client.plan.close(cranker, intent),
      write: (client, { cranker, owner, nonce }) => client.close(cranker, { owner: owner.address, nonce }),
      payer: ({ cranker }) => cranker,
      observe: async (w, { owner, intent }) => ({ gone: (await w.client.intent(intent)) === null, sol: w.svm.getBalance(owner.address) }),
    });
  });

  it("unwrap", async () => {
    const world = await createTestWorld();
    await checkCase(world, {
      lane: async (w) => {
        const owner = await w.wallet();
        await w.tokens(owner.address, NATIVE_MINT, SELL);
        return { owner };
      },
      plan: (client, { owner }) => client.plan.unwrap(owner),
      write: (client, { owner }) => client.unwrap(owner),
      payer: ({ owner }) => owner,
      observe: async (w, { owner }) => ({ wrapped: await wrapped(w, owner.address), sol: w.svm.getBalance(owner.address) }),
    });
    const empty = await world.wallet();
    expect(await world.client.plan.unwrap(empty)).toMatchObject({ setup: [], instructions: [] });
    expect(await world.client.unwrap(empty)).toBeNull();
  });

  it("createCommittee", async () => {
    const world = await createTestWorld();
    const result = await checkCase(world, {
      lane: async (w) => ({ payer: await w.wallet(), members: [(await generateKeyPairSigner()).address, (await generateKeyPairSigner()).address] }),
      plan: (client, { payer, members }) => client.plan.createCommittee({ payer, members, threshold: 2, feeWallet: payer.address }),
      write: (client, { payer, members }) => client.createCommittee({ payer, members, threshold: 2, feeWallet: payer.address }),
      payer: ({ payer }) => payer,
      observe: async (w, { payer, members }) => {
        const { committee } = await w.client.plan.createCommittee({ payer, members, threshold: 2, feeWallet: payer.address });
        const view = await w.client.committee(committee);
        return { threshold: view?.threshold, members: view?.members.length, sol: w.svm.getBalance(payer.address) };
      },
    });
    expect(result.written).toMatchObject({ threshold: 2, members: 2 });
  });
});

describe("a plan", () => {
  it("names its payer, the setup that lands first, its instructions, the signers each needs and no lookup tables, and sends nothing", async () => {
    const world = await createTestWorld();
    const { client, sent } = recording(world);
    const owner: TestWallet = await world.wallet();
    const before = world.svm.getBalance(owner.address);
    const plan = await client.plan.createIntent({ signer: owner, inputMint: NATIVE_MINT, outputMint: DEVNET_TEST_MINT, params: swapped() });
    expect(sent).toEqual([]);
    expect(world.svm.getBalance(owner.address)).toBe(before);
    expect(plan).toMatchObject({ payer: owner.address, setup: [], setupSigners: [], lookupTables: {}, intent: (await findIntentPda({ owner: owner.address, nonce: 0n }))[0], nonce: 0n });
    expect(plan.signers).toHaveLength(plan.instructions.length);
    expect(new Set(plan.signers.flat())).toEqual(new Set([owner.address]));
    expect(plan.signers.at(-1)).toEqual([owner.address]);
    expect(plan).toMatchObject({ registers: true, createsPayTo: true, wraps: SELL, payTo: owner.address, committee: null });
  });

  it("is sent only by the wallet it names as payer", async () => {
    const world = await createTestWorld();
    const lane = await placed(world);
    const plan = await world.client.plan.cancel(lane.owner, lane.intent);
    const refused = await submit(world.client.send, plan, lane.cranker).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(InvalidInput);
    expect(refused).toMatchObject({ field: "payer", rule: "conflict" });
    expect((refused as Error).message).toContain(PAYER_DIFFERS);
    expect(await statusOf(world, lane.intent)).toBe(IntentStatus.Open);
    await expect(world.client.cancel(lane.cranker, lane.intent)).rejects.toMatchObject({ field: "signer", rule: "conflict" });
  });
});
