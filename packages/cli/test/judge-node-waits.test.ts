import { describe, expect, it } from "vitest";
import { NODE_SAMPLE_FEWEST_MS, NODE_SAMPLE_LOAD, NODE_SAMPLE_MS } from "../src/node-judge.js";
import { sampleGapMs, sampleMeanMs, waitedAt, type Waits } from "../src/verdict-model.js";

const BUDGET = 1_000;
const CPU = 700;

const seeded = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return (((mixed ^ (mixed >>> 14)) >>> 0) + 1) / 2 ** 32;
  };
};

type Work = { running: (at: number) => boolean; seen: (at: number) => void; done: () => boolean; used: () => number; wall: () => number };

const alternating = (random: () => number, onMs: number, offMs: number): Work => {
  const edges: number[] = [];
  let at = 0;
  let used = 0;
  while (used < CPU) {
    const run = onMs * (0.98 + 0.04 * random());
    edges.push(at, at + run);
    at += run + offMs * (0.95 + 0.1 * random());
    used += run;
  }
  const end = edges[edges.length - 1] ?? 0;
  const running = (time: number) => {
    let low = 0;
    let high = edges.length / 2 - 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (time < (edges[2 * middle] ?? 0)) high = middle - 1;
      else if (time >= (edges[2 * middle + 1] ?? 0)) low = middle + 1;
      else return true;
    }
    return false;
  };
  let now = 0;
  return { running, seen: (time) => (now = time), done: () => now >= end, used: () => used, wall: () => end };
};

const watching = (idleMs: number): Work => {
  let used = 0;
  let idleUntil = -1;
  let wall = 0;
  let lastSeen = 0;
  return {
    running: (time) => time >= idleUntil,
    seen: (time) => {
      const ranFrom = Math.max(lastSeen, idleUntil);
      used += Math.max(0, time - ranFrom);
      wall = time;
      if (time >= idleUntil) idleUntil = time + idleMs;
      lastSeen = time;
    },
    done: () => used >= CPU,
    used: () => used,
    wall: () => wall,
  };
};

const metered = (work: Work, random: () => number, meanMs: number) => {
  let waits: Waits = { idleMs: 0, ioMs: 0 };
  let before = "run";
  let at = 0;
  while (!work.done()) {
    at += sampleGapMs(random(), meanMs);
    const state = work.running(at) ? "run" : "idle";
    work.seen(at);
    waits = waitedAt(waits, state, before, meanMs, 0);
    before = state;
  }
  return { charged: work.used() + waits.idleMs, truth: work.wall() };
};

describe("the plain Node launcher's count of the time a case waits by its own choice", () => {
  it("credits an idle or disk sample the mean gap it was drawn with, and a skipped part only between two samples of the same kind", () => {
    const none = { idleMs: 0, ioMs: 0 };
    expect(waitedAt(none, "idle", "run", 4, 3)).toEqual({ idleMs: 4, ioMs: 0 });
    expect(waitedAt(none, "idle", "idle", 4, 3)).toEqual({ idleMs: 7, ioMs: 0 });
    expect(waitedAt(none, "disk", "run", 4, 3)).toEqual({ idleMs: 0, ioMs: 4 });
    expect(waitedAt(none, "disk", "disk", 4, 3)).toEqual({ idleMs: 0, ioMs: 7 });
    expect(waitedAt(none, "run", "idle", 4, 3)).toEqual(none);
    expect(waitedAt({ idleMs: 10, ioMs: 20 }, "idle", "disk", 4, 3)).toEqual({ idleMs: 14, ioMs: 20 });
  });

  it("draws memoryless gaps around the mean, so a case that saw the last sample learns nothing of the next", () => {
    expect(sampleGapMs(1, 5)).toBe(0);
    expect(sampleGapMs(Math.exp(-1), 5)).toBeCloseTo(5, 12);
    const random = seeded(7);
    const gaps = Array.from({ length: 200_000 }, () => sampleGapMs(random(), 4));
    const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
    const past = gaps.filter((gap) => gap > 3);
    const pastMean = past.reduce((sum, gap) => sum + gap - 3, 0) / past.length;
    expect(Math.abs(mean - 4)).toBeLessThan(0.05);
    expect(Math.abs(pastMean - 4)).toBeLessThan(0.1);
  });

  it("samples as often as its own cost and the container's share allow, between the fewest and the most milliseconds", () => {
    expect(sampleMeanMs(0, 1, NODE_SAMPLE_LOAD, NODE_SAMPLE_FEWEST_MS, NODE_SAMPLE_MS)).toBe(NODE_SAMPLE_FEWEST_MS);
    expect(sampleMeanMs(0.1, 1, NODE_SAMPLE_LOAD, NODE_SAMPLE_FEWEST_MS, NODE_SAMPLE_MS)).toBeCloseTo(0.1 * NODE_SAMPLE_LOAD, 12);
    expect(sampleMeanMs(0.1, 0.1, NODE_SAMPLE_LOAD, NODE_SAMPLE_FEWEST_MS, NODE_SAMPLE_MS)).toBe(NODE_SAMPLE_MS);
    expect(sampleMeanMs(5, 1, NODE_SAMPLE_LOAD, NODE_SAMPLE_FEWEST_MS, NODE_SAMPLE_MS)).toBe(NODE_SAMPLE_MS);
  });

  it("charges work that runs 1 ms and waits 1 ms past its budget, at every mean gap, though most gaps hold both", () => {
    for (const meanMs of [NODE_SAMPLE_FEWEST_MS, 2.5, NODE_SAMPLE_MS]) {
      const random = seeded(meanMs * 1_000);
      const runs = Array.from({ length: 300 }, () => metered(alternating(random, 1, 1.08), random, meanMs));
      const truth = runs.reduce((sum, run) => sum + run.truth, 0) / runs.length;
      const charged = runs.reduce((sum, run) => sum + run.charged, 0) / runs.length;
      expect(Math.min(...runs.map((run) => run.charged)), `${meanMs}`).toBeGreaterThan(BUDGET);
      expect(Math.abs(charged - truth) / truth, `${meanMs}`).toBeLessThan(0.02);
    }
  });

  it("charges work that runs only until it sees a sample and then waits, as much as it truly used", () => {
    for (const idleMs of [0.5, 2, 5]) {
      const random = seeded(idleMs * 100);
      const runs = Array.from({ length: 300 }, () => metered(watching(idleMs), random, 2.5));
      const truth = runs.reduce((sum, run) => sum + run.truth, 0) / runs.length;
      const charged = runs.reduce((sum, run) => sum + run.charged, 0) / runs.length;
      expect(Math.abs(charged - truth) / truth, `${idleMs}`).toBeLessThan(0.02);
    }
  });
});
