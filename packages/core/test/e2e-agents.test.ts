import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { beforeEach, describe, expect, it } from "vitest";
import { Kind } from "../src/index.js";
import {
  buildApproveDelegate,
  buildCreateIntentByAgent,
  buildCreateMandate,
  buildRevokeMandate,
  findMandatePda,
  MANDATE_KINDS,
  MANDATE_NONCE_BIT,
  buildFillIntent,
  decodeEvent,
  buildInitUser,
  findIntentPda,
  findVaultPda,
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
  FEE_ACCOUNT_MISSING,
  feeRecipient,
  FIRST_LANE,
  funded,
  MANDATE_BUDGET,
  MANDATE_MISMATCH,
  MANDATE_PRICE,
  MANDATE_REVOKED,
  mint,
  NOW,
  send,
  svm,
} from "./e2e-engine.js";

describe("end to end against the deployed engine, using only the package's builders", () => {
  beforeEach(deploy);

  it("holds an agent's fee with the escrow and pays it only when the intent fills", async () => {
    const owner = await funded();
    const agent = await funded();
    const solver = await funded();
    const inputMint = await mint(authority);
    const outputMint = await mint(authority);
    const ownerInput = await ata(authority, owner.address, inputMint, 1_000n);
    const receiver = await ata(authority, owner.address, outputMint);
    const agentAccount = await ata(authority, agent.address, inputMint);
    const solverOutput = await ata(authority, solver.address, outputMint, 10_000n);
    const solverInput = await ata(authority, solver.address, inputMint);
    await ata(authority, feeRecipient.address, inputMint);
    const fee = 20n;
    await send(owner, [
      await buildInitUser({ owner }),
      await buildApproveDelegate({ owner, mint: inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS, amount: 1_000n, decimals: 6 }),
      await buildCreateMandate({
        owner,
        inputMint,
        outputMint,
        inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        mandate: {
          id: 0n,
          agent: agent.address,
          kinds: MANDATE_KINDS,
          perIntent: ESCROW + fee,
          total: ESCROW + fee,
          maxIntents: 2,
          maxTtl: 3_600n,
          validUntil: NOW + 86_400n,
          floorOut: 1n,
          floorIn: 1_000n,
          agentFee: fee,
        },
      }),
    ]);
    const byAgent = (nonce: bigint) =>
      buildCreateIntentByAgent({
        agent,
        owner: owner.address,
        mandateId: 0n,
        treasury: feeRecipient.address,
        maxCreateFee: MAX_CREATE_FEE,
        maxBounty: MAX_CRANK_BOUNTY,
        nonce,
        params: { kind: Kind.SwapExactIn, amountIn: ESCROW, minOut: 1n },
        expiresAt: NOW + 3_600n,
        inputMint,
        outputMint,
        inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
    await send(agent, [await byAgent(FIRST_LANE)]);
    const [intent] = await findIntentPda({ owner: owner.address, nonce: FIRST_LANE });
    const [vault] = await findVaultPda({ intent });
    expect(balance(ownerInput)).toBe(1_000n - ESCROW - fee);
    expect(balance(vault)).toBe(ESCROW + fee);
    expect(balance(agentAccount)).toBe(0n);
    expect(customCode(await attempt(agent, [await byAgent(FIRST_LANE | 1n)]))).toBe(MANDATE_BUDGET);
    const [mandate] = await findMandatePda({ owner: owner.address, agent: agent.address, id: 0n });
    const fill = (paid: boolean) =>
      buildFillIntent({
        solver,
        owner: owner.address,
        nonce: FIRST_LANE,
        inputMint,
        outputMint,
        inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        receiver,
        solverOutput,
        solverInput,
        feeRecipient: feeRecipient.address,
        mandate,
        ...(paid ? { agent: agent.address } : {}),
        amountIn: ESCROW,
        amountOut: 1n,
        maxFeeBps: 100,
      });
    expect(customCode(await attempt(solver, [await fill(false)]))).toBe(FEE_ACCOUNT_MISSING);
    const filled = await send(solver, [await fill(true)]);
    expect(balance(agentAccount)).toBe(fee);
    expect(balance(vault)).toBe(0n);
    const paid = filled
      .innerInstructions()
      .flat()
      .map((inner) => decodeEvent(inner.instruction().data()))
      .find((event) => event?.name === "AgentPaid");
    expect(paid?.fields).toMatchObject({ intent, agent: agent.address, account: agentAccount, fee });
  });

  it("lets an agent create intents only within the mandate its owner granted", async () => {
    const owner = await funded();
    const agent = await funded();
    const solver = await funded();
    const inputMint = await mint(authority);
    const outputMint = await mint(authority);
    const ownerInput = await ata(authority, owner.address, inputMint, 1_000n);
    const receiver = await ata(authority, owner.address, outputMint);
    const solverOutput = await ata(authority, solver.address, outputMint, 10_000n);
    const solverInput = await ata(authority, solver.address, inputMint);
    await ata(authority, feeRecipient.address, inputMint);
    const mandate = {
      id: 1n,
      agent: agent.address,
      kinds: MANDATE_KINDS,
      perIntent: ESCROW,
      total: 2n * ESCROW,
      maxIntents: 2,
      maxTtl: 3_600n,
      validUntil: NOW + 86_400n,
      floorOut: 3n,
      floorIn: 4n,
    };
    await send(owner, [
      await buildInitUser({ owner }),
      await buildApproveDelegate({ owner, mint: inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS, amount: 1_000n, decimals: 6 }),
      await buildCreateMandate({
        owner,
        inputMint,
        outputMint,
        inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        mandate,
      }),
    ]);
    const byAgent = (nonce: bigint, minOut: bigint) =>
      buildCreateIntentByAgent({
        agent,
        owner: owner.address,
        mandateId: 1n,
        treasury: feeRecipient.address,
        maxCreateFee: MAX_CREATE_FEE,
        maxBounty: MAX_CRANK_BOUNTY,
        nonce,
        params: { kind: Kind.SwapExactIn, amountIn: ESCROW, minOut },
        expiresAt: NOW + 3_600n,
        inputMint,
        outputMint,
        inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      });
    expect(customCode(await attempt(agent, [await byAgent(MANDATE_NONCE_BIT, 300n)]))).toBe(MANDATE_MISMATCH);
    expect(customCode(await attempt(agent, [await byAgent(FIRST_LANE + (1n << 32n), 300n)]))).toBe(MANDATE_MISMATCH);
    expect(customCode(await attempt(agent, [await byAgent(FIRST_LANE, 299n)]))).toBe(MANDATE_PRICE);
    const ownerBefore = svm.getBalance(owner.address);
    await send(agent, [await byAgent(FIRST_LANE, 300n)]);
    expect(balance(ownerInput)).toBe(1_000n - ESCROW);
    expect(svm.getBalance(owner.address)).toBe(ownerBefore);
    await send(agent, [await byAgent(FIRST_LANE | 1n, 300n)]);
    expect(customCode(await attempt(agent, [await byAgent(FIRST_LANE | 2n, 300n)]))).toBe(MANDATE_BUDGET);
    const [address] = await findMandatePda({ owner: owner.address, agent: agent.address, id: 1n });
    const fill = (nonce: bigint, named: boolean) =>
      buildFillIntent({
        solver,
        owner: owner.address,
        nonce,
        inputMint,
        outputMint,
        inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        receiver,
        solverOutput,
        solverInput,
        feeRecipient: feeRecipient.address,
        ...(named ? { mandate: address } : {}),
        amountIn: ESCROW,
        amountOut: 300n,
        maxFeeBps: 100,
      });
    expect(customCode(await attempt(solver, [await fill(FIRST_LANE, false)]))).toBe(MANDATE_REVOKED);
    await send(solver, [await fill(FIRST_LANE, true)]);
    expect(balance(receiver)).toBe(300n);
    await send(owner, [await buildRevokeMandate({ owner, agent: agent.address, id: 1n })]);
    expect(svm.getAccount(address).exists).toBe(false);
    expect(customCode(await attempt(solver, [await fill(FIRST_LANE | 1n, true)]))).toBe(MANDATE_REVOKED);
  });
});
