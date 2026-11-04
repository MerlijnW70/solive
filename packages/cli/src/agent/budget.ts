import type { Address } from "@solana/kit";
import { getIntentSize, TOKEN_2022_PROGRAM_ADDRESS } from "@intent-engine/core/internal";
import { type Transport } from "@intent-engine/client";
import { rentExemptFor, type RentSysvar, rentSysvar, unmemoized } from "@intent-engine/client/internal";
import { checkedRent } from "@intent-engine/solver";
import { AgentRefusal } from "./problems.js";

export { MAX_RENT_PER_BYTE, MIN_RENT_PER_BYTE, UnsupportedRent, unsupportedRent, unsupportedThreshold } from "@intent-engine/solver";

export const BUDGET_WINDOW = 3_600n;
export const SIGNATURE_FEE = 5_000n;
export const TOKEN_ACCOUNT_RENT_BYTES = 170;
export const TOKEN_ACCOUNT_BYTES = 165;

const MINT_EXTENSIONS_AT = 166;
const EXTENSION_HEADER = 4;

const ACCOUNT_EXTENSIONS: ReadonlyMap<number, readonly (readonly [number, number])[]> = new Map([
  [1, [[2, 8]]],
  [9, [[13, 0], [7, 0]]],
  [14, [[15, 1]]],
  [26, [[27, 0]]],
]);

export function vaultBytes(mint: { owner: Address; data: Uint8Array }): number {
  if (mint.owner !== TOKEN_2022_PROGRAM_ADDRESS) {
    return TOKEN_ACCOUNT_BYTES;
  }
  const { data } = mint;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const needed = new Map<number, number>();
  for (let at = MINT_EXTENSIONS_AT; at + EXTENSION_HEADER <= data.length; at += EXTENSION_HEADER + view.getUint16(at + 2, true)) {
    const type = view.getUint16(at, true);
    if (type === 0) {
      break;
    }
    for (const [extension, bytes] of ACCOUNT_EXTENSIONS.get(type) ?? []) {
      needed.set(extension, bytes);
    }
  }
  if (needed.size === 0) {
    return TOKEN_ACCOUNT_BYTES;
  }
  return [...needed.values()].reduce((total, length) => total + EXTENSION_HEADER + length, MINT_EXTENSIONS_AT);
}

async function readRent(transport: Transport): Promise<RentSysvar> {
  return checkedRent(await rentSysvar(transport));
}

export const RENT_TTL_MS = 60_000;

const rentRates = new WeakMap<Transport, { at: number; pending: Promise<RentSysvar> }>();

export function rentRate(transport: Transport): Promise<RentSysvar> {
  const source = unmemoized(transport);
  const known = rentRates.get(source);
  const now = Date.now();
  if (known !== undefined && now - known.at < RENT_TTL_MS) {
    return known.pending;
  }
  const entry = { at: now, pending: readRent(source) };
  rentRates.set(source, entry);
  entry.pending.catch(() => {
    if (rentRates.get(source) === entry) {
      rentRates.delete(source);
    }
  });
  return entry.pending;
}

export const rentFor = (bytes: number, rent: RentSysvar): bigint => rentExemptFor(rent, bytes);

export function createCost(economics: { createFee: number; crankBounty: number }, rent: RentSysvar, vault = TOKEN_ACCOUNT_BYTES): bigint {
  return (
    BigInt(economics.createFee) +
    BigInt(economics.crankBounty) +
    rentFor(getIntentSize(), rent) +
    rentFor(vault, rent) +
    SIGNATURE_FEE
  );
}

export const relayCost = (economics: { createFee: number; crankBounty: number }, rent: RentSysvar): bigint => createCost(economics, rent) + SIGNATURE_FEE;

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
