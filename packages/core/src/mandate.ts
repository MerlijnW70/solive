import type { Address } from "@solana/kit";
import { formatAmount, formatTime } from "./describe.js";
import { encodePartner, type Partner } from "./ext.js";
import { Kind, kindBit } from "./kinds.js";

export const MANDATE_KINDS = Number(kindBit(Kind.SwapExactIn) | kindBit(Kind.LimitOrder) | kindBit(Kind.DutchAuction));

export const MANDATE_NONCE_BIT = 1n << 63n;
export const LANE_MASK = 0xffff_ffff_0000_0000n;
export const MAX_LANE_SERIAL = (1n << 31n) - 1n;

export function mandateLane(serial: bigint): bigint | null {
  return serial < 1n || serial > MAX_LANE_SERIAL ? null : MANDATE_NONCE_BIT | (serial << 32n);
}

export function inLane(nonce: bigint, serial: bigint): boolean {
  const lane = mandateLane(serial);
  return lane !== null && (nonce & LANE_MASK) === lane;
}

export const NO_ADDRESS = "11111111111111111111111111111111" as Address;
export const NO_PARTNER = NO_ADDRESS;
export const NO_MANDATE = NO_ADDRESS;

export const LONG_MANDATE_SECONDS = 30n * 24n * 60n * 60n;

export const WARN_LONG_MANDATE = "the agent can keep using this mandate for more than 30 days";

export type MandateSpec = {
  id: bigint;
  agent: Address;
  kinds: number;
  perIntent: bigint;
  total: bigint;
  maxIntents: number;
  maxTtl: bigint;
  validUntil: bigint;
  floorOut: bigint;
  floorIn: bigint;
  partner?: Partner;
  agentFee?: bigint;
};

const KIND_NAMES: [Kind, string][] = [
  [Kind.SwapExactIn, "swap"],
  [Kind.LimitOrder, "limit"],
  [Kind.DutchAuction, "dutch"],
];

export function mandateKinds(kinds: number): string[] {
  if (!Number.isInteger(kinds) || kinds <= 0 || (kinds & ~MANDATE_KINDS) !== 0) {
    throw new RangeError(`a mandate may cover only swap, limit and dutch intents, got kind bits ${kinds}`);
  }
  return KIND_NAMES.filter(([kind]) => (kinds & Number(kindBit(kind))) !== 0).map(([, name]) => name);
}

export function mandateArgs(spec: MandateSpec) {
  mandateKinds(spec.kinds);
  if (spec.partner !== undefined) {
    encodePartner(spec.partner);
  }
  const partner =
    spec.partner === undefined
      ? { partner: NO_PARTNER, partnerBps: 0 }
      : { partner: spec.partner.key, partnerBps: spec.partner.bps };
  return {
    id: spec.id,
    agent: spec.agent,
    kinds: spec.kinds,
    perIntent: spec.perIntent,
    total: spec.total,
    maxIntents: spec.maxIntents,
    maxTtl: spec.maxTtl,
    validUntil: spec.validUntil,
    floorOut: spec.floorOut,
    floorIn: spec.floorIn,
    ...partner,
    agentFee: spec.agentFee ?? 0n,
  };
}

export type MandateContext = {
  inputMint: Address;
  outputMint: Address;
  now: bigint;
  inputDecimals?: number | undefined;
  outputDecimals?: number | undefined;
};

export function describeMandate(spec: MandateSpec, o: MandateContext): { lines: string[]; warnings: string[] } {
  const kinds = mandateKinds(spec.kinds);
  const agentFee = spec.agentFee ?? 0n;
  if (agentFee >= spec.perIntent) {
    throw new RangeError(`an agent fee of ${agentFee} leaves nothing to sell under a per-intent cap of ${spec.perIntent}`);
  }
  const sell = (amount: bigint) => `${formatAmount(amount, o.inputDecimals)} of ${o.inputMint}`;
  const warnings = spec.validUntil - o.now > LONG_MANDATE_SECONDS ? [WARN_LONG_MANDATE] : [];
  return {
    lines: [
      `Agent: ${spec.agent}`,
      `May sell: ${o.inputMint} for ${o.outputMint} only, as ${kinds.join(", ")} intents`,
      `Per intent: at most ${sell(spec.perIntent)}`,
      `In total: at most ${sell(spec.total)} over at most ${spec.maxIntents} intents`,
      `Price floor: at least ${formatAmount(spec.floorOut, o.outputDecimals)} of ${o.outputMint} for every ${sell(spec.floorIn)}`,
      `Each intent expires within ${spec.maxTtl} seconds of its creation`,
      `Valid until: ${formatTime(spec.validUntil)}`,
      ...(spec.partner === undefined ? [] : [`Partner fee: ${spec.partner.bps} bps of the sold amount to ${spec.partner.key}`]),
      ...(agentFee === 0n
        ? []
        : [
            `Agent fee: ${sell(agentFee)} per intent, paid to the agent only when that intent fills (refunded if it is cancelled or expires) and counted in every limit above, the price floor included`,
            `Largest single sale: ${sell(spec.perIntent - agentFee)}, the per-intent cap less the agent fee`,
          ]),
      `Proceeds always go to your own token account; the agent pays all network fees and rent${agentFee === 0n ? " and takes no fee" : ""}`,
      "The agent's intents use their own nonces and never touch your signing window",
      "Revoke it any time, or revoke every mandate and signature at once by advancing your signing epoch; once revoked, no intent the agent opened can be filled, and you can cancel them to take your tokens back",
      ...warnings.map((w) => `WARNING: ${w}`),
    ],
    warnings,
  };
}
