import { afterEach, describe, expect, it, vi } from "vitest";
import { patiently, sleep } from "../src/rpc-retry.js";
import { stopsFrom } from "../src/stop-scope.js";

const limited = () => new Error("HTTP 429 too many requests");
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a stop scope on waiting and retrying", () => {
  afterEach(() => {
    stopsFrom(() => undefined);
  });

  it("ends a sleep when the scoped signal aborts", async () => {
    const stop = new AbortController();
    stopsFrom(() => stop.signal);
    let woke = false;
    const sleeping = sleep(60_000).then(() => (woke = true));
    await tick();
    expect(woke).toBe(false);
    stop.abort();
    await sleeping;
    expect(woke).toBe(true);
  });

  it("does not sleep at all under a signal that is already aborted", async () => {
    stopsFrom(() => AbortSignal.abort());
    await sleep(60_000);
  });

  it("does not wait to retry a rate limit once the scoped signal aborted", async () => {
    stopsFrom(() => AbortSignal.abort());
    const wait = vi.fn(async () => undefined);
    const call = vi.fn(async () => {
      throw limited();
    });
    await expect(patiently(call, wait)).rejects.toThrow("429");
    expect(wait).not.toHaveBeenCalled();
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("does not retry after a wait during which the scoped signal aborted", async () => {
    const stop = new AbortController();
    stopsFrom(() => stop.signal);
    const wait = vi.fn(async () => stop.abort());
    const call = vi.fn(async () => {
      throw limited();
    });
    await expect(patiently(call, wait)).rejects.toThrow("429");
    expect(wait).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("retries as before with no scope", async () => {
    let tries = 0;
    const answer = await patiently(async () => {
      if (++tries < 3) {
        throw limited();
      }
      return "ok";
    }, async () => undefined);
    expect(answer).toBe("ok");
    expect(tries).toBe(3);
  });
});
