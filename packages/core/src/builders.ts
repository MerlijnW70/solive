import {
  type Address,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Instruction,
  type TransactionSigner,
} from "@solana/kit";
import { getApproveCheckedInstruction } from "@solana-program/token";
import {
  findDelegatePda,
  findUserStatePda,
  getAdvanceEpochInstructionAsync,
  getAdvanceNonceInstructionAsync,
  getBeginFillInstructionAsync,
  getEndFillInstruction,
  getCancelIntentInstructionAsync,
  getCloseIntentInstructionAsync,
  getCreateIntentInstructionAsync,
  getCreateIntentByAgentInstructionAsync,
  getCreateIntentSignedInstructionAsync,
  getCreateMandateInstructionAsync,
  getExpireIntentInstructionAsync,
  getFillAttestedInstructionAsync,
  getFillIntentInstructionAsync,
  getInitConfigInstructionAsync,
  getInitUserInstructionAsync,
  getLowerPauseInstruction,
  getProposeAdminInstruction,
  getAcceptAdminInstruction,
  getUpdateConfigInstruction,
  getRaisePauseInstruction,
  getRevokeMandateInstruction,
  getUpdateEconomicsInstruction,
  INTENT_ENGINE_PROGRAM_ADDRESS,
} from "../generated/client/index.js";
import {
  checkFlags,
  encodePartner,
  FILL_EXT_TAGS,
  type Partner,
  partnerOf,
  SETTLE_EXT_TAGS,
  validateExt,
} from "./ext.js";
import { encodeParams, escrowAmount, type IntentParams, validate } from "./kinds.js";
import { U64_MAX } from "./math.js";
import { MANDATE_NONCE_BIT, type MandateSpec, mandateArgs, NO_MANDATE } from "./mandate.js";
import { findAssociatedTokenAddress, findEventAuthorityPda, findIntentPda, findMandatePda } from "./pdas.js";

export const INSTRUCTIONS_SYSVAR_ADDRESS =
  "Sysvar1nstructions1111111111111111111111111" as Address<"Sysvar1nstructions1111111111111111111111111">;

async function events() {
  const [eventAuthority] = await findEventAuthorityPda();
  return { eventAuthority, program: INTENT_ENGINE_PROGRAM_ADDRESS };
}

const fillExt = (ext?: Uint8Array) => validateExt(ext ?? new Uint8Array(), FILL_EXT_TAGS);
const settleExt = (ext?: Uint8Array) => validateExt(ext ?? new Uint8Array(), SETTLE_EXT_TAGS);

export function createExt(input: { ext?: Uint8Array; partner?: Partner }): Uint8Array {
  if (input.ext !== undefined && input.partner !== undefined) {
    throw new RangeError("pass either raw extension bytes or a partner, not both");
  }
  const ext = input.ext ?? (input.partner === undefined ? new Uint8Array() : encodePartner(input.partner));
  partnerOf(ext);
  return ext;
}

function createArgs(input: {
  nonce: bigint;
  params: IntentParams;
  expiresAt: bigint;
  flags?: number;
  ext?: Uint8Array;
  partner?: Partner;
  maxCreateFee: number;
  maxBounty: number;
}) {
  const params = validate(input.params);
  return {
    nonce: input.nonce,
    kind: params.kind,
    flags: checkFlags(input.flags ?? 0),
    params: encodeParams(params),
    expiresAt: input.expiresAt,
    ext: createExt(input),
    maxCreateFee: input.maxCreateFee,
    maxBounty: input.maxBounty,
  };
}

async function partnerAccount(input: { partner?: Address; inputMint: Address; inputTokenProgram: Address }) {
  return input.partner === undefined
    ? {}
    : {
        partnerTo: await findAssociatedTokenAddress({
          owner: input.partner,
          mint: input.inputMint,
          tokenProgram: input.inputTokenProgram,
        }),
      };
}

async function mandateAccounts(input: { mandate?: Address; owner: Address }) {
  return input.mandate === undefined || input.mandate === NO_MANDATE
    ? {}
    : { mandate: input.mandate, ownerState: (await findUserStatePda({ owner: input.owner }))[0] };
}

async function agentAccount(input: { agent?: Address; inputMint: Address; inputTokenProgram: Address }) {
  return input.agent === undefined
    ? {}
    : {
        agentTo: await findAssociatedTokenAddress({
          owner: input.agent,
          mint: input.inputMint,
          tokenProgram: input.inputTokenProgram,
        }),
      };
}

async function intentOf(owner: Address, nonce: bigint): Promise<Address> {
  return (await findIntentPda({ owner, nonce }))[0];
}

export const UPGRADEABLE_LOADER_ADDRESS =
  "BPFLoaderUpgradeab1e11111111111111111111111" as Address<"BPFLoaderUpgradeab1e11111111111111111111111">;

