import type { AccountView, EngineTransaction } from "@intent-engine/client";
import { beforeAll, describe, expect, it } from "vitest";
import { aroundRelease } from "../src/agent/wallet/releases.js";
import { created, type Escrow, escrow, filledAt, FLOOR, naming, node, plain, released } from "./release-node.js";

let e: Escrow;

beforeAll(async () => {
  e = await escrow();
});

async function around(history: readonly EngineTransaction[], release: EngineTransaction, options: { page?: number; listing?: boolean; held?: AccountView } = {}) {
  const reads = node(e.intent, history, options);
  const found = await aroundRelease(reads.transport, e.intent, release);
  return { reads, found: { ...found, followUps: found.followUps.map((tx) => tx.signature), creation: found.creation?.signature ?? null } };
}

describe("the transactions around a release on a node that lists signatures", () => {
  it("looks for the creation among entries at or before the release, by slot or by block time", async () => {
    const at = async (release: EngineTransaction, creation: EngineTransaction) => (await around([release, creation], release)).found.creation;
    const bySlot = released(e.intent, { slot: 10n });
    const byTime = released(e.intent, { slot: 10n, blockTime: 100n });
    expect(
      await Promise.all([
        at(bySlot, created(e.intent, "same-slot", { slot: 10n })),
        at(bySlot, created(e.intent, "lower-slot", { slot: 9n })),
        at(byTime, created(e.intent, "same-time", { slot: 11n, blockTime: 100n })),
        at(byTime, created(e.intent, "earlier-time", { slot: 11n, blockTime: 99n })),
        at(bySlot, created(e.intent, "later-slot", { slot: 11n })),
      ]),
    ).toEqual(["same-slot", "lower-slot", "same-time", "earlier-time", null]);
  });

  it("takes as follow-ups only entries listed before the release that name it", async () => {
    const release = released(e.intent, { slot: 10n });
    const first = await around([release, naming("after", { slot: 9n }), created(e.intent, "creation", { slot: 9n })], release);
    expect([first.found.followUps, first.found.creation]).toEqual([[], "creation"]);
    const second = await around([naming("before", { slot: 11n }), release, naming("after", { slot: 9n }), created(e.intent, "creation", { slot: 9n })], release);
    expect([second.found.followUps, second.found.creation, second.found.complete]).toEqual([["before"], "creation", true]);
    const same = await around([naming("same-slot", { slot: 10n }), release, created(e.intent, "creation", { slot: 9n })], release);
    expect([same.found.followUps, same.found.creation]).toEqual([["same-slot"], "creation"]);
  });

  it("reads only the entries at the held escrow's creation time when the release belongs to it", async () => {
    const release = released(e.intent, { slot: 10n, blockTime: FLOOR + 5n });
    const history = [release, plain("unread", { slot: 9n, blockTime: FLOOR + 1n, unread: true }), created(e.intent, "creation", { slot: 9n, blockTime: FLOOR })];
    const { found, reads } = await around(history, release, { held: filledAt(e.view, FLOOR) });
    expect(found).toEqual({ followUps: [], creation: "creation", later: false, complete: true });
    expect(reads.batches).toEqual([1]);
  });

  it("stops at the first creation it reads, even when a later batch could not be read", async () => {
    const release = released(e.intent, { slot: 10n });
    const older = ["a", "b", "c"].map((signature) => plain(signature, { slot: 9n }));
    const { found, reads } = await around([release, created(e.intent, "creation", { slot: 9n }), ...older, plain("unread", { slot: 9n, unread: true })], release);
    expect(found).toEqual({ followUps: [], creation: "creation", later: false, complete: true });
    expect(reads.batches).toEqual([4]);
  });

  it("stops listing once it has read as many transactions as it may", async () => {
    const release = released(e.intent, { slot: 10n });
    const older = Array.from({ length: 2_000 }, (_, i) => plain(`older-${i}`, { slot: 9n }));
    const { found, reads } = await around([release, ...older], release);
    expect(found).toEqual({ followUps: [], creation: null, later: false, complete: false });
    expect([reads.pages, reads.batches.reduce((sum, n) => sum + n, 0)]).toEqual([2, 1_000]);
  });

  it("stops at a short page that does not reach the release and calls the result incomplete", async () => {
    const release = released(e.intent, { slot: 10n });
    const { found, reads } = await around([plain("newer", { slot: 11n }), release, created(e.intent, "creation", { slot: 9n })], release, { page: 1 });
    expect(found).toEqual({ followUps: [], creation: null, later: false, complete: false });
    expect(reads.pages).toBe(1);
  });
});

describe("the transactions around a release on a node that cannot list signatures", () => {
  it("takes the newer transactions that name the release or could not be read, and the creation older than it", async () => {
    const release = released(e.intent, { slot: 10n });
    const history = [
      plain("plain", { slot: 12n }),
      naming("named", { slot: 12n }),
      plain("unread", { slot: 11n, unread: true }),
      release,
      plain("older-unread", { slot: 9n, unread: true }),
      created(e.intent, "creation", { slot: 9n }),
    ];
    const { found } = await around(history, release, { listing: false });
    expect(found).toEqual({ followUps: ["named", "unread"], creation: "creation", later: false, complete: false });
  });

  it("reads the creation from the transactions older than the release, not from a newer one", async () => {
    const release = released(e.intent, { slot: 10n });
    const { found } = await around([created(e.intent, "recreated", { slot: 11n }), release, created(e.intent, "creation", { slot: 9n })], release, { listing: false });
    expect(found).toEqual({ followUps: [], creation: "creation", later: true, complete: true });
  });
});
