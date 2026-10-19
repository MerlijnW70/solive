import { getIntentSize } from "@intent-engine/core";
import { rentExemptFor, type RentSysvar, rentSysvar, type Transport, unmemoized } from "@intent-engine/client";
import { AgentRefusal } from "./problems.js";

export const BUDGET_WINDOW = 3_600n;
export const MIN_RENT_PER_BYTE = 696;
export const MAX_RENT_PER_BYTE = 6_960;
export const VAULT_BYTES = 170;
export const SIGNATURE_FEE = 5_000n;
export const TOKEN_ACCOUNT_RENT_BYTES = 170;

export class UnsupportedRent extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedRent";
  }
}

export const unsupportedRent = (rate: number): string =>
  `the cluster charges ${rate} lamports of rent per byte; this client prices rent only from ${MIN_RENT_PER_BYTE} to ${MAX_RENT_PER_BYTE}`;

export const unsupportedThreshold = (threshold: number): string =>
  `the cluster's rent sysvar reports an exemption threshold of ${threshold}; this client prices rent only with a positive finite threshold`;

async function readRent(transport: Transport): Promise<RentSysvar> {
  const rent = await rentSysvar(transport);
  if (!Number.isFinite(rent.threshold) || rent.threshold <= 0) {
    throw new UnsupportedRent(unsupportedThreshold(rent.threshold));
  }
  const rate = Number(rent.perByteYear) * rent.threshold;
  if (!(rate >= MIN_RENT_PER_BYTE && rate <= MAX_RENT_PER_BYTE)) {
    throw new UnsupportedRent(unsupportedRent(rate));
  }
  return rent;
}

const rentRates = new WeakMap<Transport, Promise<RentSysvar>>();

export function rentRate(transport: Transport): Promise<RentSysvar> {
  const source = unmemoized(transport);
  const known = rentRates.get(source);
  if (known !== undefined) {
    return known;
  }
  const pending = readRent(source);
  rentRates.set(source, pending);
  pending.catch(() => {
    if (rentRates.get(source) === pending) {
      rentRates.delete(source);
    }
  });
  return pending;
}

export const rentFor = (bytes: number, rent: RentSysvar): bigint => rentExemptFor(rent, bytes);

export function createCost(economics: { createFee: number; crankBounty: number }, rent: RentSysvar): bigint {
  return (
    BigInt(economics.createFee) +
    BigInt(economics.crankBounty) +
    rentFor(getIntentSize(), rent) +
    rentFor(VAULT_BYTES, rent) +
    SIGNATURE_FEE
  );
}

type Spend = { at: bigint; lamports: bigint };

export type Budget = { hourly: bigint; spends: Spend[] };

export const budgetOf = (hourly: bigint): Budget => ({ hourly, spends: [] });

export function reserve(budget: Budget, lamports: bigint, now: bigint): Spend {
  budget.spends = budget.spends.filter((s) => s.at > now - BUDGET_WINDOW);
  const used = budget.spends.reduce((sum, s) => sum + s.lamports, 0n);
  if (used + lamports > budget.hourly) {
    throw new AgentRefusal(
      "BudgetExhausted",
      `this key may spend ${budget.hourly} lamports per hour and has ${budget.hourly - used} left; this needs ${lamports}`,
    );
  }
  const spend = { at: now, lamports };
  budget.spends.push(spend);
  return spend;
}

export function release(budget: Budget, spend: Spend): void {
  budget.spends = budget.spends.filter((s) => s !== spend);
}
