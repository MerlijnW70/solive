import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import type { EngineTransaction, ListedSignature, Transport } from "../src/index.js";
import { DELIVERY_SCAN, scan, SIGNATURE_PAGE, signaturePage, transactionAt } from "../src/job-scan.js";
import { testSignature } from "../src/testing.js";
import { key, tx } from "./kill-client-jobs-ledger-kit.js";

const OF = key(4);

const fallback = (found: EngineTransaction[]) => {
  const asked: { limit: number; of: Address | undefined }[] = [];
  const transport = {
    engineTransactions: async (limit: number, of?: Address) => {
      asked.push({ limit, of });
      return found;
    },
  } as unknown as Transport;
  return { transport, asked };
};

const listed = (seed: string, patch: Partial<ListedSignature> = {}): ListedSignature => ({ signature: testSignature(seed), slot: 1n, blockTime: null, failed: false, memo: null, ...patch });

const paged = (pages: ListedSignature[][]) => {
  const lists: { limit: number; before: string | undefined }[] = [];
  const fetched: string[][] = [];
  let at = 0;
  const transport = {
    signaturesOf: async (_of: Address, limit: number, before?: string) => {
      lists.push({ limit, before });
      return pages[at++] ?? [];
    },
    transactionsOf: async (wanted: readonly ListedSignature[]) => {
      fetched.push(wanted.map(({ signature }) => signature));
      return wanted.map(({ signature, slot, blockTime }) => ({ signature, slot, blockTime, failed: false, emitted: [] }));
    },
  } as unknown as Transport;
  return { transport, lists, fetched };
};

const signatures = (transactions: readonly { signature: string }[]) => transactions.map(({ signature }) => signature);

describe("a delivery scan over the transaction log", () => {
  it("skips a failed transaction even when no memo is asked for", async () => {
    const [failed, landed] = [tx("failed", { failed: true }), tx("landed")];
    const { transport, asked } = fallback([failed, landed]);
    expect(await scan(transport, OF)).toStrictEqual({ transactions: [landed], complete: false, pages: 1 });
    expect(asked).toStrictEqual([{ limit: DELIVERY_SCAN, of: OF }]);
  });

  it("stops at the transaction the caller waits for, and calls that scan complete", async () => {
    const [a, b, c] = [tx("a"), tx("b"), tx("c")];
    const { transport } = fallback([a, b, c]);
    const result = await scan(transport, OF, { until: (found) => found.signature === b.signature });
    expect(result).toStrictEqual({ transactions: [a, b], complete: true, pages: 1 });
  });

  it("is complete when the node says its history is covered, and not when it does not", async () => {
    const found = [tx("a"), tx("b"), tx("c")];
    expect(await scan(fallback(found).transport, OF, { covered: async () => true })).toStrictEqual({ transactions: found, complete: true, pages: 1 });
    expect(await scan(fallback(found).transport, OF, { covered: async () => false })).toStrictEqual({ transactions: found, complete: false, pages: 1 });
    expect(await scan(fallback(found).transport, OF)).toStrictEqual({ transactions: found, complete: false, pages: 1 });
  });

  it("is complete once it reaches a transaction older than the floor", async () => {
    const [recent, old] = [tx("recent", { blockTime: 10n }), tx("old", { blockTime: 5n })];
    expect(await scan(fallback([recent, old]).transport, OF, { floor: 8n })).toStrictEqual({ transactions: [recent], complete: true, pages: 1 });
  });

  it("never calls a full page of the fallback complete, even with covered history", async () => {
    const found = Array.from({ length: DELIVERY_SCAN }, (_, i) => tx(`full-${i}`));
    const result = await scan(fallback(found).transport, OF, { covered: async () => true });
    expect([result.transactions.length, result.complete, result.pages]).toStrictEqual([DELIVERY_SCAN, false, 1]);
  });
});

