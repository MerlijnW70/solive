import { getIntentSize } from "@intent-engine/core/internal";
import { type Transport } from "@intent-engine/client";
import { rentExemptFor, type RentSysvar, rentSysvar, unmemoized } from "@intent-engine/client/internal";
import { checkedRent } from "@intent-engine/solver";
import { AgentRefusal } from "./problems.js";

export { MAX_RENT_PER_BYTE, MIN_RENT_PER_BYTE, UnsupportedRent, unsupportedRent, unsupportedThreshold } from "@intent-engine/solver";

export const BUDGET_WINDOW = 3_600n;
export const VAULT_BYTES = 170;
export const SIGNATURE_FEE = 5_000n;
export const TOKEN_ACCOUNT_RENT_BYTES = 170;

async function readRent(transport: Transport): Promise<RentSysvar> {
  return checkedRent(await rentSysvar(transport));
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
