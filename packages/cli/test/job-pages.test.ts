import { type Address, getAddressDecoder } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ListedSignature, Transport } from "@intent-engine/client";
import { type Cursor, cursorOf, cursorText, FIND_DEFAULT, historyOnce, jobPage, type PageWanted, type Readable, SCAN_BATCH } from "../src/job-pages.js";

const stub = vi.hoisted(() => ({ proofs: [] as unknown[], urls: new Map<string, string>() }));

vi.mock("@intent-engine/client/internal", async (original) => ({
  ...(await original<typeof import("@intent-engine/client/internal")>()),
  openProofEscrows: async () => ({ proofs: stub.proofs, unreadable: [] }),
  specUrlOf: async (transport: Transport, intent: string) => {
    await transport.signaturesOf?.(intent as Address, 1);
    return stub.urls.get(intent) ?? null;
  },
  loadClaimsOf: async (_: unknown, intents: readonly unknown[]) => intents.map(() => null),
  mintOf: async () => ({ decimals: 0, freezeAuthority: null }),
  releaseNet: () => 90n,
}));

const addressOf = (seed: number): Address => getAddressDecoder().decode(new Uint8Array(32).fill(seed));

const MINT = addressOf(200);

const proof = (seed: number, createdAt: bigint) => ({
  address: addressOf(seed),
  intent: { createdAt, expiresAt: 1_000n, owner: addressOf(201), inputMint: MINT, nonce: BigInt(seed), feeBps: 0, escrowed: 100n, filled: 0n },
  params: { attestor: addressOf(202), specHash: new Uint8Array(32).fill(7), judgeFee: 0n },
});

type Counted = { transport: Transport; calls: () => number; widest: () => number };

function counted(): Counted {
  let calls = 0;
  let open = 0;
  let widest = 0;
  const signaturesOf = async (): Promise<ListedSignature[]> => {
    calls++;
    open++;
    widest = Math.max(widest, open);
    await new Promise((resolve) => setTimeout(resolve, 1));
    open--;
    return [];
  };
  const transport = { signaturesOf, transactionsOf: async () => [] } as unknown as Transport;
  return { transport, calls: () => calls, widest: () => widest };
}

const reading: Readable = async (transport, intent) => {
  await transport.signaturesOf?.(intent, 1);
  return intent !== addressOf(3);
};

const wanted = (more: Partial<PageWanted> = {}): PageWanted => ({ limit: FIND_DEFAULT, all: false, ...more });

const terms = {} as Parameters<typeof jobPage>[2];

const intents = (page: { jobs: { intent: Address }[] }) => page.jobs.map(({ intent }) => intent);

