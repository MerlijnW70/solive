import { type Address, generateKeyPairSigner, type KeyPairSigner, lamports, none } from "@solana/kit";
import { getCreateAssociatedTokenIdempotentInstructionAsync, getMintEncoder, getMintSize, getMintToInstruction } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import {
  buildFlashFill,
  findAssociatedTokenAddress,
  IntentStatus,
  Kind,
  NATIVE_MINT,
  splitFee,
  TOKEN_PROGRAM_ADDRESS,
} from "@intent-engine/core";
import { createClient, NotFillable } from "../src/index.js";
import { FEE_BPS, funded, NOW, world, type World } from "./svm.js";

const LOCAL = "http://127.0.0.1:8899";
const ESCROW = 400n;
const MIN_OUT = 30n;
const ata = (owner: Address, mint: Address) => findAssociatedTokenAddress({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });

async function setup() {
  const w = await world();
  const client = createClient({ url: LOCAL, transport: w.chain.transport });
  const solver = await funded(w.chain);
  const svm = w.chain.svm;
  const tokens = async (owner: Address, mint: Address) => {
    const found = svm.getAccount(await ata(owner, mint));
    return found.exists ? new DataView(found.data.buffer, found.data.byteOffset).getBigUint64(64, true) : null;
  };
  const order = { signer: w.owner, inputMint: w.inputMint, outputMint: w.outputMint };
  const swap = { kind: Kind.SwapExactIn, amountIn: ESCROW, minOut: MIN_OUT } as const;
  const minted = async (to: KeyPairSigner, amount: bigint) => [
    getMintToInstruction({ mint: w.outputMint, token: await ata(to.address, w.outputMint), mintAuthority: w.authority, amount }),
  ];
  const failure = async (pending: Promise<unknown>) => pending.then(() => null, (error: unknown) => error);
  return { w, client, solver, svm, tokens, order, swap, minted, failure };
}

function nativeMint(w: World) {
  const space = BigInt(getMintSize());
  w.chain.svm.setAccount({
    address: NATIVE_MINT,
    data: Uint8Array.from(getMintEncoder().encode({ mintAuthority: none(), supply: 0n, decimals: 9, isInitialized: true, freezeAuthority: none() })),
    executable: false,
    lamports: lamports(w.chain.svm.minimumBalanceForRentExemption(space)),
    programAddress: TOKEN_PROGRAM_ADDRESS,
    space,
  });
}

