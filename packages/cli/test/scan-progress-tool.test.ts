import { type Address, getAddressDecoder } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { tool } from "../src/agent/names.js";
import { findJobs, JOBS_FOUND, NO_JOB_NOW, readableBy, UNCHECKED_JOBS } from "../src/agent/jobs.js";
import { CLAIM_FIRST } from "../src/agent/job-claims.js";
import type { AgentContext } from "../src/agent/actions.js";
import { JobReads, type Readable } from "../src/job-reads.js";
import { agentServer } from "../src/agent/mcp.js";
import { getSpec } from "../src/agent/spec.js";
import { jobPage } from "../src/job-pages.js";
import type { Transport } from "@intent-engine/client";

const stub = vi.hoisted(() => ({ proofs: [] as unknown[], spec: (async () => null) as () => Promise<unknown> }));

vi.mock("@intent-engine/client/internal", async (original) => ({
  ...(await original<typeof import("@intent-engine/client/internal")>()),
  openProofEscrows: async () => ({ proofs: stub.proofs, unreadable: [] }),
  specUrlOf: async () => null,
  readSpec: () => stub.spec(),
  loadConfig: async () => ({ config: {} }),
  loadClaimsOf: async (_: unknown, intents: readonly unknown[]) => intents.map(() => null),
  mintOf: async () => ({ decimals: 0, freezeAuthority: null }),
  releaseNet: () => 90n,
}));

vi.mock("@intent-engine/core", async (original) => ({
  ...(await original<typeof import("@intent-engine/core")>()),
  feeBpsFor: () => 0,
}));

const addressOf = (seed: number): Address => getAddressDecoder().decode(new Uint8Array(32).fill(seed));

const proof = (seed: number, createdAt: bigint) => ({
  address: addressOf(seed),
  intent: { createdAt, expiresAt: 1_000n, owner: addressOf(201), inputMint: addressOf(200), nonce: BigInt(seed), feeBps: 0, escrowed: 100n, filled: 0n },
  params: { attestor: addressOf(202), specHash: new Uint8Array(32).fill(7), judgeFee: 0n },
});

const ctx = (jobReads = new JobReads()) => ({ transport: {} as unknown as Transport, url: "http://127.0.0.1:8899", specSources: [{ kind: "memo" }], jobReads }) as unknown as AgentContext;

type Answer = { jobs: { intent: Address; spec_checked: boolean }[]; next: string };

const verdictOf = (spec: unknown) => {
  stub.spec = async () => spec;
  return readableBy(ctx())({} as unknown as Transport, addressOf(1));
};

describe("find_jobs says which jobs it has not checked", () => {
  beforeEach(() => {
    stub.proofs = [];
    stub.spec = async () => null;
  });

  it("marks a job it has not read as unchecked and sends the agent to get_spec, never urging a claim", async () => {
    stub.proofs = [proof(1, 9n)];
    const answer = (await findJobs.run(ctx(new JobReads({ most: 0 })), {} as never, {} as never)) as Answer;
    expect(answer.jobs.map(({ intent, spec_checked }) => [intent, spec_checked])).toEqual([[addressOf(1), false]]);
    expect(answer.next).toBe(UNCHECKED_JOBS);
    expect(answer.next).toContain(`run ${tool("get_spec")} on its intent before taking it`);
    expect(answer.next).not.toContain(CLAIM_FIRST);
    expect(answer.next).not.toContain(tool("wallet_claim"));
  });

  it("marks a job whose plain spec matched as checked, with the usual next", async () => {
    stub.proofs = [proof(1, 9n)];
    stub.spec = async () => ({ source: "memo", matches: true, url: "https://specs.example/1" });
    const answer = (await findJobs.run(ctx(), {} as never, {} as never)) as Answer;
    expect(answer.jobs.map(({ spec_checked }) => spec_checked)).toEqual([true]);
    expect(answer.next).toBe(JOBS_FOUND);
  });

  it("says no job matches when none is listed", async () => {
    const answer = (await findJobs.run(ctx(), {} as never, {} as never)) as Answer;
    expect(answer.next).toBe(NO_JOB_NOW);
  });

  it("lets only a plain memo whose bytes match the pinned hash count as a read to keep", async () => {
    expect(await verdictOf({ source: "memo", matches: true, url: "u" })).toEqual({ plain: "u" });
    expect(await verdictOf({ source: "memo", matches: false, url: "u" })).toBe(true);
    expect(await verdictOf({ source: "memo", matches: true, url: "u", sealedTo: [addressOf(9)] })).toBe(true);
    expect(await verdictOf({ source: "mirror", matches: true, url: "u" })).toBe(true);
    expect(await verdictOf({ source: "cache", matches: true, url: "u" })).toBe(true);
    expect(await verdictOf(null)).toBe(false);
  });

  it("aborts the reads still running when the server closes", async () => {
    stub.proofs = [proof(1, 9n)];
    const reads = new JobReads();
    const signals: AbortSignal[] = [];
    const readable: Readable = (_, __, signal) => {
      signals.push(signal as AbortSignal);
      return new Promise(() => undefined);
    };
    await jobPage({} as unknown as Transport, { limit: 5, all: false }, {} as never, readable, { reads, headStartMs: 0 });
    expect(reads.running).toBe(1);
    await agentServer(ctx(reads), []).close();
    expect(signals.map((signal) => signal.aborted)).toEqual([true]);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(reads.running).toBe(0);
  });

  it("forgets a kept readable answer when get_spec then sees the escrow's spec sealed, or fails to read it", async () => {
    stub.proofs = [proof(1, 9n)];
    for (const later of [async () => ({ source: "memo", matches: true, url: "u", sealedTo: [addressOf(9)] }), async () => Promise.reject(new Error("gone"))]) {
      const reads = new JobReads();
      stub.spec = async () => ({ source: "memo", matches: true, url: "u" });
      await findJobs.run(ctx(reads), {} as never, {} as never);
      expect(reads.known({ intent: addressOf(1), createdAt: 9n, owner: addressOf(201), specHash: new Uint8Array(32).fill(7) }, false)).toEqual({ url: "u", checked: true });
      stub.spec = later;
      await getSpec.run(ctx(reads), { intent: addressOf(1) } as never, {} as never).catch(() => undefined);
      expect(reads.known({ intent: addressOf(1), createdAt: 9n, owner: addressOf(201), specHash: new Uint8Array(32).fill(7) }, false)).toEqual({ url: "u", checked: false });
    }
  });
});
