import type { Address } from "@solana/kit";
import { Kind } from "@intent-engine/core";
import {
  decodeMandateAccount,
  escrowAmount,
  findIntentPda,
  findMandatePda,
  getMandateDiscriminatorBytes,
  type IntentParams,
  kindBit,
  type Mandate,
  mandateLane,
  type MandateSpec,
} from "@intent-engine/core/internal";
import { isSdkError, type Transport } from "@intent-engine/client";
import { createdAccount, engineAccount } from "@intent-engine/client/internal";
import { type Call, claim, claimedBy, type Claims, PREPARED_TTL } from "./claims.js";
import { AgentRefusal, ENGINE_PROBLEMS, SimulationFailed } from "./problems.js";
import { account, amount, optional } from "./schema.js";

export const MANDATE_KIND_NAMES = ["swap", "limit", "dutch"] as const;
export const MAX_MANDATE_SECONDS = 365 * 24 * 60 * 60;
export const MAX_MANDATE_INTENTS = 1_000_000;
export const MANDATE_ID_PROBES = 64;
export const REVOKE_CANCELS = 6;

const KIND_OF = { swap: Kind.SwapExactIn, limit: Kind.LimitOrder, dutch: Kind.DutchAuction } as const;

export const kindBits = (names: readonly (typeof MANDATE_KIND_NAMES)[number][]): number =>
  names.reduce((bits, name) => bits | Number(kindBit(KIND_OF[name])), 0);

export const NO_MANDATE_HINT = "it was never granted, or the owner revoked it, which closes it";

export async function loadMandate(transport: Transport, owner: Address, agent: Address, id: bigint) {
  const [address] = await findMandatePda({ owner, agent, id });
  const data = await engineAccount(transport, address, getMandateDiscriminatorBytes(), "mandate").catch((error: unknown) => {
    if (isSdkError(error, "missing-account")) {
      error.message = `${error.message}; ${NO_MANDATE_HINT}`;
    }
    throw error;
  });
  return { address, mandate: decodeMandateAccount(data) };
}

export function specOf(m: Mandate): MandateSpec {
  return {
    id: m.id,
    agent: m.agent,
    kinds: m.kinds,
    perIntent: m.perIntent,
    total: m.total,
    maxIntents: m.maxIntents,
    maxTtl: m.maxTtl,
    validUntil: m.validUntil,
    floorOut: m.floorOut,
    floorIn: m.floorIn,
    ...(m.partnerBps === 0 ? {} : { partner: { key: m.partner, bps: m.partnerBps } }),
    agentFee: m.agentFee,
  };
}

function limitsOf(m: Mandate): string {
  return `this mandate allows at most ${m.perIntent} raw input units per intent including the agent fee of ${m.agentFee}, ${m.total - m.spent} more raw input units in total, ${m.maxIntents - m.intents} more intents, each expiring within ${m.maxTtl} seconds, and at least ${m.floorOut} raw output units for every ${m.floorIn} raw input units it draws`;
}

export function explained(m: Mandate): (error: unknown) => never {
  return (error) => {
    if (error instanceof SimulationFailed && error.problem.code.startsWith("Mandate")) {
      throw new SimulationFailed({ ...error.problem, hint: `${error.problem.hint}; ${limitsOf(m)}` });
    }
    throw error;
  };
}

export const AGENT_NONCE_PROBES = 64n;

type Holding = { claims: Claims; call: Call; now: bigint };

export async function agentNonce(
  transport: Transport,
  owner: Address,
  serial: bigint,
  used: number,
  hold: Holding,
): Promise<bigint> {
  const lane = mandateLane(serial);
  if (lane === null) {
    throw new AgentRefusal("NoFreeNonce", "this mandate's grant serial has no nonce lane; the owner must grant a new mandate");
  }
  for (let k = 0n; k < AGENT_NONCE_PROBES; k++) {
    const nonce = lane | ((BigInt(used) + k) & 0xffff_ffffn);
    if (claimedBy(hold.claims, owner, hold.now).has(nonce)) {
      continue;
    }
    const [intent] = await findIntentPda({ owner, nonce });
    const taken = (await createdAccount(transport, intent)) !== null;
    if (!taken && !claimedBy(hold.claims, owner, hold.now).has(nonce)) {
      claim(hold.claims, hold.call, owner, nonce, hold.now + PREPARED_TTL, hold.now);
      return nonce;
    }
  }
  throw new AgentRefusal("NoFreeNonce", "this mandate's nonce lane is crowded; close some of its finished intents first");
}

export async function freeMandateId(transport: Transport, owner: Address, agent: Address): Promise<bigint> {
  for (let id = 0n; id < BigInt(MANDATE_ID_PROBES); id++) {
    const [address] = await findMandatePda({ owner, agent, id });
    if ((await createdAccount(transport, address)) === null) {
      return id;
    }
  }
  throw new AgentRefusal("NoFreeMandateId", `this owner already granted ${MANDATE_ID_PROBES} mandates to this agent; revoke one first`);
}

export const mandateRef = {
  owner: account("the wallet that granted the mandate"),
  agent: account("the agent key the mandate authorises"),
  id: optional(amount("which of the owner's mandates for this agent; default 0")),
};

const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;

export type MandateRefusal =
  | "MandateRevoked"
  | "MandateExpired"
  | "MandateKind"
  | "MandateTtl"
  | "MandateCap"
  | "MandateBudget"
  | "MandateCount"
  | "MandatePrice";

export function worstOut(params: IntentParams): bigint | null {
  switch (params.kind) {
    case Kind.SwapExactIn:
      return params.minOut;
    case Kind.LimitOrder:
      return params.takeAmount;
    case Kind.DutchAuction:
      return params.endOut;
    case Kind.AttestedResult:
      return null;
  }
}

const saturating = (value: bigint): bigint => (value > I64_MAX ? I64_MAX : value < I64_MIN ? I64_MIN : value);

export type Admission = { params: IntentParams; expiresAt: bigint; now: bigint; ownerEpoch: bigint | null };

export function mandateRefusal(m: Mandate, a: Admission): MandateRefusal | null {
  if (a.ownerEpoch !== null && a.ownerEpoch !== m.epoch) {
    return "MandateRevoked";
  }
  if (a.now >= m.validUntil) {
    return "MandateExpired";
  }
  const worst = worstOut(a.params);
  if (worst === null || (BigInt(m.kinds) & kindBit(a.params.kind)) === 0n) {
    return "MandateKind";
  }
  if (saturating(a.expiresAt - a.now) > m.maxTtl) {
    return "MandateTtl";
  }
  const cost = escrowAmount(a.params) + m.agentFee;
  if (cost > m.perIntent) {
    return "MandateCap";
  }
  if (m.spent + cost > m.total) {
    return "MandateBudget";
  }
  if (m.intents + 1 > m.maxIntents) {
    return "MandateCount";
  }
  if (worst * m.floorIn < cost * m.floorOut) {
    return "MandatePrice";
  }
  return null;
}

export function admitUnderMandate(m: Mandate, a: Admission): void {
  const refused = mandateRefusal(m, a);
  if (refused !== null) {
    throw new AgentRefusal(refused, `${ENGINE_PROBLEMS[refused].hint}; ${limitsOf(m)}`);
  }
}
