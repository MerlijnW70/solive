import { generateKeyPairSigner, type Address } from "@solana/kit";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { drip, REASONS } from "../src/drip.js";
import { systemClock } from "../src/http.js";
import { CALLER_DRIPS, CONFIRM_TIMEOUT_MS, DRIP_WINDOW_SECS } from "../src/limits.js";
import { harness, newFaucet, post, START_MS, type Faucet } from "./fake-node.js";

const DAY_MS = 86_400_000;

let faucet: Faucet;
let addresses: Address[];

beforeAll(async () => {
  faucet = await newFaucet();
  addresses = await Promise.all(Array.from({ length: 5 }, async () => (await generateKeyPairSigner()).address));
});

afterEach(() => {
  vi.restoreAllMocks();
});

const at = (i: number): Address => addresses[i] as Address;

describe("faucet waits run on elapsed time", () => {
  it("gives up on a confirmation after its timeout by elapsed time, whatever the wall clock does", async () => {
    const h = harness(faucet);
    h.node.statuses = () => null;
    const sleep = h.clock.sleep;
    let steps = 0;
    Object.assign(h.clock, {
      sleep: async (ms: number) => {
        steps += 1;
        h.clock.wall = steps % 2 === 0 ? DAY_MS : -DAY_MS;
        await sleep(ms);
      },
    });
    const response = await drip(post(at(0)), h.deps);
    expect(response.status).toBe(503);
    expect((response.body as { error: string }).error).toContain("did not confirm");
    expect(h.clock.at - START_MS).toBe(CONFIRM_TIMEOUT_MS);
  });

  it("keeps a caller's window by elapsed time, whatever the wall clock does", async () => {
    const h = harness(faucet);
    for (let i = 0; i < CALLER_DRIPS; i += 1) {
      h.clock.at += 1000;
      expect((await drip(post(at(i)), h.deps)).status).toBe(200);
    }
    const first = h.clock.at - 2000;
    h.clock.wall = 2 * DRIP_WINDOW_SECS * 1000;
    const refused = await drip(post(at(3)), h.deps);
    const retry = Math.ceil((first + DRIP_WINDOW_SECS * 1000 - h.clock.at) / 1000);
    expect(refused).toEqual({ status: 429, body: { error: REASONS.caller, retry_after: retry }, headers: { "retry-after": String(retry) } });
    h.clock.wall = -DAY_MS;
    h.clock.at += DRIP_WINDOW_SECS * 1000;
    expect((await drip(post(at(3)), h.deps)).status).toBe(200);
  });

  it("reads performance.now in production, never the wall clock", () => {
    const wall = vi.spyOn(Date, "now").mockReturnValue(0);
    vi.spyOn(performance, "now").mockReturnValue(1_234);
    expect(systemClock.elapsed()).toBe(1_234);
    expect(wall).not.toHaveBeenCalled();
  });
});
