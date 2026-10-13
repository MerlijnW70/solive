import type { Address } from "@solana/kit";
import {
  decodeParams,
  decodeParamsLoose,
  type FeeConfig,
  feeBpsFor,
  remainingOf,
  requiredOut,
  splitFees,
  INTENT_VERSION,
  type Intent,
  Kind,
} from "@intent-engine/core";

export const STATUS = ["open", "filled", "cancelled", "expired", "filling"] as const;

export function quoteOf(intent: Intent, config: FeeConfig, at: bigint) {
  const params = decodeParams(intent.kind, Uint8Array.from(intent.params));
  const amountIn = remainingOf(intent);
  const feeBps = feeBpsFor(config, params.kind);
  const fees = splitFees(amountIn, feeBps, intent.partnerBps, intent.partnerCutBps);
  return {
    at,
    amountIn,
    requiredOut: requiredOut(params, amountIn, at),
    feeBps,
    partnerBps: intent.partnerBps,
    protocolFee: fees.protocol,
    partnerFee: fees.partner,
    net: fees.net,
  };
}

const hex = (bytes: ArrayLike<number>) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export function describeIntent(address: Address, intent: Intent) {
  const raw = Uint8Array.from(intent.params);
  const params =
    intent.version === INTENT_VERSION
      ? decodeParamsLoose(intent.kind, raw)
      : { kind: intent.kind, unknown: true as const, raw, reason: `unsupported version ${intent.version}` };
  return {
    address,
    owner: intent.owner,
    inputMint: intent.inputMint,
    outputMint: intent.outputMint,
    receiver: intent.receiver,
    rentPayer: intent.rentPayer,
    nonce: intent.nonce,
    escrowed: intent.escrowed,
    createdAt: intent.createdAt,
    expiresAt: intent.expiresAt,
    status: STATUS[intent.status] ?? `unknown(${intent.status})`,
    version: intent.version,
    flags: intent.flags,
    filled: intent.filled,
    revision: intent.revision,
    bounty: intent.bounty,
    ...(intent.partnerBps === 0 ? {} : { partner: intent.partner, partnerBps: intent.partnerBps }),
    params:
      "unknown" in params && params.unknown
        ? { kind: `unknown(${params.kind})`, raw: hex(params.raw), reason: params.reason }
        : { ...params, kind: Kind[params.kind] },
  };
}

export const sameBytes = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  a.length === b.length && Array.from(a).every((v, i) => v === b[i]);
