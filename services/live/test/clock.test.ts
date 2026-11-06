import { afterEach, describe, expect, it, vi } from "vitest";
import { FEED_MAX_AGE_SECS } from "../src/limits.js";
import { liveFeed } from "../src/http.js";
import { FakeNode } from "./fake-node.js";
import { MemoryCache, NOW, rig } from "./harness.js";

const DAY_MS = 86_400_000;

const listings = (node: FakeNode) => node.calls.filter(({ method }) => method === "getSignaturesForAddress").length;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the feed's refresh interval", () => {
  it("runs on elapsed time, whatever the wall clock does", async () => {
    const { node, feed, clock, tick } = rig();
    await feed.read();
    const first = listings(node);
    expect(first).toBeGreaterThan(0);
    clock.wall = 2 * FEED_MAX_AGE_SECS * 1000;
    await feed.read();
    expect(listings(node)).toBe(first);
    clock.wall = -DAY_MS;
    tick(FEED_MAX_AGE_SECS);
    await feed.read();
    expect(listings(node)).toBeGreaterThan(first);
  });

  it("reads performance.now by default, never the wall clock", async () => {
    const node = new FakeNode();
    let wall = NOW;
    vi.spyOn(performance, "now").mockReturnValue(0);
    const feed = liveFeed({ env: {}, cache: () => new MemoryCache(), transport: node.transport, probe: async () => 405, now: () => wall, log: () => undefined });
    await feed.read();
    const first = listings(node);
    wall += 2 * FEED_MAX_AGE_SECS * 1000;
    await feed.read();
    expect(listings(node)).toBe(first);
  });
});
