import type { Address } from "@solana/kit";
import { type Job, type JobPay, jobPays, JOBS_LIMIT, jobsOf, mintOf, openProofEscrows, type PayTerms, type Transport } from "@intent-engine/client";

export type JobsWanted = { attestor?: Address | undefined; mint?: Address | undefined; minPay?: string | undefined };

export function leastUnits(tokens: string, decimals: number): bigint {
  const [whole = "0", fraction = ""] = tokens.split(".");
  const kept = fraction.slice(0, decimals).padEnd(decimals, "0");
  const finer = /[1-9]/.test(fraction.slice(decimals)) ? 1n : 0n;
  return BigInt(whole === "" ? "0" : whole) * 10n ** BigInt(decimals) + BigInt(kept === "" ? "0" : kept) + finer;
}

const latestFirst = (a: Job, b: Job) => (a.expiresAt === b.expiresAt ? 0 : a.expiresAt > b.expiresAt ? -1 : 1);

export type DecimalsOf = (mint: Address) => Promise<number>;

export function decimalsOnce(transport: Transport): DecimalsOf {
  const seen = new Map<Address, Promise<number>>();
  return (mint) => {
    const known = seen.get(mint) ?? mintOf(transport, mint).then(({ decimals }) => decimals);
    seen.set(mint, known);
    return known;
  };
}

export async function jobsWanted(
  transport: Transport,
  { attestor, mint, minPay }: JobsWanted,
  decimalsOf: DecimalsOf = decimalsOnce(transport),
): Promise<Job[]> {
  if (minPay === undefined) {
    return jobsOf(transport, { attestor, mint });
  }
  const open = await openProofEscrows(transport, { attestor, mint }, Number.POSITIVE_INFINITY);
  const mints = [...new Set(open.map(({ intent }) => intent.inputMint))];
  const lists = await Promise.all(
    mints.map(async (each) => jobsOf(transport, { attestor, mint: each, minSells: leastUnits(minPay, await decimalsOf(each)) })),
  );
  return lists.flat().sort(latestFirst).slice(0, JOBS_LIMIT);
}

export async function pricedJobs(transport: Transport, wanted: JobsWanted, terms: PayTerms): Promise<(Job & JobPay)[]> {
  const decimalsOf = decimalsOnce(transport);
  const jobs = await jobsWanted(transport, wanted, decimalsOf);
  const pays = await jobPays(transport, jobs, terms, decimalsOf);
  return jobs.map((job, i) => ({ ...job, ...(pays[i] ?? { netPay: "0", payable: false }) }));
}
