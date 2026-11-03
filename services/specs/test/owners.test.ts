import type { Address } from "@solana/kit";
import { DEVNET_TEST_MINT } from "@intent-engine/core";
import { describe, expect, it } from "vitest";
import { COST_STEP_BYTES, MAX_OWNER_BYTES, MAX_STORED_BYTES, MIN_ESCROW_UNITS } from "../src/limits.js";
import { REASONS } from "../src/mirror.js";
import { costOf, ownerHolds, ownerMark, parseOwnerMark } from "../src/owners.js";
import { errorOf, harness, key, OWNER, proofIntent, send, sha } from "./harness.js";

const spec = (n: number, size = 64): Uint8Array => {
  const bytes = new Uint8Array(size).fill(97);
  new DataView(bytes.buffer).setUint32(0, n);
  return bytes;
};
const OTHER = key(21);
const [FIRST, LATER] = (OWNER < OTHER ? [OWNER, OTHER] : [OTHER, OWNER]) as [Address, Address];

describe("the per-owner quota", () => {
  it("is 16 MiB per owner, so at least 32 owners are needed to fill the store", () => {
    expect(MAX_OWNER_BYTES).toBe(16 * 1024 * 1024);
    expect(MAX_STORED_BYTES / MAX_OWNER_BYTES).toBe(32);
  });

  it("refuses one owner past its quota while another owner still stores", async () => {
    const h = harness();
    const near = spec(1, 1000);
    h.node.holds(proofIntent(sha(near)));
    expect((await send(h.deps, "PUT", `/sha256/${sha(near)}`, near)).status).toBe(201);
    h.store.marks.set(ownerMark(OWNER, "f".repeat(64), MAX_OWNER_BYTES - 1000 - 10), 0);
    const over = spec(2, 11);
    h.node.holds(proofIntent(sha(over)));
    const refused = await send(h.deps, "PUT", `/sha256/${sha(over)}`, over);
    expect(refused.status).toBe(507);
    expect(errorOf(refused)).toBe(REASONS.owner);
    expect(refused.headers["x-spec-limit"]).toBe("owner");
    expect(h.store.blobs.has(sha(over))).toBe(false);
    const fits = spec(3, 10);
    h.node.holds(proofIntent(sha(fits)));
    expect((await send(h.deps, "PUT", `/sha256/${sha(fits)}`, fits)).status).toBe(201);
    expect(await ownerHolds(h.store, OWNER)).toBe(MAX_OWNER_BYTES);
    h.node.holds(proofIntent(sha(over), { owner: OTHER }));
    expect((await send(h.deps, "PUT", `/sha256/${sha(over)}`, over)).status).toBe(201);
    expect(await ownerHolds(h.store, OTHER)).toBe(11);
    expect(await ownerHolds(h.store, OWNER)).toBe(MAX_OWNER_BYTES);
  });

  it("charges the bytes to an owner before they are written, and counts a hash once per owner", async () => {
    const h = harness();
    const bytes = spec(4, 300);
    h.node.holds(proofIntent(sha(bytes)));
    const marked: string[] = [];
    const write = h.store.write;
    h.store.write = async (hex, body) => {
      marked.push(...h.store.marks.keys());
      return write(hex, body);
    };
    expect((await send(h.deps, "PUT", `/sha256/${sha(bytes)}`, bytes)).status).toBe(201);
    expect(marked).toStrictEqual([ownerMark(OWNER, sha(bytes), 300)]);
    await h.store.mark(ownerMark(OWNER, sha(bytes), 300));
    expect(await ownerHolds(h.store, OWNER)).toBe(300);
  });

  it("charges the first owner by address that has room, falling through a full one to a later one", async () => {
    for (const [full, charged] of [
      [FIRST, LATER],
      [null, FIRST],
    ] as const) {
      const h = harness();
      const bytes = spec(5, 40);
      if (full !== null) h.store.marks.set(ownerMark(full, "e".repeat(64), MAX_OWNER_BYTES), 0);
      h.node.holds(proofIntent(sha(bytes), { owner: LATER }), proofIntent(sha(bytes), { owner: FIRST }));
      expect((await send(h.deps, "PUT", `/sha256/${sha(bytes)}`, bytes)).status).toBe(201);
      expect(await ownerHolds(h.store, charged)).toBe(40);
      expect([...h.store.marks.keys()].filter((mark) => mark.endsWith(`${sha(bytes)}.40`))).toStrictEqual([ownerMark(charged, sha(bytes), 40)]);
    }
  });

  it("fails closed on an owner mark it cannot read", async () => {
    const h = harness();
    const bytes = spec(6);
    h.node.holds(proofIntent(sha(bytes)));
    h.store.marks.set(`owners/${OWNER}/not-a-mark`, 0);
    const reply = await send(h.deps, "PUT", `/sha256/${sha(bytes)}`, bytes);
    expect(reply.status).toBe(503);
    expect(h.store.blobs.size).toBe(0);
    expect(() => parseOwnerMark(`owners/${OWNER}/${"a".repeat(64)}.01`)).toThrow();
  });
});

