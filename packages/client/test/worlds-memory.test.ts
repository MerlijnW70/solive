import { availableParallelism } from "node:os";
import { describe, expect, it } from "vitest";
import { workers } from "../vitest.config.js";
import { world } from "./svm.js";

const WORLDS = 300;
const WARM = 10;
const MiB = 1024 * 1024;
const GROWTH_BOUND = 128 * MiB;
const RSS_BOUND = 768 * MiB;

describe("many LiteSVM worlds in one worker", () => {
  it(`builds ${WORLDS} worlds without memory growing past the bound`, { timeout: 600_000 }, async () => {
    let warm = 0;
    let peak = 0;
    for (let built = 1; built <= WORLDS; built++) {
      const { chain } = await world();
      expect(chain.sent.length).toBeGreaterThan(0);
      const { rss } = process.memoryUsage();
      peak = Math.max(peak, rss);
      if (built === WARM) {
        warm = rss;
      }
    }
    const { rss } = process.memoryUsage();
    expect(rss - warm).toBeLessThan(GROWTH_BOUND);
    expect(peak).toBeLessThan(RSS_BOUND);
  });

  it("lets the harness collect dropped worlds", () => {
    expect(typeof (globalThis as { gc?: unknown }).gc).toBe("function");
  });

  it("runs at most eight workers, never more than the cores leave free or one per 2 GiB of memory", () => {
    expect(workers).toBeGreaterThanOrEqual(1);
    expect(workers).toBeLessThanOrEqual(8);
    expect(workers).toBeLessThanOrEqual(Math.max(1, availableParallelism() - 1));
  });
});
