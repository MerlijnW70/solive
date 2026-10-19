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

export type ReleaseTerms = { amount: bigint; judgeFee: bigint; feeBps: number; partnerBps: number; cutBps: number };

function feesFit(rest: bigint, terms: ReleaseTerms): boolean {
  try {
    splitFees(rest, terms.feeBps, terms.partnerBps, terms.cutBps);
    return true;
  } catch (error) {
    if (error instanceof IntentCoreError) {
      return false;
    }
    throw error;
  }
}

export function releaseSettles(terms: ReleaseTerms): boolean {
  return terms.amount > terms.judgeFee && feesFit(terms.amount - terms.judgeFee, terms);
}

export type SettleBounds = { leastAmount?: bigint; mostJudgeFee?: bigint };

export function settleBounds(terms: ReleaseTerms): SettleBounds {
  for (let rest = 1n; rest <= BPS_DENOMINATOR; rest += 1n) {
    if (!feesFit(rest, terms)) {
      continue;
    }
    const leastAmount = terms.judgeFee + rest;
    return {
      ...(leastAmount <= U64_MAX ? { leastAmount } : {}),
      ...(terms.amount >= rest ? { mostJudgeFee: terms.amount - rest } : {}),
    };
  }
  return {};
}
