import type { Address, TransactionSigner } from "@solana/kit";
import {
  buildCancelIntent,
  buildCloseIntent,
  buildCreateIntent,
  buildExpireIntent,
  buildFillIntent,
  decodeParams,
  escrowAmount,
  feeBpsFor,
  findAssociatedTokenAddress,
  findIntentPda,
  IntentStatus,
  Kind,
  NATIVE_MINT,
  nextFreeNonce,
  remainingOf,
  requiredOut,
  specMemo,
  splitFees,
  TOKEN_PROGRAM_ADDRESS,
} from "@intent-engine/core";
import { getCloseAccountInstruction } from "@solana-program/token";
import { chainTime, createdAccount, loadIntent, loadUser, mintCapOf, type NonceWindow } from "./accounts.js";
import { NoFreeNonce, NotFillable } from "./client-errors.js";
import {
  type ClientContext,
  type CreatedIntent,
  type CreateIntentInput,
  DEFAULT_EXPIRES_IN,
  EXPIRES_IN_RANGE,
  type FillInput,
  MAX_EXPIRES_IN,
  MIN_EXPIRES_IN,
  SPEC_URL_NEEDS_PROOF,
} from "./client-types.js";
import { memoInstruction, PLAIN_HTTP_ON_PUBLIC, plainHttpOnPublic } from "./jobs.js";
import { initUserIfMissing, tokenAccountIfMissing, wrapIfShort } from "./setup.js";

export function nonceAfter(owner: Address, user: NonceWindow | null): bigint {
  if (user === null) {
    return 0n;
  }
  const next = nextFreeNonce(user);
  if (next === null) {
    throw new NoFreeNonce(owner);
  }
  return next;
}

export function intentSends({ transport, send, mint, config }: ClientContext) {
  const createIntent = async (input: CreateIntentInput): Promise<CreatedIntent> => {
    const { signer, params, inputMint, outputMint } = input;
    const owner = signer.address;
    if (input.specUrl !== undefined && (params.kind !== Kind.AttestedResult || params.specHash.every((b) => b === 0))) {
      throw new RangeError(SPEC_URL_NEEDS_PROOF);
    }
    if (input.expiresIn !== undefined && (input.expiresIn < MIN_EXPIRES_IN || input.expiresIn > MAX_EXPIRES_IN)) {
      throw new RangeError(EXPIRES_IN_RANGE);
    }
    const published = input.specUrl === undefined ? [] : [memoInstruction(signer, specMemo(input.specUrl))];
    if (input.specUrl !== undefined && (await plainHttpOnPublic(transport, input.specUrl))) {
      throw new RangeError(`the spec url ${input.specUrl} ${PLAIN_HTTP_ON_PUBLIC}`);
    }
    const [settings, sell, buy, user, mintCap] = await Promise.all([
      config(),
      mint(inputMint),
      mint(outputMint),
      loadUser(transport, owner),
      mintCapOf(transport, inputMint),
    ]);
    const nonce = input.nonce ?? nonceAfter(owner, user);
    const expiresAt = input.expiresAt ?? (await chainTime(transport)) + (input.expiresIn ?? DEFAULT_EXPIRES_IN);
    const recipient = input.receiver ?? owner;
    const receiver = await tokenAccountIfMissing(transport, signer, recipient, outputMint, buy.tokenProgram);
    const wrap = await wrapIfShort(transport, signer, inputMint, sell.tokenProgram, escrowAmount(params));
    const create = await buildCreateIntent({
      owner: signer,
      treasury: settings.feeRecipient,
      maxCreateFee: settings.createFee,
      maxBounty: settings.crankBounty,
      nonce,
      params,
      expiresAt,
      inputMint,
      outputMint,
      inputTokenProgram: sell.tokenProgram,
      outputTokenProgram: buy.tokenProgram,
      ...(recipient === owner ? {} : { receiver: receiver.address, receiverAuthority: recipient }),
      ...(mintCap === undefined ? {} : { mintCap }),
    });
    const register = await initUserIfMissing(user, signer);
    const signature = await send([...register, ...receiver.create, ...wrap.instructions, create, ...published], signer);
    const [intent] = await findIntentPda({ owner, nonce });
    return { signature, intent, nonce };
  };

  const cancel = async (signer: TransactionSigner, nonce: bigint) => {
    const { intent } = await loadIntent(transport, signer.address, nonce);
    const { tokenProgram } = await mint(intent.inputMint);
    const refund = await tokenAccountIfMissing(transport, signer, signer.address, intent.inputMint, tokenProgram);
    return send([...refund.create, await buildCancelIntent({ owner: signer, nonce, inputMint: intent.inputMint, tokenProgram })], signer);
  };

  const unwrap = async (signer: TransactionSigner) => {
    const account = await findAssociatedTokenAddress({ owner: signer.address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    if ((await createdAccount(transport, account)) === null) {
      return null;
    }
    return send([getCloseAccountInstruction({ account, destination: signer.address, owner: signer })], signer);
  };

  const fill = async (input: FillInput) => {
    const { solver, owner, nonce } = input;
    const [{ address, intent: held }, settings] = await Promise.all([loadIntent(transport, owner, nonce), config()]);
    if (held.status !== IntentStatus.Open) {
      throw new NotFillable(address, "is not open");
    }
    const params = decodeParams(held.kind, Uint8Array.from(held.params));
    if (params.kind === Kind.AttestedResult) {
      throw new NotFillable(address, "is an AttestedResult intent, which only its judge settles");
    }
    const [sell, buy] = await Promise.all([mint(held.inputMint), mint(held.outputMint)]);
    const amountIn = input.amountIn ?? remainingOf(held);
    const amountOut = input.amountOut ?? requiredOut(params, amountIn, await chainTime(transport));
    const kindBps = feeBpsFor(settings, held.kind);
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
      owner,
      nonce,
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
    });
    const setup = [solverInput, solverOutput, ...payouts].flatMap(({ create }) => create);
    const wrap = input.route === undefined ? (await wrapIfShort(transport, solver, held.outputMint, buy.tokenProgram, amountOut)).instructions : [];
    return send([...setup, ...wrap, ...(input.route ?? []), filled], solver);
  };

  const settling = async (cranker: TransactionSigner, owner: Address, nonce: bigint) => {
    const { intent } = await loadIntent(transport, owner, nonce);
    const { tokenProgram } = await mint(intent.inputMint);
    return { ref: { cranker, owner, nonce, inputMint: intent.inputMint, tokenProgram }, rentPayer: intent.rentPayer };
  };

  const expire = async (cranker: TransactionSigner, owner: Address, nonce: bigint) => {
    const { ref } = await settling(cranker, owner, nonce);
    const refund = await tokenAccountIfMissing(transport, cranker, owner, ref.inputMint, ref.tokenProgram);
    return send([...refund.create, await buildExpireIntent(ref)], cranker);
  };

  const close = async (cranker: TransactionSigner, owner: Address, nonce: bigint) => {
    const { ref, rentPayer } = await settling(cranker, owner, nonce);
    return send([await buildCloseIntent({ ...ref, rentPayer })], cranker);
  };

  return { createIntent, cancel, unwrap, fill, expire, close };
}
