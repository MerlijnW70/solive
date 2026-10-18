import type { Address } from "@solana/kit";
import { decodeParams, escrowAmount, type IntentParams, Kind } from "./kinds.js";
import { partnerOf } from "./ext.js";
import { U64_MAX } from "./math.js";
import { findAssociatedTokenAddress } from "./pdas.js";
import { checkSignable, type SignedIntentFields, signedIntentPreimage } from "./sig.js";

export const LONG_LIVED_SECONDS = 30n * 24n * 60n * 60n;
export const WARN_ATTESTOR =
  "an attestor alone decides the settlement result; the chain checks only the attestor's signature and that the result lies between the minimum and maximum";
export const WARN_LONG_LIVED = "this intent stays fillable for more than 30 days";
export const WARN_RECEIVER = "the output goes to an account other than your own canonical token account";
export const LONG_SUBMIT_SECONDS = 24n * 60n * 60n;
export const WARN_LONG_SUBMIT = "a relayer may hold this signature and submit it for more than a day";
export const WARN_STALE_EPOCH = "this signature is for an earlier epoch and can never be used";
export const WARN_DOMAIN = "this signature is for a different cluster than the one you expect";
export const WARN_RELAYER_FEE = "the relayer fee is more than 1% of what you sell";
export const WARN_PROOF =
  "the judge alone decides whether the work meets the committed spec; the chain checks only that its verdict names that spec";

export function settlementWarnings(params: IntentParams): string[] {
  if (params.kind !== Kind.AttestedResult) {
    return [];
  }
  return [params.specHash.some((byte) => byte !== 0) ? WARN_PROOF : WARN_ATTESTOR];
}

export const ATTESTED_PROTOCOL_FEE = "Protocol fee: taken out of what the payee receives, not added on top of the sold amount";

const MAX_DATE_SECONDS = 8_640_000_000_000n;

export type DescribeOptions = {
  now: bigint;
  currentEpoch: bigint;
  expectedDomain?: Uint8Array;
  outputTokenProgram: Address;
  inputDecimals?: number;
  outputDecimals?: number;
} & TokenNames;

export type TokenNames = { inputName?: string | undefined; outputName?: string | undefined };

export const tokenOf = (mint: Address, name: string | undefined): string => (name === undefined ? mint : `${name} (${mint})`);

export type SignedIntentDescription = {
  lines: string[];
  warnings: string[];
  digest: string;
};

export function formatAmount(raw: bigint, decimals?: number): string {
  if (decimals === undefined) {
    return `${raw} raw units`;
  }
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new RangeError(`${decimals} is not a token decimals value`);
  }
  const scale = 10n ** BigInt(decimals);
  const whole = raw / scale;
  const fraction = (raw % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction === "" ? `${whole}` : `${whole}.${fraction}`;
}

export const TOKEN_AMOUNT_PATTERN = /^(\d+)(?:\.(\d+))?$/;

export function parseAmount(text: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new RangeError(`${decimals} is not a token decimals value`);
  }
  const match = TOKEN_AMOUNT_PATTERN.exec(text);
  if (match === null) {
    throw new RangeError(`${text} is not a token amount like 12 or 0.5`);
  }
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) {
    throw new RangeError(`${text} has more than the token's ${decimals} decimal places`);
  }
  const raw = BigInt(match[1] ?? "0") * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (raw > U64_MAX) {
    throw new RangeError(`${text} is more than a token account can hold`);
  }
  return raw;
}

export function formatTime(unixSeconds: bigint): string {
  if (unixSeconds > MAX_DATE_SECONDS || unixSeconds < -MAX_DATE_SECONDS) {
    return `unix ${unixSeconds}`;
  }
  return new Date(Number(unixSeconds) * 1000).toISOString();
}

const hex = (bytes: ArrayLike<number>) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

export type TermsFields = Pick<SignedIntentFields, "kind" | "params" | "inputMint" | "outputMint">;