describe("find_jobs pages", () => {
  beforeEach(() => {
    stub.proofs = [];
    stub.urls.clear();
  });

  it("lists by default only jobs whose spec reads, newest first, and every job with all", async () => {
    stub.proofs = [proof(1, 10n), proof(2, 30n), proof(3, 20n)];
    stub.urls.set(addressOf(2), "https://specs.example/2");
    stub.urls.set(addressOf(3), "https://specs.example/3");
    const { transport } = counted();
    const page = await jobPage(transport, wanted(), terms, reading);
    expect(intents(page)).toEqual([addressOf(2)]);
    expect(page.jobs[0]).toMatchObject({ specUrl: "https://specs.example/2", pays: "100", netPay: "90", payable: true });
    expect(page.more).toBeUndefined();
    expect(intents(await jobPage(transport, wanted({ all: true }), terms, reading))).toEqual([addressOf(2), addressOf(3), addressOf(1)]);
  });

  it("stops at the limit and the cursor lists the rest once", async () => {
    stub.proofs = [1, 2, 3, 4, 5, 6, 7].map((seed) => proof(seed + 10, BigInt(seed)));
    const { transport } = counted();
    const seen: Address[] = [];
    let after: Cursor | undefined;
    const pages: number[] = [];
    do {
      const page = await jobPage(transport, wanted({ all: true, limit: 3, after }), terms, reading);
      seen.push(...intents(page));
      pages.push(page.jobs.length);
      const next = page.more === undefined ? undefined : cursorOf(page.more);
      expect(next).not.toBeNull();
      after = next ?? undefined;
    } while (after !== undefined);
    expect(pages).toEqual([3, 3, 1]);
    expect(seen).toEqual([7, 6, 5, 4, 3, 2, 1].map((seed) => addressOf(seed + 10)));
  });

  it("reads in batches no wider than the bound and no further than the limit needs", async () => {
    stub.proofs = Array.from({ length: 20 }, (_, i) => proof(i + 30, BigInt(i)));
    for (const { address } of stub.proofs as { address: Address }[]) {
      stub.urls.set(address, "https://specs.example/" + address);
    }
    const full = counted();
    await jobPage(full.transport, wanted({ all: true, limit: 20 }), terms, reading);
    expect(full.widest()).toBeLessThanOrEqual(SCAN_BATCH);
    expect(full.calls()).toBe(20);
    const short = counted();
    const page = await jobPage(short.transport, wanted({ limit: 2 }), terms, reading);
    expect(page.jobs).toHaveLength(2);
    expect(short.calls()).toBe(SCAN_BATCH);
    expect(page.more).toBe(cursorText({ createdAt: 18n, expiresAt: 1_000n, intent: addressOf(48) }));
  });

  it("stops reading when its time runs out and hands back a cursor", async () => {
    stub.proofs = Array.from({ length: 12 }, (_, i) => proof(i + 60, BigInt(i)));
    const { transport, calls } = counted();
    let clock = 0;
    const page = await jobPage(transport, wanted(), terms, reading, { budgetMs: 10, elapsed: () => (clock += 11), pause: () => new Promise(() => undefined) });
    expect(calls()).toBe(SCAN_BATCH);
    expect(page.jobs).toEqual([]);
    expect(page.more).toBe(cursorText({ createdAt: BigInt(12 - SCAN_BATCH), expiresAt: 1_000n, intent: addressOf(60 + 12 - SCAN_BATCH) }));
  });

  it("answers when a batch stalls past its time, with a cursor that reads the same jobs again", async () => {
    stub.proofs = [proof(80, 5n), proof(81, 4n)];
    const stalled = { signaturesOf: () => new Promise(() => undefined), transactionsOf: async () => [] } as unknown as Transport;
    const page = await jobPage(stalled, wanted({ all: true }), terms, reading, { pause: async () => undefined });
    expect(page.jobs).toEqual([]);
    const after = cursorOf(page.more ?? "");
    expect(after).not.toBeNull();
    const { transport } = counted();
    expect(intents(await jobPage(transport, wanted({ all: true, after: after ?? undefined }), terms, reading))).toEqual([addressOf(80), addressOf(81)]);
  });

  it("keeps the jobs a stalled batch read in order before its time ran out", async () => {
    stub.proofs = [proof(84, 9n), proof(85, 8n), proof(86, 7n), proof(87, 6n)];
    const answered = new Set([addressOf(84), addressOf(85), addressOf(87)]);
    const partial = {
      signaturesOf: (of: Address) => (answered.has(of) ? Promise.resolve([]) : new Promise(() => undefined)),
      transactionsOf: async () => [],
    } as unknown as Transport;
    const page = await jobPage(partial, wanted({ all: true }), terms, reading, { pause: () => new Promise((resolve) => setTimeout(resolve, 20)) });
    expect(intents(page)).toEqual([addressOf(84), addressOf(85)]);
    expect(page.more).toBe(cursorText({ createdAt: 8n, expiresAt: 1_000n, intent: addressOf(85) }));
  });

  it("does not ask for an older page after a short page, and reads each page once", async () => {
    const intent = addressOf(90);
    const signaturesOf = vi.fn(async (_: Address, limit: number): Promise<ListedSignature[]> =>
      Array.from({ length: limit === 1 ? 1 : 2 }, (_, i) => ({ signature: `s${i}`, slot: 1n, blockTime: 50n, failed: false, memo: null }) as unknown as ListedSignature),
    );
    const shared = historyOnce({ signaturesOf, transactionsOf: async () => [] } as unknown as Transport);
    await shared.signaturesOf?.(intent, 1_000);
    await shared.signaturesOf?.(intent, 1_000);
    expect(await shared.signaturesOf?.(intent, 1_000, "s1")).toEqual([]);
    expect(signaturesOf).toHaveBeenCalledTimes(1);
    await shared.signaturesOf?.(intent, 1);
    await shared.signaturesOf?.(intent, 1, "s0");
    expect(signaturesOf).toHaveBeenCalledTimes(3);
  });

  it("refuses a cursor it did not write", () => {
    expect(cursorOf("next page")).toBeNull();
    expect(cursorOf("1.2.3")).toBeNull();
    const cursor = { createdAt: 5n, expiresAt: 9n, intent: addressOf(4) };
    expect(cursorOf(cursorText(cursor))).toEqual(cursor);
  });
});
