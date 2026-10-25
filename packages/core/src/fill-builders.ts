import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import {
  getBeginFillInstructionAsync,
  getClaimHeldInstructionAsync,
  getEndFillInstruction,
  getFillAttestedCommitteeInstructionAsync,
  getFillAttestedInstructionAsync,
  getFillAttestedSplitCommitteeInstructionAsync,
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
import { sized } from "./bytes.js";
import { SALT_LEN } from "./delivery.js";
import { capAccount } from "./mint-caps.js";
import { findAssociatedTokenAddress } from "./pdas.js";
import { InvalidInput } from "./errors.js";

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
  capped?: bigint;
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
    ...(await capAccount(input.inputMint, input.capped)),
    amountIn: input.amountIn,
    amountOut: input.amountOut,
    maxFeeBps: input.maxFeeBps,
    ext: fillExt(input.ext),
    ...(await events()),
  });
}

export type DeliveryOpening = { delivered: Uint8Array; salt: Uint8Array };

export type AnnouncedDelivery = { announcement: Address; opening: DeliveryOpening };

export type UnannouncedRelease = { announcement?: never; opening?: never };

export type ReleaseDelivery = AnnouncedDelivery | UnannouncedRelease;

type AttestedTerms = {
  solver: TransactionSigner;
  owner: Address;
  nonce: bigint;
  inputMint: Address;
  inputTokenProgram: Address;
  feeRecipient?: Address;
  partner?: Address;
  judge?: Address;
  claims?: Address;
  stakeTo?: Address;
  amountIn: bigint;
  result: bigint;
  maxFeeBps: number;
  ext?: Uint8Array;
  capped?: bigint;
};

export type FillAttestedSpec = AttestedTerms & { payee: Address } & ReleaseDelivery;

const UNOPENED = { delivered: new Uint8Array(32), salt: new Uint8Array(SALT_LEN) };

function deliveryAccounts(input: { announcement?: Address | undefined; opening?: DeliveryOpening | undefined }) {
  if (input.announcement === undefined && input.opening === undefined) {
    return { opening: UNOPENED };
  }
  if (input.announcement === undefined || input.opening === undefined) {
    throw new InvalidInput("announcement", "conflict", "a release names its announcement together with the opening, or neither");
  }
  return {
    announcement: input.announcement,
    opening: {
      delivered: sized("opening.delivered", input.opening.delivered, 32),
      salt: sized("opening.salt", input.opening.salt, SALT_LEN),
    },
  };
}

async function ataOf(owner: Address | undefined, input: AttestedTerms) {
  return owner === undefined
    ? undefined
    : findAssociatedTokenAddress({ owner, mint: input.inputMint, tokenProgram: input.inputTokenProgram });
}

async function attestedAccounts(input: AttestedTerms & ReleaseDelivery) {
  const feeTo = await ataOf(input.feeRecipient, input);
  const judgeTo = await ataOf(input.judge, input);
  return {
    solver: input.solver,
    intent: await intentOf(input.owner, input.nonce),
    inputMint: input.inputMint,
    ...(feeTo === undefined ? {} : { feeTo }),
    ...(await partnerAccount(input)),
    ...(judgeTo === undefined ? {} : { judgeTo }),
    inputTokenProgram: input.inputTokenProgram,
    instructions: INSTRUCTIONS_SYSVAR_ADDRESS,
    ...(input.claims === undefined ? {} : { claims: input.claims }),
    ...(input.stakeTo === undefined ? {} : { stakeTo: input.stakeTo }),
    ...(await capAccount(input.inputMint, input.capped)),
    ...deliveryAccounts(input),
    fill: { amountIn: input.amountIn, result: input.result, maxFeeBps: input.maxFeeBps },
    ext: fillExt(input.ext),
    ...(await events()),
  };
}

export async function buildFillAttested(input: FillAttestedSpec) {
  return getFillAttestedInstructionAsync({ ...(await attestedAccounts(input)), payee: input.payee });
}

export type CommitteeRelease = {
  committee: Address;
  signers: number;
};

export type FillAttestedCommitteeSpec = FillAttestedSpec & CommitteeRelease;

export async function buildFillAttestedCommittee(input: FillAttestedCommitteeSpec) {
  return getFillAttestedCommitteeInstructionAsync({
    ...(await attestedAccounts(input)),
    payee: input.payee,
    committee: input.committee,
    signers: input.signers,
  });
}

