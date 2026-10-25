import type { Address, TransactionSigner } from "@solana/kit";
import { findAssociatedTokenAddress, IntentStatus, InvalidInput, Kind, NATIVE_MINT, splitFees, TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import { buildCancelIntent, buildCloseIntent, buildExpireIntent, buildFillIntent, decodeParams, remainingOf, requiredOut } from "@intent-engine/core/internal";
import { getCloseAccountInstruction } from "@solana-program/token";
import { chainTime, createdAccount } from "./accounts.js";
import { NotFillable } from "./client-errors.js";
import type { ClientContext, FillInput } from "./client-types.js";
import { cancelClaims } from "./client-claims.js";
import { type IntentRef, loadIntentRef } from "./intent-ref.js";
import { type Plan, planOf } from "./plan.js";
import { tokenAccountIfMissing, wrapIfShort } from "./setup.js";

export const notOwnerCancel = (intent: Address, owner: Address, signer: Address): string =>
  `intent ${intent} belongs to ${owner}, and only its owner cancels it, not ${signer}`;

export function intentPlans({ transport, mint, config }: ClientContext) {
  const cancel = async (signer: TransactionSigner, ref: IntentRef): Promise<Plan> => {
    const { address, intent } = await loadIntentRef(transport, ref);
    if (intent.owner !== signer.address) {
      throw new InvalidInput("signer", "conflict", notOwnerCancel(address, intent.owner, signer.address));
    }
    const { tokenProgram } = await mint(intent.inputMint);
    const refund = await tokenAccountIfMissing(transport, signer, signer.address, intent.inputMint, tokenProgram);
    const claims = await cancelClaims(transport, address, intent.claims);
    const cancelled = await buildCancelIntent({
      owner: signer,
      nonce: intent.nonce,
      inputMint: intent.inputMint,
      tokenProgram,
      capped: intent.capped,
      ...(claims === undefined ? {} : { claims }),
    });
    return planOf({ payer: signer.address, instructions: [...refund.create, cancelled] });
  };

  const unwrap = async (signer: TransactionSigner): Promise<Plan> => {
    const account = await findAssociatedTokenAddress({ owner: signer.address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const held = (await createdAccount(transport, account)) !== null;
    return planOf({ payer: signer.address, instructions: held ? [getCloseAccountInstruction({ account, destination: signer.address, owner: signer })] : [] });
  };

  const fill = async (input: FillInput): Promise<Plan> => {
    const { solver } = input;
    const [{ address, intent: held }, settings] = await Promise.all([loadIntentRef(transport, input.intent), config()]);
    if (held.status !== IntentStatus.Open) {
      throw new NotFillable(address, "not-open", "is not open");
    }
    const params = decodeParams(held.kind, Uint8Array.from(held.params));
    if (params.kind === Kind.AttestedResult) {
      throw new NotFillable(address, "attested", "is an AttestedResult intent, which only its judge settles");
    }
    const [sell, buy] = await Promise.all([mint(held.inputMint), mint(held.outputMint)]);
    const amountIn = input.amountIn ?? remainingOf(held);
    const amountOut = input.amountOut ?? requiredOut(params, amountIn, await chainTime(transport));
    const kindBps = held.feeBps;
    const shares = splitFees(amountIn, kindBps, held.partnerBps, held.partnerCutBps);
    const feeRecipient = shares.protocol > 0n ? settings.feeRecipient : undefined;
    const partner = shares.partner > 0n ? held.partner : undefined;
    const agent = held.agentFee > 0n ? held.rentPayer : undefined;
    const paid = (wallet: Address) => tokenAccountIfMissing(transport, solver, wallet, held.inputMint, sell.tokenProgram);
    const [solverInput, solverOutput, ...payouts] = await Promise.all([
      paid(solver.address),
      tokenAccountIfMissing(transport, solver, solver.address, held.outputMint, buy.tokenProgram),
      ...[feeRecipient, partner, agent].filter((wallet) => wallet !== undefined).map(paid),
    ]);
    const filled = await buildFillIntent({
      solver,
      owner: held.owner,
      nonce: held.nonce,
      inputMint: held.inputMint,
      outputMint: held.outputMint,
      inputTokenProgram: sell.tokenProgram,
      outputTokenProgram: buy.tokenProgram,
      receiver: held.receiver,
      solverInput: solverInput.address,
      solverOutput: solverOutput.address,
      ...(feeRecipient === undefined ? {} : { feeRecipient }),
      ...(partner === undefined ? {} : { partner }),
      ...(agent === undefined ? {} : { agent }),
      mandate: held.mandate,
      amountIn,
      amountOut,
      maxFeeBps: kindBps + held.partnerBps,
      capped: held.capped,
    });
    const setup = [solverInput, solverOutput, ...payouts].flatMap(({ create }) => create);
    const wrap = input.route === undefined ? (await wrapIfShort(transport, solver, held.outputMint, buy.tokenProgram, amountOut)).instructions : [];
    return planOf({ payer: solver.address, instructions: [...setup, ...wrap, ...(input.route ?? []), filled] });
  };

  const settling = async (cranker: TransactionSigner, ref: IntentRef) => {
    const { intent } = await loadIntentRef(transport, ref);
    const { tokenProgram } = await mint(intent.inputMint);
    const settled = { cranker, owner: intent.owner, nonce: intent.nonce, inputMint: intent.inputMint, tokenProgram, capped: intent.capped };
    return { settled, rentPayer: intent.rentPayer };
  };

  const expire = async (cranker: TransactionSigner, ref: IntentRef): Promise<Plan> => {
    const { settled } = await settling(cranker, ref);
    const refund = await tokenAccountIfMissing(transport, cranker, settled.owner, settled.inputMint, settled.tokenProgram);
    return planOf({ payer: cranker.address, instructions: [...refund.create, await buildExpireIntent(settled)] });
  };

  const close = async (cranker: TransactionSigner, ref: IntentRef): Promise<Plan> => {
    const { settled, rentPayer } = await settling(cranker, ref);
    return planOf({ payer: cranker.address, instructions: [await buildCloseIntent({ ...settled, rentPayer })] });
  };

  return { cancel, unwrap, fill, expire, close };
}