describe("a delivery scan over signature pages", () => {
  it("reads the one page it is allowed", async () => {
    const one = listed("one");
    const { transport, lists, fetched } = paged([[one], []]);
    const result = await scan(transport, OF, { pages: 1, covered: async () => true });
    expect(signatures(result.transactions)).toStrictEqual([one.signature]);
    expect([result.complete, result.pages]).toStrictEqual([true, 1]);
    expect(lists).toStrictEqual([
      { limit: SIGNATURE_PAGE, before: undefined },
      { limit: SIGNATURE_PAGE, before: one.signature },
    ]);
    expect(fetched).toStrictEqual([[one.signature]]);
  });

  it("fetches only the signatures that did not fail", async () => {
    const [failed, landed] = [listed("failed", { failed: true }), listed("landed")];
    const { transport, fetched } = paged([[failed, landed], []]);
    const result = await scan(transport, OF);
    expect(signatures(result.transactions)).toStrictEqual([landed.signature]);
    expect(fetched).toStrictEqual([[landed.signature]]);
  });

  it("asks for transactions in batches without an empty last batch", async () => {
    const wanted = ["a", "b", "c", "d"].map((seed) => listed(seed));
    const { transport, fetched } = paged([wanted, []]);
    await scan(transport, OF);
    expect(fetched).toStrictEqual([wanted.map(({ signature }) => signature)]);
  });

  it("asks nothing when a page holds no signature", async () => {
    const { transport, fetched } = paged([[]]);
    expect(await scan(transport, OF)).toStrictEqual({ transactions: [], complete: false, pages: 1 });
    expect(fetched).toStrictEqual([]);
  });

  it("stops at the transaction the caller waits for, and calls that scan complete", async () => {
    const [a, b, c] = [listed("a"), listed("b"), listed("c")];
    const { transport } = paged([[a, b, c], []]);
    const result = await scan(transport, OF, { until: (found) => found.signature === b.signature });
    expect(signatures(result.transactions)).toStrictEqual([a.signature, b.signature]);
    expect([result.complete, result.pages]).toStrictEqual([true, 1]);
  });

  it("is complete once a page reaches below the floor, without asking for more", async () => {
    const [recent, old] = [listed("recent", { blockTime: 10n }), listed("old", { blockTime: 5n })];
    const { transport, lists } = paged([[recent, old], []]);
    const result = await scan(transport, OF, { floor: 8n });
    expect(signatures(result.transactions)).toStrictEqual([recent.signature]);
    expect([result.complete, result.pages]).toStrictEqual([true, 1]);
    expect(lists).toStrictEqual([{ limit: SIGNATURE_PAGE, before: undefined }]);
  });

  it("reads a full page and then the next page before it calls the history done", async () => {
    const full = Array.from({ length: SIGNATURE_PAGE }, (_, i) => listed(`full-${i}`, { failed: true }));
    const last = full[full.length - 1]?.signature;
    const { transport, lists } = paged([full, []]);
    const result = await scan(transport, OF, { covered: async () => true });
    expect([result.transactions, result.complete, result.pages]).toStrictEqual([[], true, 2]);
    expect(lists).toStrictEqual([
      { limit: SIGNATURE_PAGE, before: undefined },
      { limit: SIGNATURE_PAGE, before: last },
    ]);
  });
});

describe("a signature page of a set size", () => {
  it("asks each next call only for what the page still lacks", async () => {
    const pages = [[listed("a"), listed("b")], [listed("c"), listed("d"), listed("e")]];
    const { transport, lists } = paged(pages);
    const { signaturesOf } = transport;
    if (signaturesOf === undefined) {
      throw new Error("the transport lists signatures");
    }
    const page = await signaturePage(transport, signaturesOf, OF, 5);
    expect(page).toStrictEqual({ listed: pages.flat(), last: false });
    expect(lists).toStrictEqual([
      { limit: 5, before: undefined },
      { limit: 3, before: pages[0]?.[1]?.signature },
    ]);
  });
});

describe("a transaction read by its signature", () => {
  it("finds the transaction with that signature in the log", async () => {
    const [a, b] = [tx("a"), tx("b")];
    expect(await transactionAt(fallback([a, b]).transport, b.signature, OF)).toBe(b);
    expect(await transactionAt(fallback([a, b]).transport, testSignature("missing"), OF)).toBeNull();
  });
});