export type FillAttestedSplitSpec = AttestedTerms &
  AnnouncedDelivery & {
    recipients: Address[];
    weights: number[];
  };

async function splitAccounts(input: FillAttestedSplitSpec) {
  if (input.recipients.length < 1 || input.recipients.length > MAX_SPLIT_RECIPIENTS) {
    throw new InvalidInput("recipients", "range", `split needs 1..=${MAX_SPLIT_RECIPIENTS} recipients, got ${input.recipients.length}`);
  }
  if (input.weights.length !== input.recipients.length) {
    throw new InvalidInput("weights", "length", `split needs one weight per recipient, got ${input.weights.length} for ${input.recipients.length}`);
  }
  const slots = await Promise.all(input.recipients.map((owner) => ataOf(owner, input)));
  return {
    ...(await attestedAccounts(input)),
    ...(slots[0] === undefined ? {} : { recipient0: slots[0] }),
    ...(slots[1] === undefined ? {} : { recipient1: slots[1] }),
    ...(slots[2] === undefined ? {} : { recipient2: slots[2] }),
    ...(slots[3] === undefined ? {} : { recipient3: slots[3] }),
    ...(slots[4] === undefined ? {} : { recipient4: slots[4] }),
    ...(slots[5] === undefined ? {} : { recipient5: slots[5] }),
    ...(slots[6] === undefined ? {} : { recipient6: slots[6] }),
    ...(slots[7] === undefined ? {} : { recipient7: slots[7] }),
    announcement: input.announcement,
    claim: { recipients: input.recipients, weights: input.weights },
  };
}

export async function buildFillAttestedSplit(input: FillAttestedSplitSpec) {
  return getFillAttestedSplitInstructionAsync(await splitAccounts(input));
}

export type FillAttestedSplitCommitteeSpec = FillAttestedSplitSpec & CommitteeRelease;

export async function buildFillAttestedSplitCommittee(input: FillAttestedSplitCommitteeSpec) {
  return getFillAttestedSplitCommitteeInstructionAsync({
    ...(await splitAccounts(input)),
    committee: input.committee,
    signers: input.signers,
  });
}

export type ClaimHeldSpec = {
  wallet: TransactionSigner;
  intent: Address;
  announcement: Address;
  to: Address;
  inputMint: Address;
  inputTokenProgram: Address;
  index: number;
  recipients: Address[];
  weights: number[];
  capped?: bigint;
};

export async function buildClaimHeld(input: ClaimHeldSpec) {
  if (input.recipients.length < 1 || input.recipients.length > MAX_SPLIT_RECIPIENTS) {
    throw new InvalidInput("recipients", "range", `split needs 1..=${MAX_SPLIT_RECIPIENTS} recipients, got ${input.recipients.length}`);
  }
  if (input.weights.length !== input.recipients.length) {
    throw new InvalidInput("weights", "length", `split needs one weight per recipient, got ${input.weights.length} for ${input.recipients.length}`);
  }
  if (!Number.isInteger(input.index) || input.index < 0 || input.index >= input.recipients.length) {
    throw new InvalidInput("index", "range", `index must name one of the ${input.recipients.length} recipients, got ${input.index}`);
  }
  if (input.recipients[input.index] !== input.wallet.address) {
    throw new InvalidInput("wallet", "conflict", `recipient ${input.index} is ${input.recipients[input.index]}, not the signing wallet ${input.wallet.address}`);
  }
  return getClaimHeldInstructionAsync({
    wallet: input.wallet,
    intent: input.intent,
    inputMint: input.inputMint,
    announcement: input.announcement,
    to: input.to,
    inputTokenProgram: input.inputTokenProgram,
    ...(await capAccount(input.inputMint, input.capped)),
    index: input.index,
    claim: { recipients: input.recipients, weights: input.weights },
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
    throw new InvalidInput("baseIndex", "range", `baseIndex must be a non-negative integer, got ${baseIndex}`);
  }
  const prefix = input.prefix ?? [];
  const route = input.route ?? [];
  const endIndex = baseIndex + prefix.length + 1 + route.length;
  if (endIndex > 0xffff) {
    throw new InvalidInput("endIndex", "range", `a flash fill cannot end at instruction ${endIndex}`);
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
    ...(await capAccount(input.inputMint, input.capped)),
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
