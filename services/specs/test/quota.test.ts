import { describe, expect, it } from "vitest";
import { MAX_STORED_BYTES } from "../src/limits.js";
import { mirror, REASONS } from "../src/mirror.js";
import { DEVNET_GENESIS, errorOf, harness, proofIntent, send, sha } from "./harness.js";

const SPEC = "deliver a module whose tests pass\n";
const HEX = sha(SPEC);
const path = `/sha256/${HEX}`;
const SIZE = new TextEncoder().encode(SPEC).length;

function open() {
  const h = harness();
  h.node.holds(proofIntent(HEX));
  return h;
}

describe("the total storage cap", () => {
  it("is 536870912 bytes", () => {
    expect(MAX_STORED_BYTES).toBe(536_870_912);
  });

  it("lets a write through under the cap, and up to exactly the cap", async () => {
    const h = open();
    h.store.held = MAX_STORED_BYTES - SIZE - 1;
    expect((await send(h.deps, "PUT", path, SPEC)).status).toBe(201);
    const exact = open();
    exact.store.held = MAX_STORED_BYTES - SIZE;
    expect((await send(exact.deps, "PUT", path, SPEC)).status).toBe(201);
    expect(exact.store.writes).toBe(1);
  });

  it("answers 507 and stores nothing when the store is at the cap", async () => {
    const h = open();
    h.store.held = MAX_STORED_BYTES;
    const reply = await send(h.deps, "PUT", path, SPEC);
    expect(reply.status).toBe(507);
    expect(errorOf(reply)).toBe(REASONS.full);
    expect(reply.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(h.store.writes).toBe(0);
    expect(h.store.blobs.size).toBe(0);
  });

  it("answers 507 and stores nothing when this write would pass the cap", async () => {
    const h = open();
    h.store.held = MAX_STORED_BYTES - SIZE + 1;
    const reply = await send(h.deps, "PUT", path, SPEC);
    expect(reply.status).toBe(507);
    expect(h.store.writes).toBe(0);
    expect(h.store.blobs.size).toBe(0);
  });

  it("answers 507 at the cap even for an empty spec", async () => {
    const h = harness();
    h.node.holds(proofIntent(sha("")));
    h.store.held = MAX_STORED_BYTES;
    expect((await send(h.deps, "PUT", `/sha256/${sha("")}`, "")).status).toBe(507);
    expect(h.store.writes).toBe(0);
  });

  it("answers 200 for a stored spec at the cap without asking for the count", async () => {
    const h = open();
    expect((await send(h.deps, "PUT", path, SPEC)).status).toBe(201);
    expect(h.store.counts).toBe(1);
    h.store.held = MAX_STORED_BYTES;
    const repeat = await send(h.deps, "PUT", path, SPEC);
    expect(repeat.status).toBe(200);
    expect(h.store.counts).toBe(1);
    expect(h.store.writes).toBe(1);
  });

  it("serves reads at the cap", async () => {
    const h = open();
    await send(h.deps, "PUT", path, SPEC);
    h.store.held = MAX_STORED_BYTES;
    const read = await send(h.deps, "GET", path);
    expect(read.status).toBe(200);
    expect(new TextDecoder().decode(read.body)).toBe(SPEC);
    expect((await send(h.deps, "HEAD", path)).status).toBe(200);
    expect(h.store.counts).toBe(1);
  });

  it("answers 503 and stores nothing when the count fails", async () => {
    const h = open();
    h.store.totalFails = new Error("list failed");
    const reply = await send(h.deps, "PUT", path, SPEC);
    expect(reply.status).toBe(503);
    expect(errorOf(reply)).toBe(REASONS.down);
    expect(h.store.writes).toBe(0);
    expect(h.store.blobs.size).toBe(0);
  });

  it("answers 503 and stores nothing when the count does not finish before the deadline", async () => {
    const h = open();
    h.store.total = () => new Promise<number>(() => undefined);
    const reply = await mirror({ method: "PUT", url: path, caller: "c", body: async () => new TextEncoder().encode(SPEC) }, { ...h.deps, deadlineMs: 50 });
    expect(reply.status).toBe(503);
    expect(errorOf(reply)).toBe(REASONS.down);
    expect(h.store.writes).toBe(0);
  });

  it("never asks for the count when an earlier check refuses", async () => {
    const h = open();
    expect((await send(h.deps, "PUT", path, "other bytes")).status).toBe(400);
    expect((await send(h.deps, "PUT", path, new Uint8Array(1_048_577))).status).toBe(413);
    h.node.genesis = "x".repeat(44);
    expect((await send(h.deps, "PUT", path, SPEC)).status).toBe(503);
    h.node.genesis = DEVNET_GENESIS;
    h.node.accounts.length = 0;
    expect((await send(h.deps, "PUT", path, SPEC)).status).toBe(403);
    expect(h.store.counts).toBe(0);
  });
});
