import { IntentCoreError } from "./errors.js";
import { mulDivCeil, mulDivFloor, U64_MAX } from "./math.js";

export const BPS_DENOMINATOR = 10_000n;

export type FeeSplit = { fee: bigint; net: bigint };

export function splitFee(amount: bigint, feeBps: number): FeeSplit {
  const fee = mulDivCeil(amount, BigInt(feeBps), BPS_DENOMINATOR);
  if (fee > amount) {
    throw new IntentCoreError("InvalidParams");
  }
  return { fee, net: amount - fee };
}

export type FeeShares = { protocol: bigint; partner: bigint; net: bigint };

export function splitFees(amount: bigint, feeBps: number, partnerBps: number, cutBps: number): FeeShares {
  const fee = mulDivCeil(amount, BigInt(feeBps), BPS_DENOMINATOR);
  const gross = mulDivCeil(amount, BigInt(partnerBps), BPS_DENOMINATOR);
  const cut = mulDivFloor(gross, BigInt(cutBps), BPS_DENOMINATOR);
  if (cut > gross) {
    throw new IntentCoreError("InvalidParams");
  }
  const protocol = fee + cut;
  if (protocol > U64_MAX) {
    throw new IntentCoreError("Overflow");
  }
  if (fee + gross > amount) {
    throw new IntentCoreError("InvalidParams");
  }
  return { protocol, partner: gross - cut, net: amount - fee - gross };
}
