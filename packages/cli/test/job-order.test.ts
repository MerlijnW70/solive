import type { Address } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Job, Transport } from "@intent-engine/client";
import { jobsWanted, pricedJobs } from "../src/job-filters.js";

const listed = vi.hoisted(() => ({ jobs: new Map<string, unknown[]>(), open: [] as unknown[], pays: [] as unknown[], unreadable: [] as unknown[] }));

vi.mock("@intent-engine/client/internal", async (original) => ({
  ...(await original<typeof import("@intent-engine/client/internal")>()),
  jobsOf: async (_: unknown, { mint }: { mint?: string }) => ({ jobs: listed.jobs.get(mint ?? "") ?? [], unreadable: listed.unreadable }),
  openProofEscrows: async () => ({ proofs: listed.open, unreadable: listed.unreadable }),
  jobPays: async () => listed.pays,
  loadClaimsOf: async (_: unknown, intents: readonly unknown[]) => intents.map(() => null),
}));

const job = (intent: string, inputMint: string, expiresAt: bigint) => ({ intent: intent as Address, inputMint: inputMint as Address, expiresAt }) as unknown as Job;

const unused = {} as Transport;

describe("jobs across mints", () => {
  beforeEach(() => {
    listed.jobs.clear();
    listed.open = [];
    listed.pays = [];
    listed.unreadable = [];
  });

  it("lists the jobs of every mint latest first", async () => {
    listed.open = [{ intent: { inputMint: "a" } }, { intent: { inputMint: "b" } }];
    listed.jobs.set("a", [job("early", "a", 10n), job("late", "a", 40n)]);
    listed.jobs.set("b", [job("middle", "b", 20n), job("tied", "b", 20n)]);
    const found = await jobsWanted(unused, { minPay: "1" }, async () => 0);
    expect(found.jobs.map(({ intent }) => intent)).toEqual(["late", "middle", "tied", "early"]);
  });

  it("names an unreadable intent once though every mint's read skips it", async () => {
    listed.open = [{ intent: { inputMint: "a" } }, { intent: { inputMint: "b" } }];
    listed.unreadable = [{ address: "newer", reason: "a newer layout" }];
    listed.jobs.set("a", [job("early", "a", 10n)]);
    listed.jobs.set("b", [job("late", "b", 40n)]);
    expect((await jobsWanted(unused, { minPay: "1" }, async () => 0)).unreadable).toEqual([{ address: "newer", reason: "a newer layout" }]);
  });

  it("a job the pay reader leaves out reads as paying nothing", async () => {
    listed.jobs.set("", [job("unpriced", "a", 10n)]);
    expect((await pricedJobs(unused, {}, {} as Parameters<typeof pricedJobs>[2])).jobs).toStrictEqual([
      { ...job("unpriced", "a", 10n), pays: null, netPay: "0", payable: false, takesClaims: false, claimedBy: null, claimEnds: null, waiting: 0, freezeAuthority: null },
    ]);
  });
});
