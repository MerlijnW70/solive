import type { Address } from "@solana/kit";
import { type Job, JOBS_LIMIT, jobsOf, mintOf, openProofEscrows, type Transport } from "@intent-engine/client";

export type JobsWanted = { attestor?: Address | undefined; mint?: Address | undefined; minPay?: string | undefined };

export function leastUnits(tokens: string, decimals: number): bigint {
  const [whole = "0", fraction = ""] = tokens.split(".");
  const kept = fraction.slice(0, decimals).padEnd(decimals, "0");
  const finer = /[1-9]/.test(fraction.slice(decimals)) ? 1n : 0n;
  return BigInt(whole === "" ? "0" : whole) * 10n ** BigInt(decimals) + BigInt(kept === "" ? "0" : kept) + finer;
}

const latestFirst = (a: Job, b: Job) => (a.expiresAt === b.expiresAt ? 0 : a.expiresAt > b.expiresAt ? -1 : 1);

export async function jobsWanted(transport: Transport, { attestor, mint, minPay }: JobsWanted): Promise<Job[]> {
  if (minPay === undefined) {
    return jobsOf(transport, { attestor, mint });
  }
  const open = await openProofEscrows(transport, { attestor, mint }, Number.POSITIVE_INFINITY);
  const mints = [...new Set(open.map(({ intent }) => intent.inputMint))];
  const lists = await Promise.all(
    mints.map(async (each) => jobsOf(transport, { attestor, mint: each, minSells: leastUnits(minPay, (await mintOf(transport, each)).decimals) })),
  );
  return lists.flat().sort(latestFirst).slice(0, JOBS_LIMIT);
}
