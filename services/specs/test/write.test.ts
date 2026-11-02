import { getAddressDecoder, getBase58Decoder } from "@solana/kit";
import { MAX_SPEC_BYTES } from "@intent-engine/client/internal";
import { IntentStatus, Kind } from "@intent-engine/core";
import { getIntentDiscriminatorBytes, getIntentSize, INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core/internal";
import { describe, expect, it, vi } from "vitest";
import { CallerLimit } from "../src/callers.js";
import { NODE_TIMEOUT_MS, PUT_WINDOW_SECS } from "../src/limits.js";
import { mirror, REASONS } from "../src/mirror.js";
import { DEVNET_GENESIS, errorOf, harness, key, MAINNET_GENESIS, MAX_NODE_FILTERS, proofIntent, send, sha } from "./harness.js";

const SPEC = "deliver a module whose tests pass\n";
const HEX = sha(SPEC);
const path = (hex: string = HEX) => `/sha256/${hex}`;

function open() {
  const h = harness();
  h.node.holds(proofIntent(HEX));
  return h;
}

describe("PUT /sha256/{hex} stores", () => {
  it("answers 201 and stores the exact bytes for an open escrow with this hash", async () => {
    const h = open();
    const reply = await send(h.deps, "PUT", path(), SPEC);
    expect(reply.status).toBe(201);
    expect(reply.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(reply.headers["x-content-type-options"]).toBe("nosniff");
    expect(h.store.writes).toBe(1);
    expect(new TextDecoder().decode(h.store.blobs.get(HEX))).toBe(SPEC);
    const read = await send(h.deps, "GET", path());
    expect(new TextDecoder().decode(read.body)).toBe(SPEC);
  });

  it("answers 200 on a repeat and does not write again", async () => {
    const h = open();
    expect((await send(h.deps, "PUT", path(), SPEC)).status).toBe(201);
    const repeat = await send(h.deps, "PUT", path(), SPEC);
    expect(repeat.status).toBe(200);
    expect(repeat.headers["content-type"]).toBe("application/json; charset=utf-8");
    expect(repeat.headers["x-content-type-options"]).toBe("nosniff");
    expect(h.store.writes).toBe(1);
  });

  it("answers 200 when another upload stored it first", async () => {
    const h = open();
    h.store.raceLost = true;
    expect((await send(h.deps, "PUT", path(), SPEC)).status).toBe(200);
    expect(h.store.writes).toBe(0);
  });

  it("takes a body of exactly the cap readers use", async () => {
    const fits = new Uint8Array(MAX_SPEC_BYTES).fill(97);
    const h = harness();
    h.node.holds(proofIntent(sha(fits)));
    expect((await send(h.deps, "PUT", path(sha(fits)), fits)).status).toBe(201);
    expect(MAX_SPEC_BYTES).toBe(1_048_576);
  });

  it("keeps the bytes readable after the escrow closes, and a later upload changes nothing", async () => {
    const h = open();
    await send(h.deps, "PUT", path(), SPEC);
    h.node.accounts.length = 0;
    h.node.holds(proofIntent(HEX, { status: IntentStatus.Filled }));
    const repeat = await send(h.deps, "PUT", path(), SPEC);
    expect(repeat.status).toBe(403);
    expect(h.store.writes).toBe(1);
    const read = await send(h.deps, "GET", path());
    expect(read.status).toBe(200);
    expect(new TextDecoder().decode(read.body)).toBe(SPEC);
  });
});

describe("PUT /sha256/{hex} refuses and stores nothing", () => {
  const nothing = (h: ReturnType<typeof open>) => {
    expect(h.store.writes).toBe(0);
    expect(h.store.blobs.size).toBe(0);
  };

  it("bytes whose sha256 is not the hash, without asking the node", async () => {
    const h = open();
    const reply = await send(h.deps, "PUT", path(), "other bytes");
    expect(reply.status).toBe(400);
    expect(errorOf(reply)).toBe(REASONS.mismatch);
    expect(h.node.lookups).toHaveLength(0);
    nothing(h);
  });

  it("an oversize body, without asking the node", async () => {
    const big = new Uint8Array(MAX_SPEC_BYTES + 1).fill(97);
    const h = harness();
    h.node.holds(proofIntent(sha(big)));
    const reply = await send(h.deps, "PUT", path(sha(big)), big);
    expect(reply.status).toBe(413);
    expect(errorOf(reply)).toBe(REASONS.oversize);
    expect(h.node.lookups).toHaveLength(0);
    nothing(h);
  });

  it("oversize wins over wrong bytes, and wrong bytes over no escrow", async () => {
    const h = harness();
    expect((await send(h.deps, "PUT", path(), new Uint8Array(MAX_SPEC_BYTES + 1))).status).toBe(413);
    expect((await send(h.deps, "PUT", path(), "other bytes")).status).toBe(400);
    expect((await send(h.deps, "PUT", path(), SPEC)).status).toBe(403);
  });

  it("no escrow with this hash", async () => {
    const h = harness();
    h.node.holds(proofIntent(sha("another spec")));
    const reply = await send(h.deps, "PUT", path(), SPEC);
    expect(reply.status).toBe(403);
    expect(errorOf(reply)).toBe(REASONS.noEscrow);
    nothing(h);
  });

  it.each([
    ["Filled", IntentStatus.Filled],
    ["Cancelled", IntentStatus.Cancelled],
    ["Expired", IntentStatus.Expired],
    ["Filling", IntentStatus.Filling],
  ])("a %s escrow", async (_, status) => {
    const h = harness();
    h.node.holds(proofIntent(HEX, { status }));
    expect((await send(h.deps, "PUT", path(), SPEC)).status).toBe(403);
    nothing(h);
  });

  it.each([
    ["SwapExactIn", Kind.SwapExactIn],
    ["LimitOrder", Kind.LimitOrder],
    ["DutchAuction", Kind.DutchAuction],
  ])("an open %s intent holding the same bytes at the hash offset", async (_, kind) => {
    const h = harness();
    h.node.holds(proofIntent(HEX, { kind }));
    expect((await send(h.deps, "PUT", path(), SPEC)).status).toBe(403);
    nothing(h);
  });

  it("an account of another type holding the same bytes at those offsets", async () => {
    const h = open();
    const forged = Uint8Array.from(h.node.accounts[0] as Uint8Array);
    forged[0] = (forged[0] as number) ^ 1;
    h.node.accounts.length = 0;
    h.node.accounts.push(forged);
    expect((await send(h.deps, "PUT", path(), SPEC)).status).toBe(403);
    nothing(h);
  });

  it("a node that is not on devnet, without looking for an escrow", async () => {
    const h = open();
    h.node.genesis = getBase58Decoder().decode(new Uint8Array(32).fill(7));
    const reply = await send(h.deps, "PUT", path(), SPEC);
    expect(reply.status).toBe(503);
    expect(errorOf(reply)).toBe(REASONS.cluster);
    expect(h.node.lookups).toHaveLength(0);
    nothing(h);
  });

  it("the mainnet node, by its literal genesis hash, while the literal devnet hash passes", async () => {
    const h = open();
    h.node.genesis = MAINNET_GENESIS;
    expect((await send(h.deps, "PUT", path(), SPEC)).status).toBe(503);
    nothing(h);
    h.node.genesis = DEVNET_GENESIS;
    expect((await send(h.deps, "PUT", path(), SPEC)).status).toBe(201);
  });

  it("a node that fails", async () => {
    const h = open();
    h.node.fails = true;
    const reply = await send(h.deps, "PUT", path(), SPEC);
    expect(reply.status).toBe(503);
    expect(errorOf(reply)).toBe(REASONS.down);
    nothing(h);
  });

  it("bad hex, without reading the body", async () => {
    const h = open();
    const body = vi.fn(async () => new Uint8Array());
    const reply = await mirror({ method: "PUT", url: path("ABC"), caller: "c", body }, h.deps);
    expect(reply.status).toBe(400);
    expect(body).not.toHaveBeenCalled();
    nothing(h);
  });
});

describe("the escrow lookup", () => {
  it("sends one lookup to the program with the kind, status and hash filters, asking for no account data", async () => {
    const h = open();
    await send(h.deps, "PUT", path(), SPEC);
    expect(h.node.lookups).toHaveLength(1);
    const lookup = h.node.lookups[0];
    expect(lookup?.program).toBe(INTENT_ENGINE_PROGRAM_ADDRESS);
    expect(lookup?.config.dataSlice).toStrictEqual({ offset: 0, length: 0 });
    const base58 = getBase58Decoder();
    expect(lookup?.config.filters.length).toBeLessThanOrEqual(MAX_NODE_FILTERS);
    expect(lookup?.signal).toBeInstanceOf(AbortSignal);
    expect(h.node.genesisSignals[0]).toBeInstanceOf(AbortSignal);
    expect(NODE_TIMEOUT_MS).toBe(10_000);
    const filters = lookup?.config.filters.map((filter) => (filter.dataSize === undefined ? { offset: Number(filter.memcmp?.offset), bytes: filter.memcmp?.bytes, encoding: filter.memcmp?.encoding } : { size: Number(filter.dataSize) }));
    expect(filters).toStrictEqual([
      { size: getIntentSize() },
      { offset: 0, bytes: base58.decode(getIntentDiscriminatorBytes()), encoding: "base58" },
      { offset: 168, bytes: base58.decode(Uint8Array.of(4, 0)), encoding: "base58" },
      { offset: 232, bytes: base58.decode(Buffer.from(HEX, "hex")), encoding: "base58" },
    ]);
    expect(Kind.AttestedResult).toBe(4);
    expect(IntentStatus.Open).toBe(0);
  });

  it("reads the hash at the offset the encoded account holds it", () => {
    const h = open();
    const account = h.node.accounts[0] as Uint8Array;
    expect(Buffer.from(account.subarray(232, 264)).toString("hex")).toBe(HEX);
    expect(account[168]).toBe(Kind.AttestedResult);
    expect(account[169]).toBe(IntentStatus.Open);
    expect(getAddressDecoder().decode(account.subarray(200, 232))).toBe(key(8));
  });
});

describe("the rate limit on PUT", () => {
  it("answers 429 with retry-after past the limit, whatever the outcome of earlier uploads, and frees the caller after the window", async () => {
    const h = harness(new CallerLimit(2, PUT_WINDOW_SECS));
    h.node.holds(proofIntent(HEX));
    expect((await send(h.deps, "PUT", path(), "wrong")).status).toBe(400);
    h.clock.at += 10_000;
    expect((await send(h.deps, "PUT", path(), SPEC, "198.51.100.1")).status).toBe(201);
    const limited = await send(h.deps, "PUT", path(), SPEC, "198.51.100.1");
    expect(limited.status).toBe(429);
    expect(limited.headers["retry-after"]).toBe(String(PUT_WINDOW_SECS - 10));
    expect(JSON.parse(new TextDecoder().decode(limited.body))).toStrictEqual({ error: REASONS.caller, retry_after: PUT_WINDOW_SECS - 10 });
    expect(h.node.lookups).toHaveLength(1);
    expect(h.store.writes).toBe(1);
    expect((await send(h.deps, "PUT", path(), SPEC, "198.51.100.2")).status).toBe(200);
    h.clock.at += (PUT_WINDOW_SECS - 10) * 1000;
    expect((await send(h.deps, "PUT", path(), SPEC, "198.51.100.1")).status).toBe(200);
  });

  it("allows 20 uploads an hour by default", () => {
    const limits = new CallerLimit();
    for (let i = 0; i < 20; i += 1) expect(limits.retryAfter("a", 0)).toBeNull();
    expect(limits.retryAfter("a", 0)).toBe(3600);
    expect(limits.retryAfter("a", 3_600_000)).toBeNull();
  });

  it("leaves reads alone", async () => {
    const h = harness(new CallerLimit(1, PUT_WINDOW_SECS));
    for (let i = 0; i < 3; i += 1) expect((await send(h.deps, "GET", path())).status).toBe(404);
  });

  it("does not read the body of a limited caller", async () => {
    const { deps } = harness(new CallerLimit(1, PUT_WINDOW_SECS));
    const body = vi.fn(async () => new TextEncoder().encode(SPEC));
    await mirror({ method: "PUT", url: path(), caller: "c", body }, deps);
    expect(body).toHaveBeenCalledTimes(1);
    const limited = await mirror({ method: "PUT", url: path(), caller: "c", body }, deps);
    expect(limited.status).toBe(429);
    expect(body).toHaveBeenCalledTimes(1);
  });

  it("forgets callers whose window has passed", () => {
    const limits = new CallerLimit(1, 10);
    expect(limits.retryAfter("a", 0)).toBeNull();
    expect(limits.retryAfter("a", 1_000)).toBe(9);
    limits.forget(10_000);
    expect(limits.retryAfter("a", 10_000)).toBeNull();
  });
});
