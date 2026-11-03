import { DEVNET_TEST_MINT, IntentStatus } from "@intent-engine/core";
import { describe, expect, it } from "vitest";
import { CallerLimit } from "../src/callers.js";
import { MAX_EVICTIONS_PER_PUT, MAX_ROOM_LOOKUPS_PER_PUT, MAX_STORED_BYTES, PAID_GRACE_SECS } from "../src/limits.js";
import { REASONS } from "../src/mirror.js";
import { idleMark, ownerHolds } from "../src/owners.js";
import { sweep } from "../src/sweep.js";
import { errorOf, harness, OWNER, proofIntent, send, settle, sha, stored, sweepDeps, type Harness } from "./harness.js";

const OLD = "an old spec whose escrow was cancelled\n";
const NEW = "a new spec\n";

async function full(status: number | null): Promise<Harness> {
  const h = harness();
  const old = await stored(h, OLD);
  if (status !== null) settle(h, old, status);
  h.store.held = MAX_STORED_BYTES - OLD.length - NEW.length + 1;
  h.node.holds(proofIntent(sha(NEW)));
  return h;
}

describe("an upload at the cap", () => {
  it.each([
    ["cancelled", IntentStatus.Cancelled],
    ["expired", IntentStatus.Expired],
  ])("removes a spec whose escrow was %s at once, without waiting for the grace, and stores", async (_, status) => {
    const h = await full(status);
    expect((await send(h.deps, "PUT", `/sha256/${sha(NEW)}`, NEW)).status).toBe(201);
    expect(h.store.blobs.has(sha(OLD))).toBe(false);
    expect(h.store.blobs.has(sha(NEW))).toBe(true);
    expect(await ownerHolds(h.store, OWNER)).toBe(NEW.length);
  });

  it.each([
    ["open", null],
    ["filled", IntentStatus.Filled],
    ["filling", IntentStatus.Filling],
  ])("never removes a spec whose escrow is %s, and answers 507", async (_, status) => {
    const h = await full(status);
    const reply = await send(h.deps, "PUT", `/sha256/${sha(NEW)}`, NEW);
    expect(reply.status).toBe(507);
    expect(errorOf(reply)).toBe(REASONS.full);
    expect(reply.headers["x-spec-limit"]).toBe("total");
    expect(h.store.blobs.has(sha(OLD))).toBe(true);
    expect(h.store.removed).toStrictEqual([]);
  });

  it("does not even consider a spec its open escrows back: one look at all escrows and none per spec", async () => {
    const h = await full(null);
    const before = h.node.lookups.length;
    expect((await send(h.deps, "PUT", `/sha256/${sha(NEW)}`, NEW)).status).toBe(507);
    const asked = h.node.lookups.slice(before).map((lookup) => lookup.config.dataSlice);
    expect(asked).toStrictEqual([{ offset: 8, length: 144 }, { offset: 40, length: 224 }]);
  });

  it("keeps a spec marked paid within its 30 days, and asks the chain once the mark has run out", async () => {
    const h = await full(IntentStatus.Filled);
    await sweep(sweepDeps(h));
    expect(h.store.marks.has(idleMark(sha(OLD), "paid"))).toBe(true);
    h.node.accounts.splice(0, 1);
    h.clock.at += PAID_GRACE_SECS * 1000 - 1;
    expect((await send(h.deps, "PUT", `/sha256/${sha(NEW)}`, NEW)).status).toBe(507);
    expect(h.store.blobs.has(sha(OLD))).toBe(true);
    h.clock.at += 1;
    expect((await send(h.deps, "PUT", `/sha256/${sha(NEW)}`, NEW)).status).toBe(201);
    expect(h.store.blobs.has(sha(OLD))).toBe(false);
    expect(h.store.marks.has(idleMark(sha(OLD), "paid"))).toBe(false);
  });

  it.each([
    ["a tiny filled SOL escrow", { escrowed: 9_999_999n }],
    ["a large filled TEST escrow", { inputMint: DEVNET_TEST_MINT, escrowed: 1n << 60n }],
  ])("removes a spec at once when only %s paid for it", async (_, patch) => {
    const h = await full(IntentStatus.Cancelled);
    h.node.holds(proofIntent(sha(OLD), { ...patch, status: IntentStatus.Filled }));
    expect((await send(h.deps, "PUT", `/sha256/${sha(NEW)}`, NEW)).status).toBe(201);
    expect(h.store.blobs.has(sha(OLD))).toBe(false);
  });

  it("removes the oldest unbacked specs first, and only as many as the upload needs", async () => {
    const h = harness(new CallerLimit(1000));
    const texts = ["first old spec\n", "second old spec\n", "third old spec\n"];
    for (const text of texts) {
      settle(h, await stored(h, text), IntentStatus.Cancelled);
      h.clock.at += 1_000;
    }
    const [middle, oldest, newest] = [texts[1], texts[0], texts[2]] as [string, string, string];
    const reorder = h.store.list;
    h.store.list = async (prefix) => (await reorder(prefix)).reverse();
    h.store.held = MAX_STORED_BYTES - texts.join("").length - NEW.length + 1;
    h.node.holds(proofIntent(sha(NEW)));
    expect((await send(h.deps, "PUT", `/sha256/${sha(NEW)}`, NEW)).status).toBe(201);
    expect(h.store.blobs.has(sha(oldest))).toBe(false);
    expect(h.store.blobs.has(sha(middle))).toBe(true);
    expect(h.store.blobs.has(sha(newest))).toBe(true);
  });

  it("removes at most 20 specs for one upload", async () => {
    expect(MAX_EVICTIONS_PER_PUT).toBe(20);
    const h = harness(new CallerLimit(1000));
    const texts = Array.from({ length: MAX_EVICTIONS_PER_PUT + 1 }, (_, i) => `small spec ${String(i).padStart(2, "0")}\n`);
    for (const text of texts) settle(h, await stored(h, text), IntentStatus.Cancelled);
    h.store.held = MAX_STORED_BYTES - NEW.length;
    h.node.holds(proofIntent(sha(NEW)));
    expect((await send(h.deps, "PUT", `/sha256/${sha(NEW)}`, NEW)).status).toBe(507);
    expect(texts.filter((text) => h.store.blobs.has(sha(text)))).toHaveLength(1);
  });

  it("still removes a cancelled spec behind more than 20 older paid ones, and marks the paid ones it checked", async () => {
    const h = harness(new CallerLimit(1000));
    const paid = Array.from({ length: MAX_EVICTIONS_PER_PUT + 5 }, (_, i) => `paid spec ${i}\n`);
    for (const text of paid) {
      settle(h, await stored(h, text), IntentStatus.Filled);
      h.clock.at += 1_000;
    }
    const junk = await stored(h, OLD);
    settle(h, junk, IntentStatus.Cancelled);
    h.store.held = MAX_STORED_BYTES - [...paid, OLD].join("").length - NEW.length + 1;
    h.node.holds(proofIntent(sha(NEW)));
    expect((await send(h.deps, "PUT", `/sha256/${sha(NEW)}`, NEW)).status).toBe(201);
    expect(h.store.blobs.has(junk)).toBe(false);
    expect(paid.every((text) => h.store.blobs.has(sha(text)) && h.store.marks.has(idleMark(sha(text), "paid")))).toBe(true);
  });

  it("asks the node nothing per spec for specs marked paid within their grace", async () => {
    const h = harness(new CallerLimit(1000));
    for (let i = 0; i < 30; i += 1) settle(h, await stored(h, `marked paid spec ${i}\n`), IntentStatus.Filled);
    await sweep(sweepDeps(h));
    h.store.held = MAX_STORED_BYTES;
    h.node.holds(proofIntent(sha(NEW)));
    const before = h.node.lookups.length;
    expect((await send(h.deps, "PUT", `/sha256/${sha(NEW)}`, NEW)).status).toBe(507);
    expect(h.node.lookups.length - before).toBe(2);
  });

  it("bounds the node calls of one upload when every spec is paid", async () => {
    expect(MAX_ROOM_LOOKUPS_PER_PUT).toBe(60);
    const h = harness(new CallerLimit(1000));
    for (let i = 0; i < 100; i += 1) settle(h, await stored(h, `unmarked paid spec ${i}\n`), IntentStatus.Filled);
    h.store.held = MAX_STORED_BYTES;
    h.node.holds(proofIntent(sha(NEW)));
    const before = h.node.lookups.length;
    expect((await send(h.deps, "PUT", `/sha256/${sha(NEW)}`, NEW)).status).toBe(507);
    expect(h.node.lookups.length - before).toBeLessThanOrEqual(2 + MAX_ROOM_LOOKUPS_PER_PUT);
    expect(h.node.lookups.length - before).toBeGreaterThan(2);
    expect(h.store.blobs.size).toBe(100);
  });

  it("does not look for room below the cap", async () => {
    const h = await full(IntentStatus.Cancelled);
    h.store.held = 0;
    const before = h.node.lookups.length;
    expect((await send(h.deps, "PUT", `/sha256/${sha(NEW)}`, NEW)).status).toBe(201);
    expect(h.node.lookups.length - before).toBe(1);
    expect(h.store.blobs.has(sha(OLD))).toBe(true);
  });
});

describe("a new upload of a stored spec", () => {
  it("restarts the grace when open escrows lock its cost, and not when they lock less", async () => {
    const h = harness();
    const hex = await stored(h, OLD);
    settle(h, hex, IntentStatus.Cancelled);
    await sweep(sweepDeps(h));
    expect(h.store.marks.has(idleMark(hex, "unpaid"))).toBe(true);
    h.node.holds(proofIntent(hex, { escrowed: 1n }));
    expect((await send(h.deps, "PUT", `/sha256/${hex}`, OLD)).status).toBe(200);
    expect(h.store.marks.has(idleMark(hex, "unpaid"))).toBe(true);
    h.node.holds(proofIntent(hex));
    expect((await send(h.deps, "PUT", `/sha256/${hex}`, OLD)).status).toBe(200);
    expect(h.store.marks.has(idleMark(hex, "unpaid"))).toBe(false);
  });
});
