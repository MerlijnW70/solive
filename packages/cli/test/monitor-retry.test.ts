import { beforeEach, describe, expect, it } from "vitest";
import type { Transport } from "@intent-engine/client";
import { EXIT_ALERTED, EXIT_OK, main } from "../src/main.js";
import { h, runtime, world } from "./harness.js";
import { listing } from "./monitor-transport.js";

const BASELINE = "/srv/monitor/baseline.json";
const BROKEN = "fetch failed";

type Alert = { kind: string; field: string } & Record<string, unknown>;

async function run(extra: string[], polls: number) {
  const rt = runtime({});
  let poll = 0;
  rt.sleep = async (seconds) => {
    h.sleeps.push(seconds);
    return ++poll < polls;
  };
  const out: string[] = [];
  const code = await main(["monitor", "--expect", BASELINE, ...extra], rt, { out: (t) => out.push(t), err: () => undefined });
  return { code, alerts: out.map((o) => JSON.parse(o) as Alert) };
}

function failing(times: number): Transport {
  let left = times;
  const guard = <A extends unknown[], R>(call: (...args: A) => Promise<R>) => async (...args: A) => {
    if (left > 0) {
      left--;
      throw new Error(BROKEN);
    }
    return call(...args);
  };
  return {
    ...listing,
    getAccounts: guard(listing.getAccounts),
    engineTransactions: guard(listing.engineTransactions),
  };
}

describe("the monitor survives a failing read", () => {
  beforeEach(async () => {
    await world();
    h.through = listing;
    await main(["monitor", "--write-baseline", BASELINE], runtime({}), { out: () => undefined, err: () => undefined });
  });

  const tamper = () => {
    const written = JSON.parse(h.files.get(BASELINE) ?? "{}") as Record<string, unknown>;
    h.files.set(BASELINE, JSON.stringify({ ...written, programHash: "0".repeat(64) }));
  };

  it("reports a program-hash difference seen in a round whose signature read throws", async () => {
    tamper();
    let reads = 0;
    h.through = {
      ...listing,
      engineTransactions: async (limit) => {
        if (reads++ === 0) {
          throw new Error(BROKEN);
        }
        return listing.engineTransactions(limit);
      },
    };
    const watched = await run(["--interval", "5", "--max-fills", "5"], 3);
    expect(watched.alerts.map((a) => a.kind)).toEqual(["rpc", "program-hash"]);
  });

  it("does not turn one transient read failure under --once into an alert", async () => {
    h.through = failing(1);
    const result = await run(["--once"], 1);
    expect(result).toEqual({ code: EXIT_OK, alerts: [] });
    expect(h.sleeps).toEqual([5]);
  });

  it("still alerts under --once when the read keeps failing", async () => {
    h.through = failing(2);
    const result = await run(["--once"], 1);
    expect(result.code).toBe(EXIT_ALERTED);
    expect(result.alerts.map((a) => [a.kind, a.field])).toEqual([["rpc", "read"]]);
    expect(h.sleeps).toEqual([5]);
  });

  it("never retries a real finding away", async () => {
    tamper();
    const result = await run(["--once"], 1);
    expect(result.code).toBe(EXIT_ALERTED);
    expect(result.alerts.map((a) => a.kind)).toEqual(["program-hash"]);
    expect(h.sleeps).toEqual([]);
  });
});
