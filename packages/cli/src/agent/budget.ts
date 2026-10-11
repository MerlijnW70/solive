import { getIntentSize } from "@intent-engine/core";
import { AgentRefusal } from "./problems.js";

export const BUDGET_WINDOW = 3_600n;
export const ACCOUNT_OVERHEAD_BYTES = 128n;
export const RENT_LAMPORTS_PER_BYTE = 6_960n;
export const VAULT_BYTES = 170;
export const SIGNATURE_FEE = 5_000n;
export const TOKEN_ACCOUNT_RENT_BYTES = 170;

export const rentFor = (bytes: number): bigint => (BigInt(bytes) + ACCOUNT_OVERHEAD_BYTES) * RENT_LAMPORTS_PER_BYTE;

export function createCost(economics: { createFee: number; crankBounty: number }): bigint {
  return (
    BigInt(economics.createFee) +
    BigInt(economics.crankBounty) +
    rentFor(getIntentSize()) +
    rentFor(VAULT_BYTES) +
    SIGNATURE_FEE
  );
}

export type Spend = { at: bigint; lamports: bigint };

export type Budget = { hourly: bigint; spends: Spend[] };

export const budgetOf = (hourly: bigint): Budget => ({ hourly, spends: [] });

export function reserve(budget: Budget, lamports: bigint, now: bigint): Spend {
  budget.spends = budget.spends.filter((s) => s.at > now - BUDGET_WINDOW);
  const used = budget.spends.reduce((sum, s) => sum + s.lamports, 0n);
  if (used + lamports > budget.hourly) {
    throw new AgentRefusal(
      "BudgetExhausted",
      `this key may spend ${budget.hourly} lamports per hour and has ${budget.hourly - used} left; this needs ${lamports}`,
      true,
    );
  }
  const spend = { at: now, lamports };
  budget.spends.push(spend);
  return spend;
}

export function release(budget: Budget, spend: Spend): void {
  budget.spends = budget.spends.filter((s) => s !== spend);
}
