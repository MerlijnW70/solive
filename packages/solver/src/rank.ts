import { NATIVE_MINT } from "@intent-engine/core";
import type { Plan, SolValue } from "./plan.js";

type Worth = { lamports: bigint; per: bigint };

const compare = <T extends bigint | string>(a: T, b: T): number => (a < b ? -1 : a > b ? 1 : 0);

export function worthOf(plan: Pick<Plan, "intent" | "profit">, solValue: SolValue | undefined): Worth | null {
  const mint = plan.intent.outputMint;
  if (mint === NATIVE_MINT) {
    return { lamports: plan.profit, per: 1n };
  }
  const value = solValue?.get(mint);
  return value === undefined ? null : { lamports: plan.profit * value.lamports, per: value.raw };
}

function byProfit(a: Plan, b: Plan, solValue: SolValue | undefined): number {
  const worthA = worthOf(a, solValue);
  const worthB = worthOf(b, solValue);
  if (worthA !== null && worthB !== null) {
    return compare(worthB.lamports * worthA.per, worthA.lamports * worthB.per);
  }
  if (worthA !== null || worthB !== null) {
    return worthA === null ? 1 : -1;
  }
  return compare(b.profit, a.profit);
}

export function firstToSend(a: Plan, b: Plan, solValue?: SolValue): number {
  return byProfit(a, b, solValue) || compare(a.intent.expiresAt, b.intent.expiresAt) || compare(a.address, b.address);
}
