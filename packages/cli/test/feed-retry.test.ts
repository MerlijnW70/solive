import { RECONNECT_MS, type Transport } from "@intent-engine/client";
import { describe, expect, it } from "vitest";
import { parse, UsageError } from "../src/args.js";
import { follow } from "../src/event-feed.js";
import { MAX_FILL_FORMAT } from "../src/monitor-args.js";
import type { Runtime } from "../src/runtime.js";

describe("following events through a failing node", () => {
  it("backs off along the reconnect delays and then keeps the longest one", async () => {
    let sleeps = RECONNECT_MS.length + 2;
    const transport = {
      engineTransactions: async () => {
        throw new Error("node down");
      },
    } as unknown as Transport;
    const runtime = { sleep: async () => --sleeps > 0 } as unknown as Runtime;
    const emitted: object[] = [];
    expect(await follow(transport, runtime, 2, 1, (v) => emitted.push(v))).toBe(0);
    const longest = (RECONNECT_MS.at(-1) ?? 0) / 1000;
    expect(emitted.map((v) => (v as { retry_in: number }).retry_in)).toEqual([...RECONNECT_MS.map((ms) => ms / 1000), longest, longest]);
  });
});

describe("monitor limits", () => {
  it("refuses a max-fill without a mint before the equals sign", () => {
    expect(() => parse(["monitor", "--expect", "baseline.json", "--max-fill", "=5"], {})).toThrow(new UsageError(MAX_FILL_FORMAT));
  });
});
