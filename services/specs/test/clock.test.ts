import { IntentStatus } from "@intent-engine/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CallerLimit } from "../src/callers.js";
import { envDeps, envSweepDeps } from "../src/http.js";
import { PUT_WINDOW_SECS, SWEEP_BUDGET_MS } from "../src/limits.js";
import { REASONS } from "../src/mirror.js";
import { sweep } from "../src/sweep.js";
import { harness, proofIntent, send, settle, sha, stored, sweepDeps } from "./harness.js";

const DAY_MS = 86_400_000;
const SPEC = "deliver a module whose tests pass\n";
const HEX = sha(SPEC);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the spec mirror's waits run on elapsed time", () => {
  it("spends its sweep budget by elapsed time, whatever the wall clock does", async () => {
    const run = async (stepAt: number, stepWall: number) => {
      const h = harness();
      for (const text of ["a\n", "b\n"]) settle(h, await stored(h, text), IntentStatus.Cancelled);
      const mark = h.store.mark;
      h.store.mark = async (pathname) => {
        h.clock.at += stepAt;
        h.clock.wall += stepWall;
        return mark(pathname);
      };
      return sweep(sweepDeps(h));
    };
    expect(await run(0, SWEEP_BUDGET_MS)).toMatchObject({ idled: 2, left: 0 });
    expect(await run(SWEEP_BUDGET_MS, -DAY_MS)).toMatchObject({ idled: 1, left: 1 });
  });

  it("keeps a caller's upload window by elapsed time, whatever the wall clock does", async () => {
    const h = harness(new CallerLimit(1, PUT_WINDOW_SECS));
    h.node.holds(proofIntent(HEX));
    expect((await send(h.deps, "PUT", `/sha256/${HEX}`, SPEC, "198.51.100.1")).status).toBe(201);
    h.clock.wall = 2 * PUT_WINDOW_SECS * 1000;
    const limited = await send(h.deps, "PUT", `/sha256/${HEX}`, SPEC, "198.51.100.1");
    expect(limited.status).toBe(429);
    expect(JSON.parse(new TextDecoder().decode(limited.body))).toStrictEqual({ error: REASONS.caller, retry_after: PUT_WINDOW_SECS });
    h.clock.wall = -DAY_MS;
    h.clock.at += PUT_WINDOW_SECS * 1000;
    expect((await send(h.deps, "PUT", `/sha256/${HEX}`, SPEC, "198.51.100.1")).status).toBe(200);
  });

  it("reads performance.now in production, never the wall clock", () => {
    const wall = vi.spyOn(Date, "now").mockReturnValue(0);
    vi.spyOn(performance, "now").mockReturnValue(1_234);
    expect(envDeps().elapsed()).toBe(1_234);
    expect(envSweepDeps().elapsed()).toBe(1_234);
    expect(wall).not.toHaveBeenCalled();
  });
});
