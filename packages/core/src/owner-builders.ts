import type { Address, TransactionSigner } from "@solana/kit";
import { getApproveCheckedInstruction } from "@solana-program/token";
import {
  findDelegatePda,
  getAdvanceEpochInstructionAsync,
  getAdvanceNonceInstructionAsync,
  getCreateMandateInstructionAsync,
  getInitUserInstructionAsync,
  getRevokeMandateInstruction,
} from "../generated/client/index.js";
import { events } from "./builder-accounts.js";
import { escrowAmount, type IntentParams, validate } from "./kinds.js";
import { checkU64, U64_MAX } from "./math.js";
import { MANDATE_NONCE_BIT, type MandateSpec, mandateArgs } from "./mandate.js";
import { findAssociatedTokenAddress, findMandatePda } from "./pdas.js";

export async function buildInitUser(input: { owner: TransactionSigner }) {
  return getInitUserInstructionAsync({ owner: input.owner, ...(await events()) });
}

export async function buildAdvanceNonce(input: { owner: TransactionSigner; nonceBase: bigint }) {
  return getAdvanceNonceInstructionAsync({
    owner: input.owner,
    nonceBase: input.nonceBase,
    ...(await events()),
  });
}

export const EPOCH_JUMP_BITS = 48n;
export const MAX_EPOCH_JUMP = 1n << EPOCH_JUMP_BITS;
export const MAX_NONCE_JUMP = 1n << 32n;
export const NONCE_CEILING = MANDATE_NONCE_BIT - 256n;

export function nextEpoch(current: bigint, entropy: Uint8Array = crypto.getRandomValues(new Uint8Array(6))): bigint {
  if (current < 0n || current >= U64_MAX) {
    throw new RangeError(`no epoch follows ${current}`);
  }
  if (entropy.length !== Number(EPOCH_JUMP_BITS / 8n)) {
    throw new RangeError(`epoch entropy must be ${EPOCH_JUMP_BITS / 8n} bytes`);
  }
  const drawn = entropy.reduce((acc, b) => (acc << 8n) | BigInt(b), 0n);
  return current + (drawn % (U64_MAX - current)) + 1n;
}

export async function buildAdvanceEpoch(input: { owner: TransactionSigner; epoch: bigint }) {
  return getAdvanceEpochInstructionAsync({ owner: input.owner, epoch: input.epoch, ...(await events()) });
}

export async function buildApproveDelegate(input: {
  owner: TransactionSigner;
  mint: Address;
  tokenProgram: Address;
  amount: bigint;
  decimals: number;
  source?: Address;
}) {
  const source =
    input.source ??
    (await findAssociatedTokenAddress({
      owner: input.owner.address,
      mint: input.mint,
      tokenProgram: input.tokenProgram,
    }));
  return getApproveCheckedInstruction(
    {
      source,
      mint: input.mint,
      delegate: (await findDelegatePda({ owner: input.owner.address }))[0],
      owner: input.owner,
      amount: input.amount,
      decimals: input.decimals,
    },
    { programAddress: input.tokenProgram },
  );
}

export async function buildApproveForIntent(input: {
  owner: TransactionSigner;
  mint: Address;
  tokenProgram: Address;
  decimals: number;
  params: IntentParams;
  relayerFee?: bigint;
  alreadyApproved?: bigint;
  source?: Address;
}) {
  const escrow = escrowAmount(validate(input.params));
  const relayerFee = checkU64(input.relayerFee ?? 0n, "relayer fee");
  const alreadyApproved = checkU64(input.alreadyApproved ?? 0n, "existing allowance");
  const amount = escrow + relayerFee + alreadyApproved;
  if (amount > U64_MAX) {
    throw new RangeError(`an allowance of ${amount} does not fit a token account`);
  }
  return buildApproveDelegate({ ...input, amount });
}

export async function buildCreateMandate(input: {
  owner: TransactionSigner;
  inputMint: Address;
  outputMint: Address;
  inputTokenProgram: Address;
  outputTokenProgram: Address;
  mandate: MandateSpec;
  ownerInput?: Address;
  receiver?: Address;
}) {
  const owner = input.owner.address;
  const [mandate] = await findMandatePda({ owner, agent: input.mandate.agent, id: input.mandate.id });
  return getCreateMandateInstructionAsync({
    owner: input.owner,
    mandate,
    inputMint: input.inputMint,
    outputMint: input.outputMint,
    ownerInput:
      input.ownerInput ??
      (await findAssociatedTokenAddress({ owner, mint: input.inputMint, tokenProgram: input.inputTokenProgram })),
    receiver:
      input.receiver ??
      (await findAssociatedTokenAddress({ owner, mint: input.outputMint, tokenProgram: input.outputTokenProgram })),
    inputTokenProgram: input.inputTokenProgram,
    outputTokenProgram: input.outputTokenProgram,
    ...mandateArgs(input.mandate),
    ...(await events()),
  });
}

export async function buildRevokeMandate(input: { owner: TransactionSigner; agent: Address; id: bigint }) {
  const [mandate] = await findMandatePda({ owner: input.owner.address, agent: input.agent, id: input.id });
  return getRevokeMandateInstruction({ owner: input.owner, mandate, ...(await events()) });
}
