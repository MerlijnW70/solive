import type { Address } from "@solana/kit";
import { findUserStatePda, INTENT_ENGINE_PROGRAM_ADDRESS } from "../generated/client/index.js";
import {
  checkFlags,
  encodePartner,
  FILL_EXT_TAGS,
  type Partner,
  partnerOf,
  SETTLE_EXT_TAGS,
  validateExt,
} from "./ext.js";
import { encodeParams, type IntentParams, validate } from "./kinds.js";
import { NO_MANDATE } from "./mandate.js";
import { findAssociatedTokenAddress, findEventAuthorityPda, findIntentPda } from "./pdas.js";
import { InvalidInput } from "./errors.js";

export const INSTRUCTIONS_SYSVAR_ADDRESS =
  "Sysvar1nstructions1111111111111111111111111" as Address<"Sysvar1nstructions1111111111111111111111111">;

export async function events() {
  const [eventAuthority] = await findEventAuthorityPda();
  return { eventAuthority, program: INTENT_ENGINE_PROGRAM_ADDRESS };
}

export const fillExt = (ext?: Uint8Array) => validateExt(ext ?? new Uint8Array(), FILL_EXT_TAGS);
export const settleExt = (ext?: Uint8Array) => validateExt(ext ?? new Uint8Array(), SETTLE_EXT_TAGS);

export function createExt(input: { ext?: Uint8Array; partner?: Partner }): Uint8Array {
  if (input.ext !== undefined && input.partner !== undefined) {
    throw new InvalidInput("ext", "conflict", "pass either raw extension bytes or a partner, not both");
  }
  const ext = input.ext ?? (input.partner === undefined ? new Uint8Array() : encodePartner(input.partner));
  partnerOf(ext);
  return ext;
}

export function createArgs(input: {
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

export async function partnerAccount(input: { partner?: Address; inputMint: Address; inputTokenProgram: Address }) {
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

export async function mandateAccounts(input: { mandate?: Address; owner: Address }) {
  return input.mandate === undefined || input.mandate === NO_MANDATE
    ? {}
    : { mandate: input.mandate, ownerState: (await findUserStatePda({ owner: input.owner }))[0] };
}

export async function agentAccount(input: { agent?: Address; inputMint: Address; inputTokenProgram: Address }) {
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

export async function intentOf(owner: Address, nonce: bigint): Promise<Address> {
  return (await findIntentPda({ owner, nonce }))[0];
}
