import type { Address, TransactionSigner } from "@solana/kit";
import {
  findDelegatePda,
  getCancelIntentInstructionAsync,
  getCloseIntentInstructionAsync,
  getCreateIntentInstructionAsync,
  getCreateIntentByAgentInstructionAsync,
  getCreateIntentSignedInstructionAsync,
  getExpireIntentInstructionAsync,
} from "../generated/client/index.js";
import { createArgs, events, INSTRUCTIONS_SYSVAR_ADDRESS, intentOf, settleExt } from "./builder-accounts.js";
import type { Partner } from "./ext.js";
import type { IntentParams } from "./kinds.js";
import { capAccount, mintCapSlot, withMintCap } from "./mint-caps.js";
import { findAssociatedTokenAddress, findMandatePda } from "./pdas.js";

export type CreateIntentSpec = {
  owner: TransactionSigner;
  treasury: Address;
  maxCreateFee: number;
  maxBounty: number;
  nonce: bigint;
  params: IntentParams;
  expiresAt: bigint;
  flags?: number;
  ext?: Uint8Array;
  partner?: Partner;
  inputMint: Address;
  outputMint: Address;
  inputTokenProgram: Address;
  outputTokenProgram: Address;
  ownerInput?: Address;
  receiver?: Address;
  receiverAuthority?: Address;
  mintCap?: Address;
  committee?: Address;
};

export async function buildCreateIntent(input: CreateIntentSpec) {
  const owner = input.owner.address;
  const args = createArgs(input);
  const ownerInput =
    input.ownerInput ??
    (await findAssociatedTokenAddress({
      owner,
      mint: input.inputMint,
      tokenProgram: input.inputTokenProgram,
    }));
  const receiver =
    input.receiver ??
    (await findAssociatedTokenAddress({
      owner,
      mint: input.outputMint,
      tokenProgram: input.outputTokenProgram,
    }));
  const create = await getCreateIntentInstructionAsync({
    owner: input.owner,
    intent: await intentOf(owner, input.nonce),
    inputMint: input.inputMint,
    outputMint: input.outputMint,
    ownerInput,
    receiver,
    receiverAuthority: input.receiverAuthority ?? owner,
    treasury: input.treasury,
    inputTokenProgram: input.inputTokenProgram,
    outputTokenProgram: input.outputTokenProgram,
    args,
    ...(input.committee === undefined ? {} : { committee: input.committee }),
    mintCap: mintCapSlot(input.mintCap),
    ...(await events()),
  });
  return withMintCap(create, input.mintCap);
}

type IntentRef = {
  owner: Address;
  nonce: bigint;
  inputMint: Address;
  tokenProgram: Address;
  capped?: bigint;
};

async function canonicalRefund(ref: IntentRef): Promise<Address> {
  return findAssociatedTokenAddress({
    owner: ref.owner,
    mint: ref.inputMint,
    tokenProgram: ref.tokenProgram,
  });
}

export async function buildCancelIntent(
  input: Omit<IntentRef, "owner"> & { owner: TransactionSigner; refundTo?: Address; ext?: Uint8Array; claims?: { board: Address; stakeTo: Address | null } },
) {
  const ref = { ...input, owner: input.owner.address };
  const ext = settleExt(input.ext);
  return getCancelIntentInstructionAsync({
    owner: input.owner,
    intent: await intentOf(ref.owner, input.nonce),
    inputMint: input.inputMint,
    refundTo: input.refundTo ?? (await canonicalRefund(ref)),
    tokenProgram: input.tokenProgram,
    ...(input.claims === undefined ? {} : { claims: input.claims.board, ...(input.claims.stakeTo === null ? {} : { stakeTo: input.claims.stakeTo }) }),
    ...(await capAccount(input.inputMint, input.capped)),
    ext,
    ...(await events()),
  });
}

export async function buildExpireIntent(
  input: IntentRef & { cranker: TransactionSigner; refundTo?: Address; ext?: Uint8Array },
) {
  const ext = settleExt(input.ext);
  return getExpireIntentInstructionAsync({
    cranker: input.cranker,
    intent: await intentOf(input.owner, input.nonce),
    inputMint: input.inputMint,
    refundTo: input.refundTo ?? (await canonicalRefund(input)),
    canonicalRefund: await canonicalRefund(input),
    tokenProgram: input.tokenProgram,
    ...(await capAccount(input.inputMint, input.capped)),
    ext,
    ...(await events()),
  });
}

