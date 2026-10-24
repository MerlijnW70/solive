import { type Address, getBase64Encoder, type Instruction } from "@solana/kit";
import { buildCreateIntentSigned, type IntentParams } from "@intent-engine/core";
import { bytesFit } from "@intent-engine/solver";
import { isSdkError, type Transport } from "@intent-engine/client";
import { type Prepared, transactionSize } from "./prepare.js";
import { AgentRefusal } from "./problems.js";
import type { Relay } from "./relay.js";
import type { SignedTerms } from "./signed-terms.js";

export function relayFloor(relay: Relay, mint: Address): bigint {
  const floor = relay.fees.get(mint);
  if (floor === undefined) {
    throw new AgentRefusal(
      "RelayMintNotAccepted",
      `this server's relayer does not relay intents selling ${mint}; it relays only ${[...relay.fees.keys()].join(", ")}`,
    );
  }
  return floor;
}

export const RELAY_TOO_LARGE =
  "this server's relayer cannot fit these signed terms in one Solana transaction; drop the partner fee or use a relayer that adds no priority fee";

export async function relayCreate(
  input: SignedTerms,
  relay: Relay,
  config: { feeRecipient: Address; createFee: number; crankBounty: number },
  params: IntentParams,
  tokenPrograms: { input: Address; output: Address },
  mintCap?: Address,
  committee?: Address,
): Promise<Instruction> {
  return buildCreateIntentSigned({
    payer: relay.signer,
    owner: input.owner,
    treasury: config.feeRecipient,
    maxCreateFee: config.createFee,
    maxBounty: config.crankBounty,
    nonce: input.nonce,
    params,
    expiresAt: input.expires_at,
    ...(input.partner === undefined ? {} : { partner: { key: input.partner.account, bps: input.partner.bps } }),
    inputMint: input.input_mint,
    outputMint: input.output_mint,
    inputTokenProgram: tokenPrograms.input,
    outputTokenProgram: tokenPrograms.output,
    submitBy: input.submit_by,
    relayerFee: input.relayer_fee,
    ...(mintCap === undefined ? {} : { mintCap }),
    ...(committee === undefined ? {} : { committee }),
  });
}

export async function relayFits(transport: Transport, relay: Relay, instructions: readonly Instruction[]): Promise<boolean> {
  const budgeted = await transport.budget(instructions, relay.signer.address);
  return bytesFit(await transactionSize(transport, budgeted, relay.signer.address));
}

export const SPEC_URL_TOO_LONG =
  "this server's relayer cannot fit the spec url's memo with these signed terms in one Solana transaction; give a shorter spec_url or leave it out";

export const preparedFits =(prepared: Prepared): boolean => bytesFit(getBase64Encoder().encode(prepared.transaction).length);

export function offeredFee(floor: bigint, offered: bigint | undefined): bigint {
  if (offered === undefined) {
    return floor;
  }
  if (offered < floor) {
    throw new AgentRefusal(
      "RelayFeeTooLow",
      `this server's relayer charges ${floor} raw units of the input token; offer at least that or leave relayer_fee out`,
    );
  }
  return offered;
}

export async function paying<T>(paid: { any: boolean }, sending: Promise<T>): Promise<T> {
  try {
    const result = await sending;
    paid.any = true;
    return result;
  } catch (error) {
    if (isSdkError(error, "maybe-sent") || isSdkError(error, "failed-on-chain")) {
      paid.any = true;
    }
    throw error;
  }
}

export const repriced = (admitted: bigint, now: bigint) =>
  `the priority fee rose from the admitted ${admitted} to ${now} lamports while relaying; ask again later`;

export function refuseRepricing(admitted: bigint, now: bigint): void {
  if (now > admitted) {
    throw new AgentRefusal("RelayTooCostly", repriced(admitted, now));
  }
}
