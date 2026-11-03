import { type Address, getAddressDecoder } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Transport } from "@intent-engine/client";
import { findJobs, UNCHECKED_JOBS } from "../src/agent/jobs.js";
import { jobPage, type PageWanted } from "../src/job-pages.js";
import { JobReads, type Readable } from "../src/job-reads.js";

const stub = vi.hoisted(() => ({ proofs: [] as unknown[], historyReads: new Map<string, number>() }));

vi.mock("@intent-engine/client/internal", async (original) => ({
  ...(await original<typeof import("@intent-engine/client/internal")>()),
  openProofEscrows: async () => ({ proofs: stub.proofs, unreadable: [] }),
  specUrlOf: async (_: Transport, intent: string) => {
    stub.historyReads.set(intent, (stub.historyReads.get(intent) ?? 0) + 1);
    await new Promise((resolve) => setTimeout(resolve, 5));
    return `https://specs.example/${intent}`;
  },
  loadClaimsOf: async (_: unknown, intents: readonly unknown[]) => intents.map(() => null),
  mintOf: async () => ({ decimals: 0, freezeAuthority: null }),
  releaseNet: () => 90n,
}));

const addressOf = (seed: number): Address => getAddressDecoder().decode(new Uint8Array(32).fill(seed));
const proof = (seed: number, createdAt: bigint) => ({
  address: addressOf(seed),
  intent: { createdAt, expiresAt: 1_000n, owner: addressOf(201), inputMint: addressOf(200), nonce: BigInt(seed), feeBps: 0, escrowed: 100n, filled: 0n },
  params: { attestor: addressOf(202), specHash: new Uint8Array(32).fill(7), judgeFee: 0n },
});
const transport = {} as unknown as Transport;
const terms = {} as Parameters<typeof jobPage>[2];
const never = <T>() => new Promise<T>(() => undefined);
const wanted = (more: Partial<PageWanted> = {}): PageWanted => ({ limit: 5, all: false, ...more });

describe("the find_jobs follow-up", () => {
  beforeEach(() => {
    stub.proofs = [];
    stub.historyReads.clear();
  });

  it("describes a listed job whose spec is not read yet, and spec_url as null for more than a missing url", () => {
    expect(findJobs.description).not.toContain("whose spec this server can read");
    expect(findJobs.description).toContain("or null when none was found or it is not looked up yet");
    const output = JSON.stringify(findJobs.output.json);
    expect(output).toContain("or null when none was found or it is not looked up yet; untrusted");
    expect(output).not.toContain("where the owner published the spec, or null; untrusted");
  });

  it("says spec_checked is true only for the spec at spec_url that matches spec_hash", () => {
    expect(findJobs.description).toContain("spec_checked true only once this server has read the spec at its spec_url and that spec's sha256 equals spec_hash");
    expect(findJobs.description).not.toContain("a source serving it by spec_hash or a sealed spec this wallet can open, and it matches");
  });

  it("says in the unchecked hint and the description that a sealed job may not be for this wallet", () => {
    expect(UNCHECKED_JOBS).toContain("a job sealed to another wallet may turn out not to be for this wallet");
    expect(findJobs.description).toContain("one sealed to another wallet may turn out not to be for this wallet");
  });

  it("does not wait on a read when the head start is spent exactly", async () => {
    stub.proofs = [proof(1, 9n)];
    const waits: number[] = [];
    let clock = 0;
    const page = await jobPage(transport, wanted(), terms, () => never(), {
      reads: new JobReads(),
      headStartMs: 10,
      elapsed: () => (clock++ === 0 ? 0 : 10),
      pause: async (ms) => {
        waits.push(ms);
      },
    });
    expect(page.jobs).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it("reads each escrow's history once over a whole page with all, however often the page is asked for", async () => {
    stub.proofs = Array.from({ length: 8 }, (_, i) => proof(i + 1, BigInt(100 - i)));
    const readable: Readable = async () => true;
    const reads = new JobReads();
    const page = await jobPage(transport, wanted({ all: true, limit: 8 }), terms, readable, { reads, headStartMs: 1_000 });
    expect(page.jobs).toHaveLength(8);
    await jobPage(transport, wanted({ all: true, limit: 8 }), terms, readable, { reads, headStartMs: 1_000 });
    expect(page.jobs.every((job) => job.specUrl !== null)).toBe(true);
    expect([...stub.historyReads.values()]).toEqual(Array.from({ length: 8 }, () => 1));
    expect(stub.historyReads.size).toBe(8);
  });
});
