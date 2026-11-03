import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { DEVNET_TEST_MINT, IntentStatus } from "@intent-engine/core";
import { describe, expect, it } from "vitest";
import { CallerLimit } from "../src/callers.js";
import { authorized, createSweepHandler } from "../src/http.js";
import { MAX_CHECKS_PER_SWEEP, ORPHAN_SECS, PAID_GRACE_SECS, UNPAID_GRACE_SECS } from "../src/limits.js";
import { idleMark, ownerHolds, ownerMark } from "../src/owners.js";
import { sweep } from "../src/sweep.js";
import { DEVNET_GENESIS, harness, OWNER, proofIntent, settle, stored, sweepDeps } from "./harness.js";


const PAID = PAID_GRACE_SECS * 1000;
const UNPAID = UNPAID_GRACE_SECS * 1000;

describe("the grace of a spec without open capital behind it", () => {
  it("is an hour once the escrow is cancelled or expires unfilled, and 30 days once it is filled or filling", () => {
    expect(UNPAID_GRACE_SECS).toBe(3_600);
    expect(PAID_GRACE_SECS).toBe(30 * 86_400);
  });

  it.each([
    ["cancelled", IntentStatus.Cancelled],
    ["expired", IntentStatus.Expired],
  ])("frees the space of a spec whose escrow was %s right after the upload within the short grace", async (_, status) => {
    const h = harness();
    const hex = await stored(h, "cancelled spec\n");
    settle(h, hex, status);
    expect(await sweep(sweepDeps(h))).toMatchObject({ idled: 1, expired: 0 });
    expect(h.store.marks.has(idleMark(hex, "unpaid"))).toBe(true);
    h.clock.at += UNPAID - 1;
    expect(await sweep(sweepDeps(h))).toMatchObject({ kept: 1, expired: 0 });
    h.clock.at += 1;
    expect(await sweep(sweepDeps(h))).toMatchObject({ expired: 1 });
    expect(h.store.blobs.has(hex)).toBe(false);
    expect(h.store.marks.size).toBe(0);
    expect(await ownerHolds(h.store, OWNER)).toBe(0);
  });

  it("frees the space of a spec whose escrow account was closed after the cancel, within the short grace", async () => {
    const h = harness();
    const hex = await stored(h, "closed account spec\n");
    h.node.accounts.length = 0;
    await sweep(sweepDeps(h));
    expect(h.store.marks.has(idleMark(hex, "unpaid"))).toBe(true);
    h.clock.at += UNPAID;
    expect(await sweep(sweepDeps(h))).toMatchObject({ expired: 1 });
  });

  it.each([
    ["filled", IntentStatus.Filled],
    ["filling", IntentStatus.Filling],
  ])("keeps a spec whose escrow was %s for 30 days, then frees it", async (_, status) => {
    const h = harness();
    const hex = await stored(h, "paid spec\n");
    settle(h, hex, status);
    await sweep(sweepDeps(h));
    expect(h.store.marks.has(idleMark(hex, "paid"))).toBe(true);
    h.clock.at += PAID - 1;
    expect(await sweep(sweepDeps(h))).toMatchObject({ kept: 1, expired: 0 });
    h.clock.at += 1;
    expect(await sweep(sweepDeps(h))).toMatchObject({ expired: 1 });
    expect(h.store.blobs.has(hex)).toBe(false);
  });

  it.each([
    ["a 1-lamport filled SOL escrow", [{ escrowed: 1n }]],
    ["filled SOL escrows one lamport short together", [{ escrowed: 5_000_000n }, { escrowed: 4_999_999n }]],
    ["a large filled TEST escrow", [{ inputMint: DEVNET_TEST_MINT, escrowed: 1n << 60n }]],
  ])("gives only the short grace when %s is all that paid", async (_, patches) => {
    const h = harness();
    const hex = await stored(h, "cheaply paid spec\n");
    settle(h, hex, IntentStatus.Cancelled);
    h.node.holds(...patches.map((patch) => proofIntent(hex, { ...patch, status: IntentStatus.Filled })));
    await sweep(sweepDeps(h));
    expect(h.store.marks.has(idleMark(hex, "unpaid"))).toBe(true);
    h.clock.at += UNPAID;
    expect(await sweep(sweepDeps(h))).toMatchObject({ expired: 1 });
  });

  it("gives the 30-day grace when filled SOL escrows pay the cost together", async () => {
    const h = harness();
    const hex = await stored(h, "jointly paid spec\n");
    settle(h, hex, IntentStatus.Cancelled);
    h.node.holds(proofIntent(hex, { escrowed: 5_000_000n, status: IntentStatus.Filled }), proofIntent(hex, { escrowed: 5_000_000n, status: IntentStatus.Filling }));
    await sweep(sweepDeps(h));
    expect(h.store.marks.has(idleMark(hex, "paid"))).toBe(true);
    h.clock.at += PAID - 1;
    expect(await sweep(sweepDeps(h))).toMatchObject({ kept: 1, expired: 0 });
  });

  it("asks the chain again when a short grace ends, and keeps a spec whose escrow was filled meanwhile", async () => {
    const h = harness();
    const hex = await stored(h, "filled later spec\n");
    settle(h, hex, IntentStatus.Cancelled);
    await sweep(sweepDeps(h));
    expect(h.store.marks.has(idleMark(hex, "unpaid"))).toBe(true);
    h.node.holds(proofIntent(hex, { status: IntentStatus.Filled }));
    h.clock.at += UNPAID;
    expect(await sweep(sweepDeps(h))).toMatchObject({ kept: 1, expired: 0 });
    h.clock.at += PAID - UNPAID;
    expect(await sweep(sweepDeps(h))).toMatchObject({ expired: 1 });
  });

  it("keeps a spec while open escrows lock its cost in SOL, however old, and drops its idle mark", async () => {
    const h = harness();
    const text = "needed spec\n";
    const hex = await stored(h, text);
    h.store.marks.set(idleMark(hex, "unpaid"), h.clock.at - 100 * PAID);
    h.clock.at += 100 * PAID;
    expect(await sweep(sweepDeps(h))).toMatchObject({ kept: 1, expired: 0 });
    expect(new TextDecoder().decode(h.store.blobs.get(hex))).toBe(text);
    expect(h.store.marks.has(idleMark(hex, "unpaid"))).toBe(false);
    expect(h.store.removed).not.toContain(`sha256/${hex}`);
  });

  it("does not let an open TEST escrow keep a spec past the short grace, however much it locks", async () => {
    const h = harness();
    const hex = await stored(h, "test mint spec\n");
    settle(h, hex, IntentStatus.Cancelled);
    h.node.holds(proofIntent(hex, { inputMint: DEVNET_TEST_MINT, escrowed: 1n << 60n }));
    expect(await sweep(sweepDeps(h))).toMatchObject({ idled: 1 });
    h.clock.at += UNPAID;
    expect(await sweep(sweepDeps(h))).toMatchObject({ expired: 1 });
  });

  it("does not let an open escrow below the cost keep a spec past the short grace", async () => {
    const h = harness();
    const hex = await stored(h, "underfunded spec\n");
    settle(h, hex, IntentStatus.Cancelled);
    h.node.holds(proofIntent(hex, { escrowed: 9_999_999n }));
    await sweep(sweepDeps(h));
    h.clock.at += UNPAID;
    expect(await sweep(sweepDeps(h))).toMatchObject({ expired: 1 });
  });
});

