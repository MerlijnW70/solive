import type { Address } from "@solana/kit";
import { formatAmount } from "@intent-engine/core";
import { type Job, type Transport } from "@intent-engine/client";
import {
  type JobClaim,
  jobClaimOf,
  type JobPay,
  jobPays,
  JOBS_LIMIT,
  jobsOf,
  loadClaimsOf,
  mintOf,
  type MintView,
  openProofEscrows,
  type PayTerms,
} from "@intent-engine/client/internal";

export type JobsWanted = {
  attestor?: Address | undefined;
  mint?: Address | undefined;
  minPay?: string | undefined;
  unclaimed?: boolean | undefined;
  owner?: Address | undefined;
  excludeOwners?: readonly Address[] | undefined;
};

export function leastUnits(tokens: string, decimals: number): bigint {
  const [whole = "0", fraction = ""] = tokens.split(".");
  const kept = fraction.slice(0, decimals).padEnd(decimals, "0");
  const finer = /[1-9]/.test(fraction.slice(decimals)) ? 1n : 0n;
  return BigInt(whole === "" ? "0" : whole) * 10n ** BigInt(decimals) + BigInt(kept === "" ? "0" : kept) + finer;
}

const latestFirst = (a: Job, b: Job) => (a.expiresAt === b.expiresAt ? 0 : Number(b.expiresAt - a.expiresAt));

export type DecimalsOf = (mint: Address) => Promise<number>;

export type MintsOf = (mint: Address) => Promise<MintView>;

export function mintsOnce(transport: Transport): MintsOf {
  const seen = new Map<Address, Promise<MintView>>();
  return (mint) => {
    const known = seen.get(mint) ?? mintOf(transport, mint);
    seen.set(mint, known);
    return known;
  };
}

export function decimalsOnce(transport: Transport, mintsOf: MintsOf = mintsOnce(transport)): DecimalsOf {
  return async (mint) => (await mintsOf(mint)).decimals;
}

export async function freezeAuthorityRead(read: Promise<MintView>): Promise<Address | null> {
  try {
    return (await read).freezeAuthority;
  } catch {
    return null;
  }
}

export const freezeWarning = (authority: Address, owner: Address): string =>
  authority === owner
    ? `the escrow's owner ${owner} holds the freeze authority of this job's token and can freeze the payment`
    : `${authority} holds the freeze authority of this job's token and can freeze the payment`;

export type FreezeFields = { freeze_authority: Address | null; freeze_warning?: string };

export const freezeFields = (authority: Address | null, owner: Address): FreezeFields =>
  authority === null ? { freeze_authority: null } : { freeze_authority: authority, freeze_warning: freezeWarning(authority, owner) };

export async function jobsWanted(
  transport: Transport,
  { attestor, mint, minPay, unclaimed, owner, excludeOwners }: JobsWanted,
  decimalsOf: DecimalsOf = decimalsOnce(transport),
): Promise<Job[]> {
  const owners = { owner, excludeOwners };
  if (minPay === undefined) {
    return jobsOf(transport, { attestor, mint, unclaimed, ...owners });
  }
  const open = await openProofEscrows(transport, { attestor, mint, ...owners }, Number.POSITIVE_INFINITY);
  const mints = [...new Set(open.map(({ intent }) => intent.inputMint))];
  const lists = await Promise.all(
    mints.map(async (each) => jobsOf(transport, { attestor, mint: each, minSells: leastUnits(minPay, await decimalsOf(each)), unclaimed, ...owners })),
  );
  return lists.flat().sort(latestFirst).slice(0, JOBS_LIMIT);
}

export type PricedJob = Job & JobPay & JobClaim & { pays: string | null; freezeAuthority: Address | null };

async function wholeTokens(raw: bigint, read: Promise<number>): Promise<string | null> {
  try {
    return formatAmount(raw, await read);
  } catch {
    return null;
  }
}

export async function pricedJobs(transport: Transport, wanted: JobsWanted, terms: PayTerms): Promise<PricedJob[]> {
  const mintsOf = mintsOnce(transport);
  const decimalsOf = decimalsOnce(transport, mintsOf);
  const jobs = await jobsWanted(transport, wanted, decimalsOf);
  const [pays, claims, freezes, whole] = await Promise.all([
    jobPays(transport, jobs, terms, decimalsOf),
    loadClaimsOf(transport, jobs.map(({ intent }) => intent)),
    Promise.all(jobs.map(({ inputMint }) => freezeAuthorityRead(mintsOf(inputMint)))),
    Promise.all(jobs.map(({ sells, inputMint }) => wholeTokens(sells, decimalsOf(inputMint)))),
  ]);
  return jobs.map((job, i) => ({
    ...job,
    pays: whole[i] ?? null,
    ...(pays[i] ?? { netPay: "0", payable: false }),
    ...jobClaimOf(claims[i] ?? null),
    freezeAuthority: freezes[i] ?? null,
  }));
}
