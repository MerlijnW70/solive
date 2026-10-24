import type { Address } from "@solana/kit";
import type { Config } from "../generated/client/index.js";
import { Kind, kindBit, type KindName } from "./kinds.js";
import { U64_MAX } from "./math.js";
import { InvalidInput } from "./errors.js";

export const CONFIG_VERSION = 2;
export const USER_VERSION = 2;
export const INTENT_VERSION = 2;
export const PAUSE_CREATE = 1;
export const PAUSE_FILL = 2;
export const MAX_CREATE_FEE = 10_000_000;
export const MAX_CRANK_BOUNTY = 10_000_000;
export const MAX_FEE_BPS = 100;
export const MAX_ATTESTED_FEE_BPS = 300;

export function maxFeeBpsFor(kind: number): number {
  return kind === Kind.AttestedResult ? MAX_ATTESTED_FEE_BPS : MAX_FEE_BPS;
}

export function remainingOf(intent: { escrowed: bigint; filled: bigint }): bigint {
  if (intent.filled > intent.escrowed) {
    throw new InvalidInput("intent", "range", `an intent cannot have filled ${intent.filled} of ${intent.escrowed}`);
  }
  return intent.escrowed - intent.filled;
}

export const IntentStatus = { Open: 0, Filled: 1, Cancelled: 2, Expired: 3, Filling: 4 } as const;

export type IntentStatusName = keyof typeof IntentStatus;

export function statusName(status: number): IntentStatusName | undefined {
  return (Object.keys(IntentStatus) as IntentStatusName[]).find((name) => IntentStatus[name] === status);
}

export type FeeConfig = { feeBps: number; kindFeeMask: number; kindFeeBps: readonly number[] };

export function feeBpsFor(config: FeeConfig, kind: number): number {
  if ((config.kindFeeMask & (1 << kind)) === 0) {
    return config.feeBps;
  }
  const bps = config.kindFeeBps.at(kind - 1);
  if (bps === undefined) {
    throw new InvalidInput("kind", "unsupported", `no fee is configured for kind ${kind}`);
  }
  return bps;
}

export type KindSummary = { kind: Kind; name: KindName; create: boolean; fill: boolean; feeBps: number };

export type ConfigSummary = {
  createPaused: boolean;
  fillPaused: boolean;
  kinds: KindSummary[];
  createFee: bigint;
  crankBounty: bigint;
  partnerCutBps: number;
  admin: Address;
  guardian: Address;
};

export type SummarizedConfig = Pick<
  Config,
  | "admin"
  | "guardian"
  | "paused"
  | "enabledKinds"
  | "fillDisabledKinds"
  | "feeBps"
  | "kindFeeMask"
  | "kindFeeBps"
  | "partnerCutBps"
  | "createFee"
  | "crankBounty"
>;

const KINDS = [Kind.SwapExactIn, Kind.LimitOrder, Kind.DutchAuction, Kind.AttestedResult] as const;

export function configSummary(config: SummarizedConfig): ConfigSummary {
  return {
    createPaused: (config.paused & PAUSE_CREATE) !== 0,
    fillPaused: (config.paused & PAUSE_FILL) !== 0,
    kinds: KINDS.map((kind) => ({
      kind,
      name: Kind[kind] as KindName,
      create: (config.enabledKinds & kindBit(kind)) !== 0n,
      fill: (config.fillDisabledKinds & kindBit(kind)) === 0n,
      feeBps: feeBpsFor(config, kind),
    })),
    createFee: BigInt(config.createFee),
    crankBounty: BigInt(config.crankBounty),
    partnerCutBps: config.partnerCutBps,
    admin: config.admin,
    guardian: config.guardian,
  };
}

export const NONCE_WINDOW_WORDS = 4;

export function nextFreeNonce(window: { nonceBase: bigint; nonceBitmap: readonly bigint[] }): bigint | null {
  if (window.nonceBitmap.length !== NONCE_WINDOW_WORDS) {
    throw new InvalidInput("window", "length", `a nonce window has ${NONCE_WINDOW_WORDS} words, got ${window.nonceBitmap.length}`);
  }
  const word = window.nonceBitmap.findIndex((w) => w !== U64_MAX);
  if (word < 0) {
    return null;
  }
  let ones = 0n;
  for (let w = window.nonceBitmap[word] ?? 0n; (w & 1n) === 1n; w >>= 1n) {
    ones += 1n;
  }
  const next = window.nonceBase + BigInt(word) * 64n + ones;
  return next > U64_MAX ? null : next;
}