export async function buildCloseIntent(
  input: IntentRef & {
    cranker: TransactionSigner;
    rentPayer?: Address;
    intent?: { rentPayer: Address };
    refundTo?: Address;
    ext?: Uint8Array;
  },
) {
  const ext = settleExt(input.ext);
  return getCloseIntentInstructionAsync({
    cranker: input.cranker,
    intent: await intentOf(input.owner, input.nonce),
    inputMint: input.inputMint,
    refundTo: input.refundTo ?? (await canonicalRefund(input)),
    canonicalRefund: await canonicalRefund(input),
    owner: input.owner,
    rentPayer: input.rentPayer ?? input.intent?.rentPayer ?? input.owner,
    tokenProgram: input.tokenProgram,
    ...(await capAccount(input.inputMint, input.capped)),
    ext,
    ...(await events()),
  });
}

export type CreateIntentSignedSpec = Omit<CreateIntentSpec, "owner"> & {
  payer: TransactionSigner;
  owner: Address;
  submitBy: bigint;
  relayerFee?: bigint;
  relayerFeeAccount?: Address;
};

async function feeAccount<K extends string>(
  name: K,
  fee: bigint,
  account: Address | undefined,
  owner: Address,
  input: { inputMint: Address; inputTokenProgram: Address },
): Promise<Partial<Record<K, Address>>> {
  if (fee === 0n) {
    return {};
  }
  const address =
    account ?? (await findAssociatedTokenAddress({ owner, mint: input.inputMint, tokenProgram: input.inputTokenProgram }));
  return { [name]: address } as Record<K, Address>;
}

export async function buildCreateIntentSigned(input: CreateIntentSignedSpec) {
  const owner = input.owner;
  const relayerFee = input.relayerFee ?? 0n;
  const args = createArgs(input);
  const ownerInput =
    input.ownerInput ??
    (await findAssociatedTokenAddress({
      owner,
      mint: input.inputMint,
      tokenProgram: input.inputTokenProgram,
    }));
  const receiver =
    input.receiver ??
    (await findAssociatedTokenAddress({
      owner,
      mint: input.outputMint,
      tokenProgram: input.outputTokenProgram,
    }));
  const create = await getCreateIntentSignedInstructionAsync({
    payer: input.payer,
    owner,
    intent: await intentOf(owner, input.nonce),
    inputMint: input.inputMint,
    outputMint: input.outputMint,
    ownerInput,
    receiver,
    receiverAuthority: input.receiverAuthority ?? owner,
    delegate: (await findDelegatePda({ owner }))[0],
    treasury: input.treasury,
    inputTokenProgram: input.inputTokenProgram,
    outputTokenProgram: input.outputTokenProgram,
    instructions: INSTRUCTIONS_SYSVAR_ADDRESS,
    ...(await feeAccount("relayerFeeTo", relayerFee, input.relayerFeeAccount, input.payer.address, input)),
    args,
    submitBy: input.submitBy,
    relayerFee,
    ...(input.committee === undefined ? {} : { committee: input.committee }),
    mintCap: mintCapSlot(input.mintCap),
    ...(await events()),
  });
  return withMintCap(create, input.mintCap);
}

export type CreateIntentByAgentSpec = Omit<CreateIntentSpec, "owner" | "treasury" | "receiverAuthority" | "committee"> & {
  agent: TransactionSigner;
  owner: Address;
  mandateId: bigint;
  treasury: Address;
};

export async function buildCreateIntentByAgent(input: CreateIntentByAgentSpec) {
  const owner = input.owner;
  const args = createArgs(input);
  const ownerInput =
    input.ownerInput ??
    (await findAssociatedTokenAddress({ owner, mint: input.inputMint, tokenProgram: input.inputTokenProgram }));
  const receiver =
    input.receiver ??
    (await findAssociatedTokenAddress({ owner, mint: input.outputMint, tokenProgram: input.outputTokenProgram }));
  const [mandate] = await findMandatePda({ owner, agent: input.agent.address, id: input.mandateId });
  const create = await getCreateIntentByAgentInstructionAsync({
    agent: input.agent,
    owner,
    mandate,
    intent: await intentOf(owner, input.nonce),
    inputMint: input.inputMint,
    outputMint: input.outputMint,
    ownerInput,
    receiver,
    receiverAuthority: owner,
    delegate: (await findDelegatePda({ owner }))[0],
    treasury: input.treasury,
    inputTokenProgram: input.inputTokenProgram,
    outputTokenProgram: input.outputTokenProgram,
    args,
    mintCap: mintCapSlot(input.mintCap),
    ...(await events()),
  });
  return withMintCap(create, input.mintCap);
}
