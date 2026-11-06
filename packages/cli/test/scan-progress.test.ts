import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type Address, getAddressDecoder } from "@solana/kit";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Transport } from "@intent-engine/client";
import { timedRpc } from "../src/main.js";
import { cursorOf, HEAD_START_MS, jobPage, type PageWanted } from "../src/job-pages.js";
import { DOUBT_KEPT_MS, JobReads, type JobReadsOptions, KEPT_MS, type Readable, READS_AT_ONCE, YOUNG_DOUBT_MS, YOUNG_JOB_SECONDS } from "../src/job-reads.js";

const stub = vi.hoisted(() => ({ proofs: [] as unknown[], history: new Map<string, () => Promise<string | null>>(), historyReads: new Map<string, number>() }));

vi.mock("@intent-engine/client/internal", async (original) => ({
  ...(await original<typeof import("@intent-engine/client/internal")>()),
  openProofEscrows: async () => ({ proofs: stub.proofs, unreadable: [] }),
  specUrlOf: async (_: Transport, intent: string) => {
    stub.historyReads.set(intent, (stub.historyReads.get(intent) ?? 0) + 1);
    return (await stub.history.get(intent)?.()) ?? null;
  },
  loadClaimsOf: async (_: unknown, intents: readonly unknown[]) => intents.map(() => null),
  mintOf: async () => ({ decimals: 0, freezeAuthority: null }),
  releaseNet: () => 90n,
}));

const addressOf = (seed: number): Address => getAddressDecoder().decode(new Uint8Array(32).fill(seed));

const proof = (seed: number, createdAt: bigint, hash = 7) => ({
  address: addressOf(seed),
  intent: { createdAt, expiresAt: 1_000n, owner: addressOf(201), inputMint: addressOf(200), nonce: BigInt(seed), feeBps: 0, escrowed: 100n, filled: 0n },
  params: { attestor: addressOf(202), specHash: new Uint8Array(32).fill(hash), judgeFee: 0n },
});

const transport = {} as unknown as Transport;
const terms = {} as Parameters<typeof jobPage>[2];
const never = <T>() => new Promise<T>(() => undefined);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const timed = (waits: number[] = []) => {
  let clock = 0;
  return {
    elapsed: () => ++clock,
    pause: async (ms: number) => {
      waits.push(ms);
      await tick();
      clock += ms;
    },
  };
};
const intents = (page: { jobs: { intent: Address }[] }) => page.jobs.map(({ intent }) => intent);
const checked = (page: { jobs: { intent: Address; specChecked: boolean }[] }) => page.jobs.filter((job) => job.specChecked).map(({ intent }) => intent);
const wanted = (more: Partial<PageWanted> = {}): PageWanted => ({ limit: 5, all: false, ...more });
const plain = (intent: Address) => ({ plain: "https://" + "specs.example/" + intent });
const call = (reads: JobReads, readable: Readable, more: Partial<PageWanted> = {}, waits?: number[]) => jobPage(transport, wanted(more), terms, readable, { reads, ...timed(waits) });
const settle = async () => {
  for (let i = 0; i < 5; i++) {
    await tick();
  }
};

async function followed(page: (after?: PageWanted["after"]) => ReturnType<typeof jobPage>) {
  const found: Address[] = [];
  let more: string | undefined;
  let calls = 0;
  do {
    const answer = await page(more === undefined ? undefined : (cursorOf(more) ?? undefined));
    expect(answer.more === undefined || answer.more !== more).toBe(true);
    found.push(...intents(answer));
    more = answer.more;
    calls++;
  } while (more !== undefined && calls < 100);
  return { found, calls };
}