describe("removal", () => {
  it("asks the node again before deleting, and deletes nothing when an escrow opened after the first look", async () => {
    const h = harness();
    const text = "late escrow spec\n";
    const hex = await stored(h, text);
    settle(h, hex, IntentStatus.Cancelled);
    await sweep(sweepDeps(h));
    h.clock.at += UNPAID;
    const list = h.store.list;
    h.store.list = async (prefix) => {
      if (prefix === "owners/") h.node.holds(proofIntent(hex));
      return list(prefix);
    };
    expect(await sweep(sweepDeps(h))).toMatchObject({ kept: 1, expired: 0 });
    expect(h.store.removed).not.toContain(`sha256/${hex}`);
    expect(new TextDecoder().decode(h.store.blobs.get(hex))).toBe(text);
  });

  it("deletes nothing of a spec when the second look fails, and still drops the marks it finished with", async () => {
    const h = harness();
    const kept = await stored(h, "backed spec\n");
    h.store.marks.set(idleMark(kept, "unpaid"), 0);
    const hex = await stored(h, "second look spec\n");
    settle(h, hex, IntentStatus.Cancelled);
    await sweep(sweepDeps(h));
    h.clock.at += UNPAID;
    h.store.marks.set(idleMark(kept, "unpaid"), 0);
    h.node.lookupsBeforeFailing = h.node.lookups.length + 1;
    await expect(sweep(sweepDeps(h))).rejects.toThrow();
    expect(h.store.blobs.has(hex)).toBe(true);
    expect(h.store.removed).not.toContain(`sha256/${hex}`);
    expect(h.store.marks.has(idleMark(kept, "unpaid"))).toBe(false);
  });

  it("removes nothing when the node is down or not on devnet", async () => {
    const h = harness();
    const hex = await stored(h, "spec\n");
    settle(h, hex, IntentStatus.Cancelled);
    h.store.marks.set(idleMark(hex, "unpaid"), 0);
    h.node.genesis = "x".repeat(44);
    await expect(sweep(sweepDeps(h))).rejects.toThrow("not on devnet");
    h.node.genesis = DEVNET_GENESIS;
    h.node.fails = true;
    await expect(sweep(sweepDeps(h))).rejects.toThrow();
    expect(h.store.removed).toStrictEqual([]);
  });

  it("checks at most 100 specs a run, leaves the rest for the next, and still drops finished marks", async () => {
    const h = harness(new CallerLimit(1000));
    const backed = await stored(h, "backed\n");
    h.store.marks.set(idleMark(backed, "unpaid"), 0);
    for (let i = 0; i < MAX_CHECKS_PER_SWEEP + 2; i += 1) settle(h, await stored(h, `spec ${i}\n`), IntentStatus.Cancelled);
    expect(await sweep(sweepDeps(h))).toMatchObject({ idled: MAX_CHECKS_PER_SWEEP, left: 2 });
    expect(h.store.marks.has(idleMark(backed, "unpaid"))).toBe(false);
    expect(await sweep(sweepDeps(h))).toMatchObject({ idled: 2, left: 0 });
    h.clock.at += UNPAID;
    expect(await sweep(sweepDeps(h))).toMatchObject({ expired: MAX_CHECKS_PER_SWEEP, left: 2 });
    expect(await sweep(sweepDeps(h))).toMatchObject({ expired: 2, left: 0 });
    expect([...h.store.blobs.keys()]).toStrictEqual([backed]);
  });

  it("stops checking once the run has used its time", async () => {
    const h = harness();
    for (const text of ["a\n", "b\n"]) settle(h, await stored(h, text), IntentStatus.Cancelled);
    const mark = h.store.mark;
    h.store.mark = async (pathname) => {
      h.clock.at += 40_000;
      return mark(pathname);
    };
    expect(await sweep(sweepDeps(h))).toMatchObject({ idled: 1, left: 1 });
  });

  it("removes marks without a spec only once they are a day old", async () => {
    const h = harness();
    const young = ownerMark(OWNER, "b".repeat(64), 10);
    const old = ownerMark(OWNER, "c".repeat(64), 10);
    h.store.marks.set(young, h.clock.at - ORPHAN_SECS * 1000 + 1);
    h.store.marks.set(old, h.clock.at - ORPHAN_SECS * 1000);
    expect(await sweep(sweepDeps(h))).toMatchObject({ orphans: 1 });
    expect([...h.store.marks.keys()]).toStrictEqual([young]);
  });
});

async function call(server: Server, method: string, headers: Record<string, string>): Promise<number> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path: "/api/sweep", method, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end();
  });
}

describe("the sweep endpoint", () => {
  it("runs only for the cron secret, and never without one set", async () => {
    expect(authorized("Bearer s3", "s3")).toBe(true);
    expect(authorized("Bearer s4", "s3")).toBe(false);
    expect(authorized("Bearer ", "")).toBe(false);
    expect(authorized(undefined, "s3")).toBe(false);
    expect(authorized("Bearer undefined", undefined)).toBe(false);
    const h = harness();
    let secret: string | undefined = "s3";
    const handler = createSweepHandler(sweepDeps(h), () => secret);
    const server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      expect(await call(server, "GET", { authorization: "Bearer s3" })).toBe(200);
      expect(await call(server, "GET", { authorization: "Bearer nope" })).toBe(401);
      expect(await call(server, "POST", { authorization: "Bearer s3" })).toBe(405);
      h.node.fails = true;
      expect(await call(server, "GET", { authorization: "Bearer s3" })).toBe(503);
      secret = undefined;
      expect(await call(server, "GET", { authorization: "Bearer undefined" })).toBe(401);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
