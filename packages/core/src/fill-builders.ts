import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import {
  getBeginFillInstructionAsync,
  getEndFillInstruction,
  getFillAttestedInstructionAsync,
  getFillAttestedSplitInstructionAsync,
  getFillIntentInstructionAsync,
} from "../generated/client/index.js";
import {
  agentAccount,
  events,
  fillExt,
  INSTRUCTIONS_SYSVAR_ADDRESS,
  intentOf,
  mandateAccounts,
  partnerAccount,
} from "./builder-accounts.js";
import { MAX_SPLIT_RECIPIENTS } from "./bounty.js";
import { findAssociatedTokenAddress } from "./pdas.js";

export type FillIntentSpec = {
  solver: TransactionSigner;
  owner: Address;
  nonce: bigint;
  inputMint: Address;
  outputMint: Address;
  inputTokenProgram: Address;
  outputTokenProgram: Address;
  receiver: Address;
  solverOutput: Address;
  solverInput: Address;
  feeRecipient?: Address;
  partner?: Address;
  mandate?: Address;
  agent?: Address;
  amountIn: bigint;
  amountOut: bigint;
  maxFeeBps: number;
  ext?: Uint8Array;
};

export async function buildFillIntent(input: FillIntentSpec) {
  const feeTo =
    input.feeRecipient === undefined
      ? undefined
      : await findAssociatedTokenAddress({
          owner: input.feeRecipient,
          mint: input.inputMint,
          tokenProgram: input.inputTokenProgram,
        });
  return getFillIntentInstructionAsync({
    solver: input.solver,
    intent: await intentOf(input.owner, input.nonce),
    inputMint: input.inputMint,
    outputMint: input.outputMint,
    receiver: input.receiver,
    solverOutput: input.solverOutput,
    solverInput: input.solverInput,
    ...(feeTo === undefined ? {} : { feeTo }),
    ...(await partnerAccount(input)),
    inputTokenProgram: input.inputTokenProgram,
    outputTokenProgram: input.outputTokenProgram,
    ...(await mandateAccounts(input)),
    ...(await agentAccount(input)),
    amountIn: input.amountIn,
    amountOut: input.amountOut,
    maxFeeBps: input.maxFeeBps,
    ext: fillExt(input.ext),
    ...(await events()),
  });
}

export type FillAttestedSpec = {
  solver: TransactionSigner;
  owner: Address;
  nonce: bigint;
  inputMint: Address;
  inputTokenProgram: Address;
  payee: Address;
  feeRecipient?: Address;
  partner?: Address;
  judge?: Address;
  amountIn: bigint;
  result: bigint;
  maxFeeBps: number;
  ext?: Uint8Array;
};

export async function buildFillAttested(input: FillAttestedSpec) {
  const feeTo =
    input.feeRecipient === undefined
      ? undefined
      : await findAssociatedTokenAddress({
          owner: input.feeRecipient,
          mint: input.inputMint,
          tokenProgram: input.inputTokenProgram,
        });
  const judgeTo =
    input.judge === undefined
      ? undefined
      : await findAssociatedTokenAddress({
          owner: input.judge,
          mint: input.inputMint,
          tokenProgram: input.inputTokenProgram,
        });
  return getFillAttestedInstructionAsync({
    solver: input.solver,
    intent: await intentOf(input.owner, input.nonce),
    inputMint: input.inputMint,
    payee: input.payee,
    ...(feeTo === undefined ? {} : { feeTo }),
    ...(await partnerAccount(input)),
    ...(judgeTo === undefined ? {} : { judgeTo }),
    inputTokenProgram: input.inputTokenProgram,
    instructions: INSTRUCTIONS_SYSVAR_ADDRESS,
    amountIn: input.amountIn,
    result: input.result,
    maxFeeBps: input.maxFeeBps,
    ext: fillExt(input.ext),
    ...(await events()),
  });
}

export type FillAttestedSplitSpec = Omit<FillAttestedSpec, "payee"> & {
  recipients: Address[];
  weights: number[];
};

