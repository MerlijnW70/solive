import { generateKeyPairSigner } from "@solana/kit";
import { getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { beforeEach, describe, expect, it } from "vitest";
import { splitFees, Kind } from "../src/index.js";
import {
  getIntentSize,
  buildUpdateEconomics,
  buildCloseIntent,
  buildCreateIntent,
  buildFillIntent,
  buildFlashFill,
  decodeEvent,
  buildInitUser,
  findIntentPda,
  splitFee,
  MAX_CRANK_BOUNTY,
  MAX_CREATE_FEE,
} from "../src/internal.js";
import {
  ata,
  attempt,
  authority,
  balance,
  customCode,
  deploy,
  ESCROW,
  FEE_BPS,
  feeRecipient,
  funded,
  INSUFFICIENT_OUTPUT,
  MIN_OUT,
  mint,
  NOW,
  send,
  svm,
} from "./e2e-engine.js";

describe("end to end against the deployed engine, using only the package's builders", () => {
  beforeEach(deploy);

  it("creates, fills and closes a swap intent with exact balances and rent returned", async () => {
    const owner = await funded();
    const solver = await funded();
    const inputMint = await mint(authority);
    const outputMint = await mint(authority);
    const ownerInput = await ata(authority, owner.address, inputMint, 1_000n);
    const receiver = await ata(authority, owner.address, outputMint);
    const solverOutput = await ata(authority, solver.address, outputMint, 10_000n);
    const solverInput = await ata(authority, solver.address, inputMint);
    const feeTo = await ata(authority, feeRecipient.address, inputMint);
    const common = {
      inputMint,
      outputMint,
      inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
    };

    await send(owner, [await buildInitUser({ owner })]);
    await send(owner, [
      await buildCreateIntent({
        treasury: feeRecipient.address,
        maxCreateFee: MAX_CREATE_FEE,
        maxBounty: MAX_CRANK_BOUNTY,
        ...common,
        owner,
        nonce: 7n,
        params: { kind: Kind.SwapExactIn, amountIn: ESCROW, minOut: MIN_OUT },
        expiresAt: NOW + 3_600n,
      }),
    ]);
    expect(balance(ownerInput)).toBe(1_000n - ESCROW);

    const filled = await send(solver, [
      await buildFillIntent({
        ...common,
        solver,
        owner: owner.address,
        nonce: 7n,
        receiver,
        solverOutput,
        solverInput,
        feeRecipient: feeRecipient.address,
        amountIn: ESCROW,
        amountOut: MIN_OUT,
        maxFeeBps: 100,
      }),
    ]);
    const { fee, net } = splitFee(ESCROW, FEE_BPS);
    const emitted = filled
      .innerInstructions()
      .flat()
      .map((inner) => decodeEvent(inner.instruction().data()))
      .filter((event) => event !== null);
    const [filledIntent] = await findIntentPda({ owner: owner.address, nonce: 7n });
    expect(emitted).toEqual([
      {
        name: "IntentFilled",
        notable: false,
        fields: expect.objectContaining({
          intent: filledIntent,
          solver: solver.address,
          receiver,
          fee,
          net,
          amountIn: ESCROW,
          filled: ESCROW,
          remaining: 0n,
        }),
      },
    ]);
    expect(balance(receiver)).toBe(MIN_OUT);
    expect(balance(solverOutput)).toBe(10_000n - MIN_OUT);
    expect(balance(solverInput)).toBe(net);
    expect(balance(feeTo)).toBe(fee);

    const [intent] = await findIntentPda({ owner: owner.address, nonce: 7n });
    const before = svm.getBalance(owner.address) ?? 0n;
    const rent = (svm.getBalance(intent) ?? 0n) + svm.minimumBalanceForRentExemption(165n);
    await send(solver, [
      await buildCloseIntent({
        cranker: solver,
        owner: owner.address,
        nonce: 7n,
        inputMint,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      }),
    ]);
    expect(svm.getAccount(intent).exists).toBe(false);
    expect(svm.getBalance(owner.address)).toBe(before + rent);
  });

  it("charges the configured economics and pays a partner its share on fill", async () => {
    const owner = await funded();
    const solver = await funded();
    const partner = await funded();
    const inputMint = await mint(authority);
    const outputMint = await mint(authority);
    await ata(authority, owner.address, inputMint, 1_000_000n);
    const receiver = await ata(authority, owner.address, outputMint);
    const solverOutput = await ata(authority, solver.address, outputMint, 10_000n);
    const solverInput = await ata(authority, solver.address, inputMint);
    const feeTo = await ata(authority, feeRecipient.address, inputMint);
    const partnerTo = await ata(authority, partner.address, inputMint);
    const common = {
      inputMint,
      outputMint,
      inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
    };
    await send(authority, [
      await buildUpdateEconomics({
        admin: authority,
        economics: { kindFeeMask: 0b10, kindFeeBps: [7, 0, 0, 0], partnerCutBps: 2_000, crankBounty: 60_000, createFee: 15_000 },
      }),
    ]);
    const treasury = svm.getBalance(feeRecipient.address) ?? 0n;
    const amountIn = 100_000n;
    await send(owner, [await buildInitUser({ owner })]);
    await send(owner, [
      await buildCreateIntent({
        ...common,
        owner,
        treasury: feeRecipient.address,
        maxCreateFee: MAX_CREATE_FEE,
        maxBounty: MAX_CRANK_BOUNTY,
        nonce: 1n,
        params: { kind: Kind.SwapExactIn, amountIn, minOut: MIN_OUT },
        expiresAt: NOW + 3_600n,
        partner: { key: partner.address, bps: 50 },
      }),
    ]);
    expect(svm.getBalance(feeRecipient.address)).toBe(treasury + 15_000n);
    const [intent] = await findIntentPda({ owner: owner.address, nonce: 1n });
    const rent = svm.minimumBalanceForRentExemption(BigInt(getIntentSize()));
    expect(svm.getBalance(intent)).toBe(rent + 60_000n);
    const fees = splitFees(amountIn, 7, 50, 2_000);
    await send(solver, [
      await buildFillIntent({
        ...common,
        solver,
        owner: owner.address,
        nonce: 1n,
        receiver,
        solverOutput,
        solverInput,
        feeRecipient: feeRecipient.address,
        partner: partner.address,
        amountIn,
        amountOut: MIN_OUT,
        maxFeeBps: 57,
      }),
    ]);
    expect(fees).toEqual({ protocol: 170n, partner: 400n, net: 99_430n });
    expect(balance(feeTo)).toBe(fees.protocol);
    expect(balance(partnerTo)).toBe(fees.partner);
    expect(balance(solverInput)).toBe(fees.net);
    const before = svm.getBalance(solver.address) ?? 0n;
    await send(solver, [
      await buildCloseIntent({
        cranker: solver,
        owner: owner.address,
        nonce: 1n,
        inputMint,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
      }),
    ]);
    expect(svm.getBalance(solver.address)).toBe(before + 60_000n - 5_000n);
  });

  it("rejects a fill below the minimum and leaves every balance untouched", async () => {
    const owner = await funded();
    const solver = await funded();
    const inputMint = await mint(authority);
    const outputMint = await mint(authority);
    await ata(authority, owner.address, inputMint, 1_000n);
    const receiver = await ata(authority, owner.address, outputMint);
    const solverOutput = await ata(authority, solver.address, outputMint, 10_000n);
    const solverInput = await ata(authority, solver.address, inputMint);
    await ata(authority, feeRecipient.address, inputMint);
    const common = {
      inputMint,
      outputMint,
      inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
    };
    await send(owner, [await buildInitUser({ owner })]);
    await send(owner, [
      await buildCreateIntent({
        treasury: feeRecipient.address,
        maxCreateFee: MAX_CREATE_FEE,
        maxBounty: MAX_CRANK_BOUNTY,
        ...common,
        owner,
        nonce: 0n,
        params: { kind: Kind.SwapExactIn, amountIn: ESCROW, minOut: MIN_OUT },
        expiresAt: NOW + 3_600n,
      }),
    ]);
    const fill = await buildFillIntent({
      ...common,
      solver,
      owner: owner.address,
      nonce: 0n,
      receiver,
      solverOutput,
      solverInput,
      feeRecipient: feeRecipient.address,
      amountIn: ESCROW,
      amountOut: MIN_OUT - 1n,
      maxFeeBps: 100,
    });
    expect(customCode(await attempt(solver, [fill]))).toBe(INSUFFICIENT_OUTPUT);
    expect(balance(receiver)).toBe(0n);
    expect(balance(solverOutput)).toBe(10_000n);
    expect(balance(solverInput)).toBe(0n);
  });

  it("flash fills an intent with routing between begin and end", async () => {
    const owner = await funded();
    const solver = await funded();
    const inputMint = await mint(authority);
    const outputMint = await mint(authority);
    await ata(authority, owner.address, inputMint, 1_000n);
    const receiver = await ata(authority, owner.address, outputMint);
    const solverInput = await ata(authority, solver.address, inputMint);
    const solverOutput = await ata(authority, solver.address, outputMint);
    const stash = await generateKeyPairSigner();
    const stashAccount = await ata(authority, stash.address, outputMint, MIN_OUT);
    const feeTo = await ata(authority, feeRecipient.address, inputMint);
    const common = {
      inputMint,
      outputMint,
      inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
    };
    await send(owner, [await buildInitUser({ owner })]);
    await send(owner, [
      await buildCreateIntent({
        treasury: feeRecipient.address,
        maxCreateFee: MAX_CREATE_FEE,
        maxBounty: MAX_CRANK_BOUNTY,
        ...common,
        owner,
        nonce: 0n,
        params: { kind: Kind.SwapExactIn, amountIn: ESCROW, minOut: MIN_OUT },
        expiresAt: NOW + 3_600n,
      }),
    ]);
    const route = getTransferCheckedInstruction({
      source: stashAccount,
      mint: outputMint,
      destination: solverOutput,
      authority: stash,
      amount: MIN_OUT,
      decimals: 6,
    });
    const ixs = await buildFlashFill({
      ...common,
      solver,
      owner: owner.address,
      nonce: 0n,
      receiver,
      solverOutput,
      solverInput,
      feeRecipient: feeRecipient.address,
      amountIn: ESCROW,
      amountOut: MIN_OUT,
      maxFeeBps: 100,
      route: [route],
    });
    await send(solver, ixs);
    const { fee, net } = splitFee(ESCROW, FEE_BPS);
    expect(balance(receiver)).toBe(MIN_OUT);
    expect(balance(solverInput)).toBe(net);
    expect(balance(feeTo)).toBe(fee);
    expect(balance(solverOutput)).toBe(0n);
  });
});