export function describeTerms(
  f: TermsFields,
  o: { inputDecimals?: number | undefined; outputDecimals?: number | undefined } & TokenNames,
): string[] {
  const params = decodeParams(f.kind, f.params);
  const sell = (amount: bigint) => `Sell: exactly ${formatAmount(amount, o.inputDecimals)} of ${tokenOf(f.inputMint, o.inputName)}`;
  const out = (amount: bigint) => `${formatAmount(amount, o.outputDecimals)} of ${tokenOf(f.outputMint, o.outputName)}`;
  switch (params.kind) {
    case Kind.SwapExactIn:
      return [sell(params.amountIn), `Receive: at least ${out(params.minOut)}`];
    case Kind.LimitOrder:
      return [sell(params.makeAmount), `Receive: at least ${out(params.takeAmount)}`];
    case Kind.DutchAuction:
      return [
        sell(params.amountIn),
        `Receive: at least ${out(params.startOut)} at ${formatTime(params.startTs)}, falling to ${out(params.endOut)} at ${formatTime(params.endTs)}`,
      ];
    case Kind.AttestedResult: {
      const proof = params.specHash.some((byte) => byte !== 0);
      return [
        sell(params.amountIn),
        `Settles: when ${params.attestor} attests a result between ${params.minResult} and ${params.maxResult}`,
        `Payee: chosen by ${params.attestor} when it attests; one signature from it pays the sold amount, less fees, to any wallet it signs for`,
        ...(proof ? [`Spec hash: ${hex(params.specHash)}, the spec the judge checks the work against`] : []),
        ...(proof || params.judgeFee !== 0n
          ? [
              `Judge fee: ${formatAmount(params.judgeFee, o.inputDecimals)} of ${tokenOf(f.inputMint, o.inputName)}, paid to ${params.attestor} out of the sold amount when the intent settles`,
            ]
          : []),
        ATTESTED_PROTOCOL_FEE,
        `Output token: ${tokenOf(f.outputMint, o.outputName)}, a label only; the release pays out the sold token, never this one`,
      ];
    }
  }
}

export const PARTNER_BASE_SOLD = "the sold amount";
export const PARTNER_BASE_AFTER_JUDGE = "the sold amount less the judge fee";

export function partnerBaseOf(params: IntentParams): string {
  return params.kind === Kind.AttestedResult && params.judgeFee !== 0n ? PARTNER_BASE_AFTER_JUDGE : PARTNER_BASE_SOLD;
}

export function partnerFeeLine(bps: number, key: string, base: string = PARTNER_BASE_SOLD): string {
  return `Partner fee: ${bps} bps of ${base}, rounded up, to ${key}, less the protocol's partner cut fixed when the intent is created`;
}

function partnerLine(f: SignedIntentFields): string[] {
  const partner = partnerOf(f.ext ?? new Uint8Array());
  if (partner === undefined) {
    return [];
  }
  return [partnerFeeLine(partner.bps, partner.key, partnerBaseOf(decodeParams(f.kind, f.params)))];
}

export async function describeSignedIntent(
  f: SignedIntentFields,
  o: DescribeOptions,
): Promise<SignedIntentDescription> {
  checkSignable(f);
  if (f.epoch > o.currentEpoch) {
    throw new RangeError(
      `refusing to describe a signature for epoch ${f.epoch}: the owner is at epoch ${o.currentEpoch}, and a later epoch change would arm it`,
    );
  }
  const relayerFee = f.relayerFee ?? 0n;
  const preimage = await signedIntentPreimage(f);
  const digest = hex(new Uint8Array(await crypto.subtle.digest("SHA-256", preimage.slice())));
  const canonical = await findAssociatedTokenAddress({
    owner: f.owner,
    mint: f.outputMint,
    tokenProgram: o.outputTokenProgram,
  });
  const warnings = [
    ...settlementWarnings(decodeParams(f.kind, f.params)),
    ...(f.expiresAt - o.now > LONG_LIVED_SECONDS ? [WARN_LONG_LIVED] : []),
    ...(f.receiver === canonical ? [] : [WARN_RECEIVER]),
    ...(f.submitBy - o.now > LONG_SUBMIT_SECONDS ? [WARN_LONG_SUBMIT] : []),
    ...(f.epoch < o.currentEpoch ? [WARN_STALE_EPOCH] : []),
    ...(o.expectedDomain === undefined || hex(o.expectedDomain) === hex(f.domain) ? [] : [WARN_DOMAIN]),
    ...(relayerFee * 100n > escrowAmount(decodeParams(f.kind, f.params)) ? [WARN_RELAYER_FEE] : []),
  ];
  const lines = [
    `Owner: ${f.owner}`,
    `Pays from: ${f.ownerInput}`,
    ...describeTerms(f, o),
    `Receiver: ${f.receiver}`,
    `Expires: ${formatTime(f.expiresAt)}`,
    `Submit by: ${formatTime(f.submitBy)}`,
    `Nonce: ${f.nonce}`,
    `Signing epoch: ${f.epoch}`,
    ...partnerLine(f),
    ...(relayerFee === 0n
      ? []
      : [`Relayer fee: ${formatAmount(relayerFee, o.inputDecimals)} of ${tokenOf(f.inputMint, o.inputName)}, paid from ${f.ownerInput} to whoever submits it`]),
    `Cluster domain: ${hex(f.domain)}`,
    ...(f.program === undefined ? [] : [`Program: ${f.program}`]),
    `Revoke: this signature stays usable until ${formatTime(f.submitBy)}; cancel it sooner by advancing your signing epoch or your nonce base past it, or by revoking the engine's spending allowance`,
    ...warnings.map((w) => `WARNING: ${w}`),
    `Digest (must match your wallet): ${digest}`,
  ];
  return { lines, warnings, digest };
}
