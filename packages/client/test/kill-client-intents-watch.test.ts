import { getEventListeners } from "node:events";
import { type Address, getAddressDecoder } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Intent, IntentStatus } from "@intent-engine/core";
import { getIntentDecoder, getIntentDiscriminatorBytes, getIntentEncoder, getIntentSize, INTENT_VERSION } from "@intent-engine/core/internal";
import { watchIntents } from "../src/client-watch.js";
import { changesFrom, pause } from "../src/intent-notifications.js";
import type { Notifications, ProgramAccount, Transport } from "../src/transport.js";

const key = (byte: number) => getAddressDecoder().decode(new Uint8Array(32).fill(byte));
const A = key(1);
const B = key(2);
const OWNER = key(9);

const blank = new Uint8Array(getIntentSize());
blank.set(getIntentDiscriminatorBytes());
const BASE = { ...getIntentDecoder().decode(blank), owner: OWNER, version: INTENT_VERSION, expiresAt: 1_000n };
const bytes = (patch: Partial<Intent> = {}) => Uint8Array.from(getIntentEncoder().encode({ ...BASE, ...patch }));
const note = (address: Address, data: Uint8Array, slot?: bigint) => ({
  ...(slot === undefined ? {} : { context: { slot } }),
  value: { pubkey: address, account: { data: [Buffer.from(data).toString("base64"), "base64"] } },
});

const until = async (check: () => boolean, ms = 2_500) => {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("condition never held");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function chain(slot: bigint) {
  const ledger = { slot, reads: 0 };
  const transport = {
    intents: async (_owner?: Address, read?: { onSlot?: (slot: bigint) => void }) => {
      ledger.reads++;
      read?.onSlot?.(ledger.slot);
      return [] as ProgramAccount[];
    },
  } as unknown as Transport;
  return { ledger, transport };
}

function stream() {
  const queue: unknown[] = [];
  const live = { open: false, wake: undefined as (() => void) | undefined };
  const notifications: Notifications = async (signal) => {
    live.open = true;
    return {
      async *[Symbol.asyncIterator]() {
        while (!signal.aborted) {
          const next = queue.shift();
          if (next !== undefined) {
            yield next;
            continue;
          }
          await new Promise<void>((resolve) => {
            live.wake = resolve;
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        }
      },
    };
  };
  return {
    live,
    notifications,
    push: (...notes: unknown[]) => {
      queue.push(...notes);
      live.wake?.();
    },
  };
}

type Event = [string, Address, number, bigint | undefined];

function recorder() {
  const events: Event[] = [];
  const callback = (changed: { address: Address; intent: Intent; slot?: bigint }[], closed: { address: Address; intent: Intent; slot?: bigint }[]) => {
    events.push(...changed.map(({ address, intent, slot }): Event => ["changed", address, intent.status, slot]));
    events.push(...closed.map(({ address, intent, slot }): Event => ["closed", address, intent.status, slot]));
  };
  return { events, callback };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("a watch that ignores what the chain already said", () => {
  it("drops a notification at the slot of the full read it follows", async () => {
    const { ledger, transport } = chain(90n);
    const socketed = stream();
    const { events, callback } = recorder();
    const controller = new AbortController();
    const watching = watchIntents(transport, socketed.notifications, 5, 60)(callback, controller.signal);
    await until(() => ledger.reads === 1 && socketed.live.open);
    socketed.push(note(A, bytes({ status: IntentStatus.Filled }), 90n), note(B, bytes({ status: IntentStatus.Open }), 91n));
    await until(() => events.length === 1);
    controller.abort();
    await watching;
    expect(events).toEqual([["changed", B, IntentStatus.Open, 91n]]);
  });

  it("drops a notification at the slot it already reported for that address", async () => {
    const { ledger, transport } = chain(90n);
    const socketed = stream();
    const { events, callback } = recorder();
    const controller = new AbortController();
    const watching = watchIntents(transport, socketed.notifications, 5, 60)(callback, controller.signal);
    await until(() => ledger.reads === 1 && socketed.live.open);
    socketed.push(note(A, bytes({ status: IntentStatus.Open }), 95n));
    await until(() => events.length === 1);
    socketed.push(note(A, bytes({ status: IntentStatus.Filled }), 95n), note(B, bytes({ status: IntentStatus.Open }), 96n));
    await until(() => events.length === 2);
    controller.abort();
    await watching;
    expect(events).toEqual([
      ["changed", A, IntentStatus.Open, 95n],
      ["changed", B, IntentStatus.Open, 96n],
    ]);
  });

  it("does not reread the chain for a notification that carries a slot before the interval has passed", async () => {
    const { ledger, transport } = chain(90n);
    const socketed = stream();
    const { events, callback } = recorder();
    const controller = new AbortController();
    const watching = watchIntents(transport, socketed.notifications, 5, 60)(callback, controller.signal);
    await until(() => ledger.reads === 1 && socketed.live.open);
    await settle(30);
    socketed.push(note(A, bytes({ status: IntentStatus.Open }), 95n));
    await until(() => events.length === 1);
    await settle(60);
    controller.abort();
    await watching;
    expect(ledger.reads).toBe(1);
  });

  it("rereads the chain once a whole interval has passed, to the millisecond", async () => {
    vi.useFakeTimers();
    const { ledger, transport } = chain(90n);
    const socketed = stream();
    const controller = new AbortController();
    const watching = watchIntents(transport, socketed.notifications, 5, 1)(() => undefined, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(ledger.reads).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(ledger.reads).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(ledger.reads).toBe(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ledger.reads).toBe(3);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    await watching;
  });
});

describe("the notification stream", () => {
  const driven = () => {
    const queue: ((value: IteratorResult<unknown>) => void)[] = [];
    const changes = changesFrom(async () => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>((resolve) => queue.push(resolve)) }) }));
    const flush = () => vi.advanceTimersByTimeAsync(0);
    const push = async (value: unknown) => {
      await flush();
      queue.shift()?.({ value, done: false });
      await flush();
    };
    return { changes, flush, push };
  };

  it("keeps the highest slot it heard, and none before it hears one", async () => {
    vi.useFakeTimers();
    const { changes, flush, push } = driven();
    await flush();
    expect(changes.slot()).toBeUndefined();
    await push(note(A, bytes(), 10n));
    expect(changes.slot()).toBe(10n);
    await push(note(B, bytes(), 5n));
    expect(changes.slot()).toBe(10n);
    await push(note(A, bytes(), 12n));
    expect(changes.slot()).toBe(12n);
    await push(note(A, bytes()));
    expect(changes.slot()).toBe(12n);
    changes.close();
  });

  it("keeps waiting as long as the longest pause after every failure that follows", async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const opened: number[] = [];
    const failing = () => {
      throw new Error("refused");
    };
    const streams: (() => AsyncIterable<unknown>)[] = [failing, failing, failing];
    const changes = changesFrom(async () => {
      opened.push(Date.now() - started);
      const next = streams.shift();
      if (next !== undefined) {
        return next();
      }
      return { [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<unknown>>(() => undefined) }) };
    }, [10, 20]);
    await vi.advanceTimersByTimeAsync(49);
    expect(opened).toEqual([0, 10, 30]);
    await vi.advanceTimersByTimeAsync(1);
    expect(opened).toEqual([0, 10, 30, 50]);
    changes.close();
  });

  it("leaves no listener on the signal of a pause that an abort ended", async () => {
    const controller = new AbortController();
    const paused = pause(60_000, controller.signal);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
    controller.abort();
    await paused;
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});
