import { describe, expect, it } from "vitest";
import { NODE_SAMPLE_FEWEST_MS, NODE_SAMPLE_LOAD, NODE_SAMPLE_MS } from "../src/node-judge.js";
import { type Meter, metered, nextDue, sampleGapMs, sampleMeanMs } from "../src/verdict-model.js";

const BUDGET = 1_000;
const CPU = 700;
const LATE = NODE_SAMPLE_MS;
const START: Meter = { idleMs: 0, ioMs: 0, at: 0, state: "run", open: false };

const sampler = (seen: (at: number) => string | null, woken: (due: number) => number, gapMs: number, until: number) => {
  let meter = START;
  let due = gapMs;
  while (due < until) {
    const at = woken(due);
    const state = seen(at);
    meter = metered(meter, due, at, state, gapMs, LATE);
    due = nextDue(due, at, state !== null, gapMs, LATE);
  }
  return meter;
};

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

const charge = (work: Work, random: () => number, meanMs: number) => {
  let meter = START;
  let due = 0;
  while (!work.done()) {
    due = nextDue(due, due, true, sampleGapMs(random(), meanMs), LATE);
    const state = work.running(due) ? "run" : "idle";
    work.seen(due);
    meter = metered(meter, due, due, state, meanMs, LATE);
  }
  return { charged: work.used() + meter.idleMs, truth: work.wall() };
};

describe("the plain Node launcher's count of the time a case waits by its own choice", () => {
  it("credits a sample on time its mean gap, and a skipped stretch, with no weight, only when the reads on both sides of it saw the same kind of waiting", () => {
    const idle = { ...START, state: "idle" };
    expect(metered(START, 10, 12, "idle", 4, LATE)).toEqual({ idleMs: 4, ioMs: 0, at: 12, state: "idle", open: false });
    expect(metered(START, 10, 12, "disk", 4, LATE)).toEqual({ idleMs: 0, ioMs: 4, at: 12, state: "disk", open: false });
    expect(metered(idle, 10, 12, "run", 4, LATE)).toEqual({ idleMs: 0, ioMs: 0, at: 12, state: "run", open: false });
    expect(metered(START, 10, 10 + LATE, "idle", 4, LATE).idleMs).toBe(4);
    expect(metered(START, 10, 10.5 + LATE, "idle", 4, LATE)).toEqual({ idleMs: 0, ioMs: 0, at: 10.5 + LATE, state: "idle", open: false });
    expect(metered(idle, 10, 10.5 + LATE, "idle", 4, LATE)).toEqual({ idleMs: 10.5 + LATE, ioMs: 0, at: 10.5 + LATE, state: "idle", open: false });
    expect(metered({ ...START, state: "disk" }, 10, 30, "idle", 4, LATE)).toEqual({ idleMs: 0, ioMs: 0, at: 30, state: "idle", open: false });
    expect(metered({ ...START, state: "disk", at: 5 }, 10, 30, "disk", 4, LATE)).toEqual({ idleMs: 0, ioMs: 25, at: 30, state: "disk", open: false });
    const failed = metered(idle, 10, 12, null, 4, LATE);
    expect(failed).toEqual({ ...idle, open: true });
    expect(metered(failed, 14, 15, "idle", 4, LATE)).toEqual({ idleMs: 15, ioMs: 0, at: 15, state: "idle", open: false });
    expect(metered(failed, 14, 15, "run", 4, LATE).idleMs).toBe(0);
  });

  it("draws the next sample a gap after its drawn time when on time, and a gap after the read when late or failed", () => {
    expect(nextDue(10, 12, true, 3, LATE)).toBe(13);
    expect(nextDue(10, 10 + LATE, true, 3, LATE)).toBe(13);
    expect(nextDue(10, 10.5 + LATE, true, 3, LATE)).toBe(13.5 + LATE);
    expect(nextDue(10, 12, false, 3, LATE)).toBe(15);
  });

  it("counts a stall in the launcher by the reads before and after it, with no extra sample at the late wake", () => {
    const stalled = (due: number) => (due >= 60 && due < 130 ? 130 : due);
    expect(sampler((at) => (at < 100 ? "run" : "idle"), stalled, 4, 200)).toEqual({ idleMs: 68, ioMs: 0, at: 198, state: "idle", open: false });
    expect(sampler(() => "idle", stalled, 4, 200)).toEqual({ idleMs: 198, ioMs: 0, at: 198, state: "idle", open: false });
    expect(sampler((at) => (at < 100 ? "idle" : "run"), stalled, 4, 200).idleMs).toBe(56);
    expect(sampler((at) => (at < 100 ? "disk" : "idle"), stalled, 4, 200)).toEqual({ idleMs: 68, ioMs: 56, at: 198, state: "idle", open: false });
    const missing = (at: number) => (at >= 60 && at < 130 ? null : "idle");
    expect(sampler(missing, (due) => due, 4, 200)).toEqual({ idleMs: 196, ioMs: 0, at: 196, state: "idle", open: false });
    expect(sampler((at) => (at >= 60 && at < 130 ? null : at < 100 ? "run" : "idle"), (due) => due, 4, 200).idleMs).toBe(64);
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
      const runs = Array.from({ length: 300 }, () => charge(alternating(random, 1, 1.08), random, meanMs));
      const truth = runs.reduce((sum, run) => sum + run.truth, 0) / runs.length;
      const charged = runs.reduce((sum, run) => sum + run.charged, 0) / runs.length;
      expect(Math.min(...runs.map((run) => run.charged)), `${meanMs}`).toBeGreaterThan(BUDGET);
      expect(Math.abs(charged - truth) / truth, `${meanMs}`).toBeLessThan(0.02);
    }
  });

  it("charges work that runs only until it sees a sample and then waits, as much as it truly used", () => {
    for (const idleMs of [0.5, 2, 5]) {
      const random = seeded(idleMs * 100);
      const runs = Array.from({ length: 300 }, () => charge(watching(idleMs), random, 2.5));
      const truth = runs.reduce((sum, run) => sum + run.truth, 0) / runs.length;
      const charged = runs.reduce((sum, run) => sum + run.charged, 0) / runs.length;
      expect(Math.abs(charged - truth) / truth, `${idleMs}`).toBeLessThan(0.02);
    }
  });
});
