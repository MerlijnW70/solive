import { generateKeyPairSigner } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { beforeEach, describe, expect, it } from "vitest";
import { Kind } from "../src/index.js";
import {
  attestedFillMessage,
  buildFillAttested,
  signEd25519Instruction,
  buildCreateIntent,
  buildInitUser,
  findIntentPda,
  splitFee,
  MAX_CRANK_BOUNTY,
  MAX_CREATE_FEE,
} from "../src/internal.js";
import {
  ata,
  authority,
  balance,
  deploy,
  DOMAIN,
  ESCROW,
  FEE_BPS,
  feeRecipient,
  funded,
  mint,
  NOW,
  send,
} from "./e2e-engine.js";

describe("end to end against the deployed engine, using only the package's builders", () => {
  beforeEach(deploy);

  it("releases an attested intent's escrow to the payee the attestor named", async () => {
    const owner = await funded();
    const solver = await funded();
    const attestor = await generateKeyPairSigner();
    const inputMint = await mint(authority);
    const outputMint = await mint(authority);
    await ata(authority, owner.address, inputMint, 1_000n);
    await ata(authority, owner.address, outputMint);
    const payee = await ata(authority, solver.address, inputMint);
    const feeTo = await ata(authority, feeRecipient.address, inputMint);
    await send(owner, [await buildInitUser({ owner })]);
    await send(owner, [
      await buildCreateIntent({
        treasury: feeRecipient.address,
        maxCreateFee: MAX_CREATE_FEE,
        maxBounty: MAX_CRANK_BOUNTY,
        owner,
        nonce: 0n,
        params: {
          kind: Kind.AttestedResult,
          amountIn: ESCROW,
          minResult: 10n,
          maxResult: 20n,
          attestor: attestor.address,
          specHash: new Uint8Array(32),
          judgeFee: 0n,
        },
        expiresAt: NOW + 3_600n,
        inputMint,
        outputMint,
        inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      }),
    ]);
    const [intent] = await findIntentPda({ owner: owner.address, nonce: 0n });
    const fill = await buildFillAttested({
      solver,
      owner: owner.address,
      nonce: 0n,
      inputMint,
      inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      payee,
      feeRecipient: feeRecipient.address,
      amountIn: ESCROW,
      result: 15n,
      maxFeeBps: FEE_BPS,
    });
    await send(solver, [
      await signEd25519Instruction(
        attestor,
        await attestedFillMessage(attestor.address, {
          domain: DOMAIN,
          intent,
          payee,
          amountIn: ESCROW,
          result: 15n,
          maxFeeBps: FEE_BPS,
        }),
      ),
      fill,
    ]);
    const { fee, net } = splitFee(ESCROW, FEE_BPS);
    expect(balance(payee)).toBe(net);
    expect(balance(feeTo)).toBe(fee);
  });
});