describe("filling from the client", () => {
  it("fills an open swap from a wallet with no token accounts, paying the protocol fee to the treasury wallet's account", async () => {
    const { w, client, solver, tokens, order, swap, minted } = await setup();
    const created = await client.createIntent({ ...order, params: swap });
    expect(await tokens(w.feeRecipient.address, w.inputMint)).toBeNull();
    expect(await tokens(solver.address, w.inputMint)).toBeNull();
    expect(await tokens(solver.address, w.outputMint)).toBeNull();
    expect(await client.fillOf(created.intent)).toBeNull();

    const signature = await client.fill({ solver, owner: w.owner.address, nonce: created.nonce, route: await minted(solver, MIN_OUT) });
    const { fee, net } = splitFee(ESCROW, FEE_BPS);
    expect(fee).toBeGreaterThan(0n);
    expect(await tokens(w.feeRecipient.address, w.inputMint)).toBe(fee);
    expect(await tokens(solver.address, w.inputMint)).toBe(net);
    expect(await tokens(solver.address, w.outputMint)).toBe(0n);
    expect(await tokens(w.owner.address, w.outputMint)).toBe(MIN_OUT);
    expect((await client.intent(w.owner.address, created.nonce))?.intent.status).toBe(IntentStatus.Filled);

    const read = { steps: 1, solver: solver.address, delivered: MIN_OUT, required: MIN_OUT, fee, net, signature, blockTime: NOW };
    expect(await client.fillOf(created.intent)).toMatchObject(read);
    expect(typeof (await client.fillOf(created.intent))?.slot).toBe("bigint");

    const again = await client.fill({ solver, owner: w.owner.address, nonce: created.nonce }).catch((error: unknown) => error);
    expect(again).toBeInstanceOf(NotFillable);
    expect((again as Error).message).toContain("is not open");

    await client.close(solver, w.owner.address, created.nonce);
    expect(await client.intent(w.owner.address, created.nonce)).toBeNull();
    expect(await client.fillOf(created.intent)).toMatchObject(read);
  });

  it("reads a two-step fill from FillBegun and FillEnded", async () => {
    const { w, client, solver, order, swap, minted } = await setup();
    const created = await client.createIntent({ ...order, params: swap });
    const solverInput = await ata(solver.address, w.inputMint);
    const solverOutput = await ata(solver.address, w.outputMint);
    const delivered = MIN_OUT + 5n;
    const flash = await buildFlashFill({
      solver,
      owner: w.owner.address,
      nonce: created.nonce,
      inputMint: w.inputMint,
      outputMint: w.outputMint,
      inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      receiver: await ata(w.owner.address, w.outputMint),
      solverInput,
      solverOutput,
      feeRecipient: w.feeRecipient.address,
      amountIn: ESCROW,
      amountOut: delivered,
      maxFeeBps: FEE_BPS,
      prefix: await Promise.all(
        [
          [solver.address, w.inputMint],
          [solver.address, w.outputMint],
          [w.feeRecipient.address, w.inputMint],
        ].map(([owner, mint]) => getCreateAssociatedTokenIdempotentInstructionAsync({ payer: solver, owner: owner as Address, mint: mint as Address })),
      ),
      route: await minted(solver, delivered),
    });
    const signature = await client.send(flash, solver);
    const names = (await client.history(created.intent)).map(({ name }) => name);
    expect(names.slice(0, 2)).toEqual(["FillEnded", "FillBegun"]);
    expect(names).not.toContain("IntentFilled");
    const { fee, net } = splitFee(ESCROW, FEE_BPS);
    expect(await client.fillOf(created.intent)).toMatchObject({ steps: 2, solver: solver.address, delivered, required: MIN_OUT, fee, net, signature, blockTime: NOW });
  });

  it("fills a limit order whole and a dutch auction at the minimum the chain's clock gives", async () => {
    const { w, client, solver, svm, tokens, order, minted, failure } = await setup();
    const limit = await client.createIntent({ ...order, params: { kind: Kind.LimitOrder, makeAmount: ESCROW, takeAmount: 50n } });
    const part = client.fill({ solver, owner: w.owner.address, nonce: limit.nonce, amountIn: ESCROW / 2n, route: await minted(solver, 25n) });
    expect(client.explain(await failure(part))?.name).toBe("AmountInMismatch");
    await client.fill({ solver, owner: w.owner.address, nonce: limit.nonce, route: await minted(solver, 50n) });
    expect((await client.intent(w.owner.address, limit.nonce))?.intent.status).toBe(IntentStatus.Filled);
    expect(await client.fillOf(limit.intent)).toMatchObject({ steps: 1, delivered: 50n, required: 50n, fee: splitFee(ESCROW, FEE_BPS).fee });

    const auction = { kind: Kind.DutchAuction, amountIn: 100n, startOut: 90n, endOut: 10n, startTs: NOW, endTs: NOW + 80n } as const;
    const dutch = await client.createIntent({ ...order, params: auction });
    const clock = svm.getClock();
    clock.unixTimestamp = NOW + 20n;
    svm.setClock(clock);
    await client.fill({ solver, owner: w.owner.address, nonce: dutch.nonce, route: await minted(solver, 70n) });
    expect(await client.fillOf(dutch.intent)).toMatchObject({ delivered: 70n, required: 70n, blockTime: NOW + 20n });
    expect(await tokens(w.owner.address, w.outputMint)).toBe(120n);
  });

  it("refuses a proof escrow, which only its judge settles", async () => {
    const { w, client, solver, order, failure } = await setup();
    const judge = await generateKeyPairSigner();
    const work = { kind: Kind.AttestedResult, amountIn: ESCROW, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: new Uint8Array(32).fill(7), judgeFee: 0n } as const;
    const job = await client.createIntent({ ...order, params: work });
    const refused = await failure(client.fill({ solver, owner: w.owner.address, nonce: job.nonce }));
    expect(refused).toBeInstanceOf(NotFillable);
    expect((refused as Error).message).toBe(`intent ${job.intent} is an AttestedResult intent, which only its judge settles`);
    expect(await client.fillOf(job.intent)).toBeNull();
  });

  it("expires an overdue intent and closes it from any wallet", async () => {
    const { w, client, solver, svm, tokens, order, swap, failure } = await setup();
    const created = await client.createIntent({ ...order, params: swap, expiresIn: 60n });
    expect(client.explain(await failure(client.expire(solver, w.owner.address, created.nonce)))?.name).toBe("NotExpired");
    expect(client.explain(await failure(client.close(solver, w.owner.address, created.nonce)))?.name).toBe("InvalidTransition");
    const clock = svm.getClock();
    clock.unixTimestamp = NOW + 60n;
    svm.setClock(clock);
    const held = await tokens(w.owner.address, w.inputMint);
    await client.expire(solver, w.owner.address, created.nonce);
    expect((await client.intent(w.owner.address, created.nonce))?.intent.status).toBe(IntentStatus.Expired);
    expect(await tokens(w.owner.address, w.inputMint)).toBe((held ?? 0n) + ESCROW);
    const rent = svm.getBalance(created.intent) ?? 0n;
    const before = svm.getBalance(w.owner.address) ?? 0n;
    await client.close(solver, w.owner.address, created.nonce);
    expect(await client.intent(w.owner.address, created.nonce)).toBeNull();
    expect((svm.getBalance(w.owner.address) ?? 0n) - before).toBeGreaterThanOrEqual(rent);
  });

  it("reads a wallet's SOL and its canonical token accounts, with 0 for an account it lacks", async () => {
    const { w, client, solver, order, swap, minted } = await setup();
    nativeMint(w);
    const created = await client.createIntent({ ...order, params: swap });
    await client.fill({ solver, owner: w.owner.address, nonce: created.nonce, route: await minted(solver, MIN_OUT) });
    const { sol, tokens } = await client.balances(solver.address, [NATIVE_MINT, w.inputMint]);
    expect(sol).toBe(w.chain.svm.getBalance(solver.address));
    expect(tokens).toEqual([
      { mint: NATIVE_MINT, name: "SOL", account: await ata(solver.address, NATIVE_MINT), amount: 0n, decimals: 9 },
      { mint: w.inputMint, name: undefined, account: await ata(solver.address, w.inputMint), amount: splitFee(ESCROW, FEE_BPS).net, decimals: 6 },
    ]);
    expect(await client.balances((await generateKeyPairSigner()).address, [])).toEqual({ sol: 0n, tokens: [] });
  });
});
