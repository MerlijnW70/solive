import type { Address } from "@solana/kit";
import { NATIVE_MINT } from "@intent-engine/core";
import type { Plan, SolValue } from "./plan.js";

export const NET_BELOW_FLOOR = "the fill's profit less its sol cost is below the profit floor";

export const netBelowFloor = (profit: bigint, cost: bigint, lamports: bigint, floor: bigint): string =>
  `${NET_BELOW_FLOOR}: profit ${profit} less a cost of ${cost} (${lamports} lamports) is below the floor of ${floor}`;

export const unpricedFloor = (mint: Address): string =>
  `--min-profit names ${mint}, which has no way to be priced in SOL, so its fills are not netted against their SOL cost; add --sol-value ${mint}=<raw>/<lamports>`;

export const badSolValue = (mint: Address): string => `the sol value of ${mint} must be positive on both sides`;

export function solValueFits(solValue: SolValue | undefined): string | null {
  for (const [mint, { raw, lamports }] of solValue ?? []) {
    if (raw <= 0n || lamports <= 0n) {
      return badSolValue(mint);
    }
  }
  return null;
}

export function costIn(mint: Address, lamports: bigint, solValue: SolValue | undefined): bigint | null {
  if (mint === NATIVE_MINT) {
    return lamports;
  }
  const value = solValue?.get(mint);
  return value === undefined ? null : (lamports * value.raw + value.lamports - 1n) / value.lamports;
}

export function netShort(plan: Pick<Plan, "intent" | "profit">, floor: bigint, lamports: bigint, solValue: SolValue | undefined): string | null {
  const cost = costIn(plan.intent.outputMint, lamports, solValue);
  return cost === null || plan.profit - cost >= floor ? null : netBelowFloor(plan.profit, cost, lamports, floor);
}

export function unpricedFloors(minProfit: ReadonlyMap<Address, bigint>, solValue: SolValue | undefined): string[] {
  return [...minProfit.keys()].filter((mint) => mint !== NATIVE_MINT && solValue?.has(mint) !== true).map(unpricedFloor);
}