export async function buildFillAttestedSplit(input: FillAttestedSplitSpec) {
  if (input.recipients.length < 1 || input.recipients.length > MAX_SPLIT_RECIPIENTS) {
    throw new Error(`split needs 1..=${MAX_SPLIT_RECIPIENTS} recipients, got ${input.recipients.length}`);
  }
  if (input.weights.length !== input.recipients.length) {
    throw new Error(`split needs one weight per recipient, got ${input.weights.length} for ${input.recipients.length}`);
  }
  const feeTo =
    input.feeRecipient === undefined
      ? undefined
      : await findAssociatedTokenAddress({
          owner: input.feeRecipient,
          mint: input.inputMint,
          tokenProgram: input.inputTokenProgram,
        });
  const judgeTo =
    input.judge === undefined
      ? undefined
      : await findAssociatedTokenAddress({
          owner: input.judge,
          mint: input.inputMint,
          tokenProgram: input.inputTokenProgram,
        });
  const slots = await Promise.all(
    input.recipients.map((owner) =>
      findAssociatedTokenAddress({
        owner,
        mint: input.inputMint,
        tokenProgram: input.inputTokenProgram,
      }),
    ),
  );
  return getFillAttestedSplitInstructionAsync({
    solver: input.solver,
    intent: await intentOf(input.owner, input.nonce),
    inputMint: input.inputMint,
    ...(feeTo === undefined ? {} : { feeTo }),
    ...(await partnerAccount(input)),
    ...(judgeTo === undefined ? {} : { judgeTo }),
    ...(slots[0] === undefined ? {} : { recipient0: slots[0] }),
    ...(slots[1] === undefined ? {} : { recipient1: slots[1] }),
    ...(slots[2] === undefined ? {} : { recipient2: slots[2] }),
    ...(slots[3] === undefined ? {} : { recipient3: slots[3] }),
    ...(slots[4] === undefined ? {} : { recipient4: slots[4] }),
    ...(slots[5] === undefined ? {} : { recipient5: slots[5] }),
    ...(slots[6] === undefined ? {} : { recipient6: slots[6] }),
    ...(slots[7] === undefined ? {} : { recipient7: slots[7] }),
    inputTokenProgram: input.inputTokenProgram,
    instructions: INSTRUCTIONS_SYSVAR_ADDRESS,
    amountIn: input.amountIn,
    result: input.result,
    maxFeeBps: input.maxFeeBps,
    recipients: input.recipients,
    weights: input.weights,
    ext: fillExt(input.ext),
    ...(await events()),
  });
}

export type FlashFillSpec = Omit<FillIntentSpec, "ext"> & {
  beginExt?: Uint8Array;
  endExt?: Uint8Array;
  baseIndex?: number;
  prefix?: Instruction[];
  route?: Instruction[];
};

export async function buildFlashFill(input: FlashFillSpec): Promise<Instruction[]> {
  const baseIndex = input.baseIndex ?? 0;
  if (!Number.isInteger(baseIndex) || baseIndex < 0) {
    throw new RangeError(`baseIndex must be a non-negative integer, got ${baseIndex}`);
  }
  const prefix = input.prefix ?? [];
  const route = input.route ?? [];
  const endIndex = baseIndex + prefix.length + 1 + route.length;
  if (endIndex > 0xffff) {
    throw new RangeError(`a flash fill cannot end at instruction ${endIndex}`);
  }
  const intent = await intentOf(input.owner, input.nonce);
  const feeTo =
    input.feeRecipient === undefined
      ? undefined
      : await findAssociatedTokenAddress({
          owner: input.feeRecipient,
          mint: input.inputMint,
          tokenProgram: input.inputTokenProgram,
        });
  const begin = await getBeginFillInstructionAsync({
    solver: input.solver,
    intent,
    inputMint: input.inputMint,
    solverInput: input.solverInput,
    ...(feeTo === undefined ? {} : { feeTo }),
    ...(await partnerAccount(input)),
    inputTokenProgram: input.inputTokenProgram,
    instructions: INSTRUCTIONS_SYSVAR_ADDRESS,
    ...(await mandateAccounts(input)),
    ...(await agentAccount(input)),
    amountIn: input.amountIn,
    endIndex,
    maxFeeBps: input.maxFeeBps,
    ext: fillExt(input.beginExt),
    ...(await events()),
  });
  const end = getEndFillInstruction({
    intent,
    solver: input.solver,
    outputMint: input.outputMint,
    receiver: input.receiver,
    solverOutput: input.solverOutput,
    outputTokenProgram: input.outputTokenProgram,
    amountOut: input.amountOut,
    ext: fillExt(input.endExt),
    ...(await events()),
  });
  return [...prefix, begin, ...route, end];
}
