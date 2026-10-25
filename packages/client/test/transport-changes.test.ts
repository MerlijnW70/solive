import type { Address } from "@solana/kit";
import { getEventListeners } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { changedAccount, changesFrom, socketUrl } from "../src/transport.js";
import { isolateMocks, OTHER, OWNER } from "./transport-stub.js";

isolateMocks();

describe("intent changes", () => {
  it("opens the websocket the cluster serves next to its RPC", () => {
    expect(socketUrl("https://api.devnet.solana.com")).toBe("wss://api.devnet.solana.com/");
    expect(socketUrl("http://127.0.0.1:8899")).toBe("ws://127.0.0.1:8900/");
    expect(socketUrl("https://rpc.example/key?x=1")).toBe("wss://rpc.example/key?x=1");
  });

  const note = (address: Address, byte: number) => ({
    context: { slot: 1n },
    value: { pubkey: address, account: { data: [Buffer.from([byte]).toString("base64"), "base64"] } },
  });

  it("reads the changed intent out of a notification and ignores anything else", () => {
    expect(changedAccount(note(OWNER, 7))).toEqual({ address: OWNER, data: new Uint8Array([7]) });
    for (const junk of [null, {}, { value: { pubkey: OWNER } }, { value: { pubkey: 1, account: { data: ["", "base64"] } } }]) {
      expect(changedAccount(junk)).toBeNull();
    }
  });

  it("wakes with the intents that changed, keeps only the latest data of each, else wakes empty after the interval", async () => {
    vi.useFakeTimers();
    const queue: ((value: IteratorResult<unknown>) => void)[] = [];
    let aborted = false;
    const changes = changesFrom(async (signal) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      return { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>((resolve) => queue.push(resolve)) }) };
    });
    const flush = () => vi.advanceTimersByTimeAsync(0);
    const push = async (value: unknown) => {
      await flush();
      queue.shift()?.({ value, done: false });
      await flush();
    };
    await flush();
    const started = Date.now();
    const woken = changes.wait(60);
    await push(note(OWNER, 1));
    expect(await woken).toEqual([{ address: OWNER, data: new Uint8Array([1]) }]);
    expect(Date.now()).toBe(started);
    await push(note(OTHER, 2));
    await push(note(OTHER, 3));
    await push({ unrelated: true });
    expect(await changes.wait(60)).toEqual([{ address: OTHER, data: new Uint8Array([3]) }]);
    let idle: unknown;
    void changes.wait(0.05).then((woke) => {
      idle = woke;
    });
    await vi.advanceTimersByTimeAsync(49);
    expect(idle).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(idle).toEqual([]);
    changes.close();
    expect(aborted).toBe(true);
  });

  it("reconnects after the stream fails or ends, waiting longer after each failure and starting over once it hears again", async () => {
    vi.useFakeTimers();
    const opened: number[] = [];
    const started = Date.now();
    const streams: (() => AsyncIterable<unknown>)[] = [
      () => {
        throw new Error("refused");
      },
      () => {
        throw new Error("refused again");
      },
      () => ({
        [Symbol.asyncIterator]: () => {
          let sent = false;
          return {
            next: async () => {
              if (sent) {
                return { value: undefined, done: true };
              }
              sent = true;
              return { value: note(OWNER, 9), done: false };
            },
          };
        },
      }),
    ];
    let quiet: (() => void) | undefined;
    let shared: AbortSignal | undefined;
    const changes = changesFrom(async (signal) => {
      shared = signal;
      opened.push(Date.now() - started);
      const stream = streams.shift();
      if (stream !== undefined) {
        return stream();
      }
      return { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>((resolve) => (quiet = () => resolve({ value: undefined, done: true }))) }) };
    }, [20, 60, 1_000]);
    const heard = changes.wait(5);
    await vi.advanceTimersByTimeAsync(79);
    expect(opened).toEqual([0, 20]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await heard).toEqual([{ address: OWNER, data: new Uint8Array([9]) }]);
    await vi.advanceTimersByTimeAsync(19);
    expect(opened).toEqual([0, 20, 80]);
    await vi.advanceTimersByTimeAsync(1);
    expect(opened).toEqual([0, 20, 80, 100]);
    expect(shared === undefined ? -1 : getEventListeners(shared, "abort").length).toBe(0);
    changes.close();
    quiet?.();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(opened).toEqual([0, 20, 80, 100]);
  });

  it("falls back to the interval when the websocket cannot be opened", async () => {
    vi.useFakeTimers();
    const changes = changesFrom(async () => {
      throw new Error("no websocket");
    });
    let woke: unknown;
    void changes.wait(0.05).then((changed) => {
      woke = changed;
    });
    await vi.advanceTimersByTimeAsync(49);
    expect(woke).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(woke).toEqual([]);
    changes.close();
  });
});