describe("the cost of an upload", () => {
  it("is 0.01 SOL locked for each 64 KiB begun", () => {
    expect(MIN_ESCROW_UNITS).toBe(10_000_000n);
    expect(COST_STEP_BYTES).toBe(65536);
    expect(costOf(0)).toBe(10_000_000n);
    expect(costOf(65536)).toBe(10_000_000n);
    expect(costOf(65537)).toBe(20_000_000n);
    expect(costOf(1_048_576)).toBe(160_000_000n);
  });

  it("stores an honest spec at escrow time when the escrow locks the cost in SOL", async () => {
    const h = harness();
    const bytes = spec(7, 2000);
    h.node.holds(proofIntent(sha(bytes), { escrowed: 10_000_000n }));
    expect((await send(h.deps, "PUT", `/sha256/${sha(bytes)}`, bytes)).status).toBe(201);
  });

  it("refuses an escrow below the cost, and stores nothing", async () => {
    const h = harness();
    const bytes = spec(8, 65537);
    h.node.holds(proofIntent(sha(bytes), { escrowed: 19_999_999n }));
    const reply = await send(h.deps, "PUT", `/sha256/${sha(bytes)}`, bytes);
    expect(reply.status).toBe(402);
    expect(reply.headers["x-min-escrowed"]).toBe("20000000");
    expect(JSON.parse(new TextDecoder().decode(reply.body))).toStrictEqual({ error: REASONS.cost, min_escrowed: 20_000_000 });
    expect(h.store.blobs.size).toBe(0);
    expect(h.store.marks.size).toBe(0);
    expect(h.store.counts).toBe(0);
  });

  it("counts no TEST and no other mint, whatever the amount", async () => {
    for (const inputMint of [DEVNET_TEST_MINT, key(7)]) {
      const h = harness();
      const bytes = spec(9);
      h.node.holds(proofIntent(sha(bytes), { inputMint, escrowed: 1n << 60n }));
      expect((await send(h.deps, "PUT", `/sha256/${sha(bytes)}`, bytes)).status).toBe(402);
      expect(h.store.blobs.size).toBe(0);
    }
  });

  it("adds up the SOL that the open escrows with the hash lock together", async () => {
    const h = harness();
    const bytes = spec(10);
    h.node.holds(proofIntent(sha(bytes), { escrowed: 4_000_000n }), proofIntent(sha(bytes), { owner: OTHER, escrowed: 5_999_999n }));
    expect((await send(h.deps, "PUT", `/sha256/${sha(bytes)}`, bytes)).status).toBe(402);
    h.node.holds(proofIntent(sha(bytes), { owner: OTHER, escrowed: 1n }));
    expect((await send(h.deps, "PUT", `/sha256/${sha(bytes)}`, bytes)).status).toBe(201);
  });
});
