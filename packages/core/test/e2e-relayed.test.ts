import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { beforeEach, describe, expect, it } from "vitest";
import { Kind } from "../src/index.js";
import {
  buildApproveDelegate,
  buildAdvanceEpoch,
  buildCreateIntentSigned,
  signedIntentMessage,
  signEd25519Instruction,
  decodeEvent,
  buildInitUser,
  findIntentPda,
  encodeParams,
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
  DOMAIN,
  ESCROW,
  feeRecipient,
  funded,
  MIN_OUT,
  mint,
  NOW,
  send,
  SIG_MESSAGE,
  svm,
} from "./e2e-engine.js";

describe("end to end against the deployed engine, using only the package's builders", () => {
  beforeEach(deploy);

  it("lets a relayer submit an intent the owner only signed offline", async () => {
    const owner = await funded();
    const relayer = await funded();
    const inputMint = await mint(authority);
    const outputMint = await mint(authority);
    const ownerInput = await ata(authority, owner.address, inputMint, 1_000n);
    const receiver = await ata(authority, owner.address, outputMint);
    await send(owner, [
      await buildInitUser({ owner }),
      await buildApproveDelegate({
        owner,
        mint: inputMint,
        tokenProgram: TOKEN_PROGRAM_ADDRESS,
        amount: ESCROW,
        decimals: 6,
      }),
    ]);
    const params = { kind: Kind.SwapExactIn, amountIn: ESCROW, minOut: MIN_OUT } as const;
    const expiresAt = NOW + 3_600n;
    const submitBy = NOW + 600n;
    const signed = (epoch: bigint) =>
      signedIntentMessage({
        domain: DOMAIN,
        owner: owner.address,
        ownerInput,
        submitBy,
        inputMint,
        outputMint,
        receiver,
        nonce: 3n,
        expiresAt,
        kind: Kind.SwapExactIn,
        params: encodeParams(params),
        epoch,
      });
    const create = await buildCreateIntentSigned({
      treasury: feeRecipient.address,
      maxCreateFee: MAX_CREATE_FEE,
      maxBounty: MAX_CRANK_BOUNTY,
      payer: relayer,
      owner: owner.address,
      submitBy,
      nonce: 3n,
      params,
      expiresAt,
      inputMint,
      outputMint,
      inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
    });
    const stale = await signed(0n);
    await send(owner, [await buildAdvanceEpoch({ owner, epoch: 1n })]);
    expect(customCode(await attempt(relayer, [await signEd25519Instruction(owner, stale), create]))).toBe(
      SIG_MESSAGE,
    );
    const ownerBefore = svm.getBalance(owner.address);
    await send(relayer, [await signEd25519Instruction(owner, await signed(1n)), create]);
    expect(balance(ownerInput)).toBe(1_000n - ESCROW);
    expect(svm.getBalance(owner.address)).toBe(ownerBefore);
    const [intent] = await findIntentPda({ owner: owner.address, nonce: 3n });
    expect(svm.getAccount(intent).exists).toBe(true);
  });

  it("pays a relayer exactly the fee the owner signed for, in the input token", async () => {
    const owner = await funded();
    const relayer = await funded();
    const inputMint = await mint(authority);
    const outputMint = await mint(authority);
    const ownerInput = await ata(authority, owner.address, inputMint, 1_000n);
    const receiver = await ata(authority, owner.address, outputMint);
    const relayerAccount = await ata(authority, relayer.address, inputMint);
    const fee = 15n;
    await send(owner, [
      await buildInitUser({ owner }),
      await buildApproveDelegate({ owner, mint: inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS, amount: ESCROW + fee, decimals: 6 }),
    ]);
    const params = { kind: Kind.SwapExactIn, amountIn: ESCROW, minOut: MIN_OUT } as const;
    const expiresAt = NOW + 3_600n;
    const submitBy = NOW + 600n;
    const message = (relayerFee: bigint) =>
      signedIntentMessage({
        domain: DOMAIN,
        owner: owner.address,
        ownerInput,
        submitBy,
        inputMint,
        outputMint,
        receiver,
        nonce: 4n,
        expiresAt,
        kind: Kind.SwapExactIn,
        params: encodeParams(params),
        epoch: 0n,
        relayerFee,
      });
    const create = (relayerFee: bigint) =>
      buildCreateIntentSigned({
        treasury: feeRecipient.address,
        maxCreateFee: MAX_CREATE_FEE,
        maxBounty: MAX_CRANK_BOUNTY,
        payer: relayer,
        owner: owner.address,
        submitBy,
        nonce: 4n,
        params,
        expiresAt,
        inputMint,
        outputMint,
        inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        relayerFee,
      });
    const signature = await signEd25519Instruction(owner, await message(fee));
    expect(customCode(await attempt(relayer, [signature, await create(fee + 1n)]))).toBe(SIG_MESSAGE);
    const meta = await send(relayer, [signature, await create(fee)]);
    expect(balance(ownerInput)).toBe(1_000n - ESCROW - fee);
    expect(balance(relayerAccount)).toBe(fee);
    const [intent] = await findIntentPda({ owner: owner.address, nonce: 4n });
    const paid = meta
      .innerInstructions()
      .flat()
      .map((inner) => decodeEvent(inner.instruction().data()))
      .find((event) => event?.name === "RelayerPaid");
    expect(paid?.fields).toMatchObject({ intent, relayer: relayer.address, account: relayerAccount, fee });
  });
});
