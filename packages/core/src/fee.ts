import { IntentCoreError } from "./errors.js";
import { checkU64, mulDivCeil, mulDivFloor, U64_MAX } from "./math.js";

export const BPS_DENOMINATOR = 10_000n;

export function checkBps(bps: number, name = "bps"): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > Number(BPS_DENOMINATOR)) {
    throw new RangeError(`${name} ${String(bps)} is not between 0 and ${BPS_DENOMINATOR}`);
  }
  return BigInt(bps);
}

export type FeeSplit = { fee: bigint; net: bigint };

export function splitFee(amount: bigint, feeBps: number): FeeSplit {
  checkU64(amount);
  const fee = mulDivCeil(amount, checkBps(feeBps, "fee bps"), BPS_DENOMINATOR);
  if (fee > amount) {
    throw new IntentCoreError("InvalidParams");
  }
  return { fee, net: amount - fee };
}

export type FeeShares = { protocol: bigint; partner: bigint; net: bigint };

export function splitFees(amount: bigint, feeBps: number, partnerBps: number, cutBps: number): FeeShares {
  checkU64(amount);
  const fee = mulDivCeil(amount, checkBps(feeBps, "fee bps"), BPS_DENOMINATOR);
  const gross = mulDivCeil(amount, checkBps(partnerBps, "partner bps"), BPS_DENOMINATOR);
  const cut = mulDivFloor(gross, checkBps(cutBps, "partner cut bps"), BPS_DENOMINATOR);
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