describe("find_jobs lists jobs whatever their reads do", () => {
  beforeEach(() => {
    stub.proofs = [];
    stub.history.clear();
    stub.historyReads.clear();
  });

  for (const all of [false, true]) {
    it(`finds every older readable job on the first walk behind more never-ending newer jobs than reads at once, all ${all}`, async () => {
      const junk = READS_AT_ONCE + 4;
      stub.proofs = [...Array.from({ length: junk }, (_, i) => proof(i + 1, BigInt(1_000 - i))), proof(101, 5n), proof(102, 4n), proof(103, 3n)];
      for (let seed = 1; seed <= junk; seed++) {
        stub.history.set(addressOf(seed), never);
      }
      const older = new Set([addressOf(101), addressOf(102), addressOf(103)]);
      const readable: Readable = (_, intent) => (older.has(intent) ? Promise.resolve(plain(intent)) : never());
      const reads = new JobReads();
      for (let round = 0; round < 3; round++) {
        const { found, calls } = await followed((after) => jobPage(transport, wanted({ all, after }), terms, readable, { reads, ...timed() }));
        expect(found.slice(-3)).toEqual([...older]);
        expect(found).toHaveLength(junk + 3);
        expect(calls).toBe(Math.ceil((junk + 3) / 5));
      }
      expect(reads.busy).toBeLessThanOrEqual(READS_AT_ONCE);
    });
  }

  it("lists a head job whose read never ends as not checked, with the jobs after it, on the first call", async () => {
    stub.proofs = [proof(1, 9n), proof(2, 8n), proof(3, 7n)];
    const readable: Readable = (_, intent) => (intent === addressOf(1) ? never() : Promise.resolve(plain(intent)));
    const page = await call(new JobReads(), readable, { limit: 2 });
    expect(intents(page)).toEqual([addressOf(1), addressOf(2)]);
    expect(checked(page)).toEqual([addressOf(2)]);
    expect(page.jobs[0]).toMatchObject({ specChecked: false, specUrl: null });
    expect(cursorOf(page.more ?? "")?.intent).toBe(addressOf(2));
  });

  it("waits at most its head start once a call, then lists", async () => {
    stub.proofs = Array.from({ length: 12 }, (_, i) => proof(i + 1, BigInt(100 - i)));
    const waits: number[] = [];
    const page = await call(new JobReads(), () => never(), { limit: 12 }, waits);
    expect(page.jobs).toHaveLength(12);
    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(HEAD_START_MS);
  });

  it("drops a job its head start proves unreadable and fills the page from the jobs after it", async () => {
    stub.proofs = [proof(1, 9n), proof(2, 8n), proof(3, 7n)];
    const readable: Readable = async (_, intent) => (intent === addressOf(1) ? false : plain(intent));
    const page = await call(new JobReads(), readable, { limit: 2 });
    expect(intents(page)).toEqual([addressOf(2), addressOf(3)]);
    expect(page.more).toBeUndefined();
  });

  it("keeps limit and the cursor over known jobs", async () => {
    stub.proofs = Array.from({ length: 7 }, (_, i) => proof(i + 1, BigInt(100 - i)));
    const reads = new JobReads();
    const readable: Readable = async (_, intent) => plain(intent);
    const { found, calls } = await followed((after) => call(reads, readable, { limit: 3, after }));
    expect(found).toEqual(Array.from({ length: 7 }, (_, i) => addressOf(i + 1)));
    expect(calls).toBe(3);
  });

  it("lists a slow readable job as checked on a later call with no new read", async () => {
    stub.proofs = [proof(1, 9n)];
    let finish: (verdict: { plain: string }) => void = () => undefined;
    const readable = vi.fn<Readable>(() => new Promise((resolve) => (finish = resolve)));
    const reads = new JobReads();
    expect(checked(await call(reads, readable))).toEqual([]);
    finish(plain(addressOf(1)));
    await settle();
    const later = await call(reads, readable);
    expect(checked(later)).toEqual([addressOf(1)]);
    expect(later.jobs[0]?.specUrl).toBe("https://" + "specs.example/" + addressOf(1));
    expect(readable).toHaveBeenCalledTimes(1);
  });

  it("joins a read still running rather than starting another", async () => {
    stub.proofs = [proof(1, 9n)];
    const readable = vi.fn<Readable>(() => never());
    const reads = new JobReads();
    await call(reads, readable);
    await call(reads, readable);
    expect(readable).toHaveBeenCalledTimes(1);
    expect(reads.busy).toBe(1);
  });

  it("hides a known unreadable job with no wait and no new read", async () => {
    stub.proofs = [proof(1, 9n)];
    const readable = vi.fn<Readable>(async () => false);
    const reads = new JobReads();
    await call(reads, readable);
    const waits: number[] = [];
    expect((await call(reads, readable, {}, waits)).jobs).toEqual([]);
    expect(waits).toEqual([]);
    expect(readable).toHaveBeenCalledTimes(1);
  });

  it("keeps outcomes per escrow, so of two escrows with one hash the sealed one stays out", async () => {
    stub.proofs = [proof(1, 9n), proof(2, 8n)];
    const readable = vi.fn<Readable>(async (_, intent) => (intent === addressOf(1) ? plain(intent) : false));
    const reads = new JobReads();
    for (let round = 0; round < 2; round++) {
      const page = await call(reads, readable);
      expect(intents(page)).toEqual([addressOf(1)]);
      expect(checked(page)).toEqual([addressOf(1)]);
    }
    expect(readable).toHaveBeenCalledTimes(2);
  });

  it("keeps nothing for a sealed spec this wallet opened, a copy or a spec that does not match: it stays unchecked and is read again", async () => {
    stub.proofs = [proof(1, 9n)];
    const readable = vi.fn<Readable>(async () => true);
    const reads = new JobReads();
    for (let round = 1; round <= 2; round++) {
      const page = await call(reads, readable);
      expect(intents(page)).toEqual([addressOf(1)]);
      expect(checked(page)).toEqual([]);
      expect(readable).toHaveBeenCalledTimes(round);
    }
  });

  it("drops a kept readable answer once another read of that escrow sees something else", async () => {
    stub.proofs = [proof(1, 9n), proof(2, 8n)];
    const readable = vi.fn<Readable>(async (_, intent) => plain(intent));
    const reads = new JobReads();
    await call(reads, readable);
    reads.saw(addressOf(2), { source: "cache", matches: true });
    reads.saw(addressOf(1), { source: "memo", matches: true, sealedTo: [addressOf(9)] });
    expect(checked(await call(reads, vi.fn<Readable>(() => never())))).toEqual([addressOf(2)]);
    for (const seen of [null, { source: "memo", matches: false }, { source: "mirror", matches: true }]) {
      const fresh = new JobReads();
      await call(fresh, readable);
      expect(checked(await call(fresh, readable))).toEqual([addressOf(1), addressOf(2)]);
      fresh.saw(addressOf(2), seen);
      expect(checked(await call(fresh, vi.fn<Readable>(() => never())))).toEqual([addressOf(1)]);
    }
  });

  it("keeps nothing from a failed read: the job stays listed unchecked and is read again", async () => {
    stub.proofs = [proof(1, 9n)];
    const readable = vi.fn<Readable>(async () => {
      throw new Error("HTTP error (429): Too Many Requests");
    });
    const reads = new JobReads();
    for (let round = 1; round <= 2; round++) {
      expect(intents(await call(reads, readable))).toEqual([addressOf(1)]);
      await settle();
      expect(readable).toHaveBeenCalledTimes(round);
    }
    expect(reads.busy).toBe(0);
  });

  it("does not re-read the history all learned, so all asks it once per escrow", async () => {
    stub.proofs = [proof(1, 9n)];
    stub.history.set(addressOf(1), async () => "https://specs.example/1");
    const reads = new JobReads();
    for (let round = 0; round < 3; round++) {
      expect((await call(reads, async () => false, { all: true })).jobs[0]?.specUrl).toBe("https://specs.example/1");
    }
    expect(stub.historyReads.get(addressOf(1))).toBe(1);
  });

  it("doubts a job too young for its history to have settled only briefly", async () => {
    let now = 1_000_000_000_000;
    stub.proofs = [proof(1, BigInt(now / 1000) - YOUNG_JOB_SECONDS)];
    const readable = vi.fn<Readable>(async () => false);
    const reads = new JobReads({ now: () => now, elapsed: () => now });
    expect((await call(reads, readable)).jobs).toEqual([]);
    now += YOUNG_DOUBT_MS - 1;
    expect((await call(reads, vi.fn<Readable>(() => never()))).jobs).toEqual([]);
    now += 1;
    readable.mockImplementation(async (_, intent) => plain(intent));
    expect(checked(await call(reads, readable))).toEqual([addressOf(1)]);
  });

  it("keeps no answer of no url, so history that arrives later is read", async () => {
    stub.proofs = [proof(1, 9n)];
    const reads = new JobReads();
    expect((await call(reads, async () => false, { all: true })).jobs[0]?.specUrl).toBe(null);
    stub.history.set(addressOf(1), async () => "https://specs.example/1");
    expect((await call(reads, async () => false, { all: true })).jobs[0]?.specUrl).toBe("https://specs.example/1");
  });

  it("learns the url of a job it reads, even when its spec only reads from a copy", async () => {
    stub.proofs = [proof(1, 9n)];
    stub.history.set(addressOf(1), async () => "https://specs.example/gone");
    const page = await call(new JobReads(), async () => true);
    expect(page.jobs[0]).toMatchObject({ specUrl: "https://specs.example/gone", specChecked: false });
  });

  it("keeps within its count bound, dropping the oldest", async () => {
    stub.proofs = Array.from({ length: 5 }, (_, i) => proof(i + 1, BigInt(100 - i)));
    const readable = vi.fn<Readable>(async (_, intent) => plain(intent));
    const reads = new JobReads({ kept: 3 });
    await call(reads, readable);
    expect(reads.keptJobs).toBe(3);
    stub.proofs = [proof(1, 100n)];
    await call(reads, readable);
    expect(readable).toHaveBeenCalledTimes(6);
  });

  it("forgets by age, doubts sooner than it trusts", async () => {
    stub.proofs = [proof(1, 9n), proof(2, 8n)];
    let now = 0;
    const readable = vi.fn<Readable>(async (_, intent) => (intent === addressOf(1) ? plain(intent) : false));
    const reads = new JobReads({ now: () => now, elapsed: () => now });
    await call(reads, readable);
    expect(readable).toHaveBeenCalledTimes(2);
    now = DOUBT_KEPT_MS;
    await call(reads, readable);
    expect(readable).toHaveBeenCalledTimes(3);
    now = KEPT_MS;
    await call(reads, readable);
    expect(readable).toHaveBeenCalledTimes(5);
  });

  it("forgets by elapsed time, whatever the wall clock does meanwhile", async () => {
    stub.proofs = [proof(1, 9n), proof(2, 8n)];
    let elapsed = 0;
    let wall = 0;
    const readable = vi.fn<Readable>(async (_, intent) => (intent === addressOf(1) ? plain(intent) : false));
    const reads = new JobReads({ now: () => wall, elapsed: () => elapsed });
    await call(reads, readable);
    expect(readable).toHaveBeenCalledTimes(2);
    wall += KEPT_MS * 10;
    await call(reads, readable);
    expect(readable).toHaveBeenCalledTimes(2);
    wall -= KEPT_MS * 20;
    elapsed = DOUBT_KEPT_MS;
    await call(reads, readable);
    expect(readable).toHaveBeenCalledTimes(3);
    wall += KEPT_MS * 30;
    elapsed = KEPT_MS;
    await call(reads, readable);
    expect(readable).toHaveBeenCalledTimes(5);
  });

  it("runs no more reads at once than its bound and starts none past it", async () => {
    stub.proofs = Array.from({ length: READS_AT_ONCE + 8 }, (_, i) => proof(i + 1, BigInt(100 - i)));
    const readable = vi.fn<Readable>(() => never());
    const reads = new JobReads();
    const { found } = await followed((after) => call(reads, readable, { after }));
    expect(found).toHaveLength(READS_AT_ONCE + 8);
    expect(reads.busy).toBe(READS_AT_ONCE);
    expect(readable).toHaveBeenCalledTimes(READS_AT_ONCE);
  });

  describe("bounds of one read", () => {
    const bounded = (more: JobReadsOptions = {}) => {
      const stop = new AbortController();
      const request = new AbortController();
      let answer: (value: unknown) => void = () => undefined;
      const asked = new Promise((resolve) => (answer = resolve));
      let askedTimes = 0;
      const late = {
        getAccount: () => {
          askedTimes++;
          return asked;
        },
      } as unknown as Transport;
      const reads = new JobReads({ bound: () => stop.signal, requestBound: () => request.signal, ...more });
      return { stop, request, answer: (value: unknown) => answer(value), late, reads, asks: () => askedTimes };
    };

    for (const late of [false, { plain: "https://specs.example/late" }] as const) {
      it(`keeps no answer, ${late === false ? "unreadable" : "readable"}, that arrives after the bound`, async () => {
        stub.proofs = [proof(1, 9n)];
        const { stop, reads } = bounded();
        let finish: (verdict: false | { plain: string }) => void = () => undefined;
        const readable = vi.fn<Readable>(() => new Promise((resolve) => (finish = resolve)));
        await call(reads, readable);
        stop.abort();
        finish(late);
        await settle();
        const after = await jobPage(transport, wanted(), terms, vi.fn<Readable>(() => never()), { reads, ...timed() });
        expect(intents(after)).toEqual([addressOf(1)]);
        expect(checked(after)).toEqual([]);
      });
    }

    it("asks nothing more once the bound passed, and frees its place only when its request ends", async () => {
      stub.proofs = [proof(1, 9n)];
      const { stop, answer, late, reads, asks } = bounded();
      let reached: Transport | undefined;
      const readable = vi.fn<Readable>((reach) => {
        reached = reach;
        void reach.getAccount(addressOf(9)).catch(() => undefined);
        return never();
      });
      await jobPage(late, wanted(), terms, readable, { reads, ...timed() });
      stop.abort();
      await settle();
      expect(reads.running).toBe(0);
      expect(reads.busy).toBe(1);
      const before = asks();
      await expect(reached?.getAccount(addressOf(9))).rejects.toThrow("bound");
      expect(asks()).toBe(before);
      answer(null);
      await settle();
      expect(reads.busy).toBe(0);
    });

    it("frees the place of a node request that never answers once that request's own bound passes", async () => {
      stub.proofs = [proof(1, 9n)];
      const { request, late, reads } = bounded();
      const readable = vi.fn<Readable>(async (reach) => {
        await reach.getAccount(addressOf(9));
        return plain(addressOf(1));
      });
      await jobPage(late, wanted(), terms, readable, { reads, ...timed() });
      expect(reads.busy).toBe(1);
      request.abort();
      await settle();
      expect(reads.busy).toBe(0);
      expect(reads.running).toBe(0);
    });

    it("aborts every read when closed, keeps nothing they learn after, and starts no more", async () => {
      stub.proofs = [proof(1, 9n), proof(2, 8n)];
      const signals: AbortSignal[] = [];
      const finishes: (() => void)[] = [];
      const readable = vi.fn<Readable>(
        (_, intent, signal) =>
          new Promise((resolve) => {
            signals.push(signal as AbortSignal);
            finishes.push(() => resolve(plain(intent)));
          }),
      );
      const reads = new JobReads();
      await call(reads, readable);
      expect(reads.running).toBe(2);
      reads.close();
      expect(signals.map((signal) => signal.aborted)).toEqual([true, true]);
      await settle();
      expect(reads.running).toBe(0);
      expect(reads.busy).toBe(0);
      for (const finish of finishes) {
        finish();
      }
      await settle();
      const after = await call(reads, readable);
      expect(checked(after)).toEqual([]);
      expect(readable).toHaveBeenCalledTimes(2);
      expect(reads.running).toBe(0);
    });
  });

  it("bounds every node request the CLI makes, so a node that never answers cannot hold a read", async () => {
    const server = createServer(() => undefined);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const { port } = server.address() as AddressInfo;
      const rpc = timedRpc("http://" + "127.0.0.1:" + port, 50) as unknown as { getSlot(): { send(): Promise<unknown> } };
      const began = performance.now();
      await expect(rpc.getSlot().send()).rejects.toThrow();
      expect(performance.now() - began).toBeLessThan(5_000);
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});
