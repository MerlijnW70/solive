import { type Address, getAddressDecoder } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Transport } from "@intent-engine/client";
import { cursorText, jobPage, type PageWanted, type Readable, SCAN_BATCH } from "../src/job-pages.js";

const stub = vi.hoisted(() => ({ proofs: [] as unknown[] }));

vi.mock("@intent-engine/client/internal", async (original) => ({
  ...(await original<typeof import("@intent-engine/client/internal")>()),
  openProofEscrows: async () => ({ proofs: stub.proofs, unreadable: [] }),
  specUrlOf: async (transport: Transport, intent: string) => {
    await transport.signaturesOf?.(intent as Address, 1);
    return null;
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

const COUNT = 3 * SCAN_BATCH;

let calls = 0;

const transport = { signaturesOf: async () => {
    calls++;
    return [];
  },transactionsOf: async () => [] } as unknown as Transport;

const reading: Readable = async () => true;

const wanted: PageWanted = { limit: COUNT, all: true };

const terms = {} as Parameters<typeof jobPage>[2];

const clockFrom = (start: number, later: number) => {
  let first = true;
  return () => {
    const now = first ? start : later;
    first = false;
    return now;
  };
};

const never = () => new Promise<void>(() => undefined);

describe("find_jobs scan budget", () => {
  beforeEach(() => {
    stub.proofs = Array.from({ length: COUNT }, (_, i) => proof(i + 10, BigInt(i)));
    calls = 0;
  });

  it("keeps reading while a millisecond of a ten millisecond budget is spent, counted from a late start", async () => {
    const page = await jobPage(transport, wanted, terms, reading, { budgetMs: 10, elapsed: clockFrom(5_000, 5_001), pause: never });
    expect(page.jobs).toHaveLength(COUNT);
    expect(page.more).toBeUndefined();
    expect(calls).toBe(COUNT);
  });

  it("stops after one batch once exactly its whole budget is spent", async () => {
    const page = await jobPage(transport, wanted, terms, reading, { budgetMs: 10, elapsed: clockFrom(5_000, 5_010), pause: never });
    expect(page.jobs).toHaveLength(SCAN_BATCH);
    expect(calls).toBe(SCAN_BATCH);
    expect(page.more).toBe(cursorText({ createdAt: BigInt(COUNT - SCAN_BATCH), expiresAt: 1_000n, intent: addressOf(10 + COUNT - SCAN_BATCH) }));
  });
});