export async function findProgramDataAddress(program: Address = INTENT_ENGINE_PROGRAM_ADDRESS): Promise<Address> {
  const [address] = await getProgramDerivedAddress({
    programAddress: UPGRADEABLE_LOADER_ADDRESS,
    seeds: [getAddressEncoder().encode(program)],
  });
  return address;
}

export async function buildInitConfig(input: {
  authority: TransactionSigner;
  domain: Uint8Array;
  guardian: Address;
  feeRecipient: Address;
  enabledKinds: bigint;
  feeBps: number;
  paused: number;
}) {
  return getInitConfigInstructionAsync({
    authority: input.authority,
    programData: await findProgramDataAddress(),
    domain: input.domain,
    guardian: input.guardian,
    feeRecipient: input.feeRecipient,
    enabledKinds: input.enabledKinds,
    feeBps: input.feeBps,
    paused: input.paused,
    ...(await events()),
  });
}

export async function buildRaisePause(input: { authority: TransactionSigner; flags: number }) {
  return getRaisePauseInstruction({ authority: input.authority, flags: input.flags, ...(await events()) });
}

export async function buildLowerPause(input: { admin: TransactionSigner; flags: number }) {
  return getLowerPauseInstruction({ admin: input.admin, flags: input.flags, ...(await events()) });
}

export type ConfigUpdateSpec = {
  guardian: Address;
  feeRecipient: Address;
  enabledKinds: bigint;
  feeBps: number;
  fillDisabledKinds: bigint;
};

export async function buildUpdateConfig(input: { admin: TransactionSigner; update: ConfigUpdateSpec }) {
  return getUpdateConfigInstruction({ admin: input.admin, ...input.update, ...(await events()) });
}

export async function buildProposeAdmin(input: { admin: TransactionSigner; pendingAdmin: Address }) {
  return getProposeAdminInstruction({ admin: input.admin, pendingAdmin: input.pendingAdmin, ...(await events()) });
}

export async function buildAcceptAdmin(input: { pendingAdmin: TransactionSigner }) {
  return getAcceptAdminInstruction({ pendingAdmin: input.pendingAdmin, ...(await events()) });
}

export type EconomicsSpec = {
  kindFeeMask: number;
  kindFeeBps: readonly [number, number, number, number];
  partnerCutBps: number;
  crankBounty: number;
  createFee: number;
};

export async function buildUpdateEconomics(input: { admin: TransactionSigner; economics: EconomicsSpec }) {
  const e = input.economics;
  return getUpdateEconomicsInstruction({
    admin: input.admin,
    kindFeeMask: e.kindFeeMask,
    kindFeeBps: [...e.kindFeeBps],
    partnerCutBps: e.partnerCutBps,
    crankBounty: e.crankBounty,
    createFee: e.createFee,
    ...(await events()),
  });
}

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
  return getCreateIntentInstructionAsync({
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
    ...(await events()),
  });
}

type IntentRef = {
  owner: Address;
  nonce: bigint;
  inputMint: Address;
  tokenProgram: Address;
};

async function canonicalRefund(ref: IntentRef): Promise<Address> {
  return findAssociatedTokenAddress({
    owner: ref.owner,
    mint: ref.inputMint,
    tokenProgram: ref.tokenProgram,
  });
}

export async function buildCancelIntent(
  input: Omit<IntentRef, "owner"> & { owner: TransactionSigner; refundTo?: Address; ext?: Uint8Array },
) {
  const ref = { ...input, owner: input.owner.address };
  const ext = settleExt(input.ext);
  return getCancelIntentInstructionAsync({
    owner: input.owner,
    intent: await intentOf(ref.owner, input.nonce),
    inputMint: input.inputMint,
    refundTo: input.refundTo ?? (await canonicalRefund(ref)),
    tokenProgram: input.tokenProgram,
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
    ext,
    ...(await events()),
  });
}

export async function buildCloseIntent(
  input: IntentRef & { cranker: TransactionSigner; rentPayer?: Address; refundTo?: Address; ext?: Uint8Array },
) {
  const ext = settleExt(input.ext);
  return getCloseIntentInstructionAsync({
    cranker: input.cranker,
    intent: await intentOf(input.owner, input.nonce),
    inputMint: input.inputMint,
    refundTo: input.refundTo ?? (await canonicalRefund(input)),
    canonicalRefund: await canonicalRefund(input),
    owner: input.owner,
    rentPayer: input.rentPayer ?? input.owner,
    tokenProgram: input.tokenProgram,
    ext,
    ...(await events()),
  });
}

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
  return getCreateIntentSignedInstructionAsync({
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
    ...(await events()),
  });
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
  source?: Address;
}) {
  return buildApproveDelegate({ ...input, amount: escrowAmount(validate(input.params)) });
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

export type CreateIntentByAgentSpec = Omit<CreateIntentSpec, "owner" | "treasury" | "receiverAuthority"> & {
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
  return getCreateIntentByAgentInstructionAsync({
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
    ...(await events()),
  });
}
