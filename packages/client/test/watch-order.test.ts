import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Address, getAddressDecoder, type Signature } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { AccountVersionError, type Intent, IntentStatus, Kind } from "@intent-engine/core";
import { encodeParams, getIntentDecoder, getIntentDiscriminatorBytes, getIntentEncoder, getIntentSize, INTENT_VERSION } from "@intent-engine/core/internal";
import { createClient, FailedOnChain, type Job, type Notifications, type ProgramAccount, type Transport } from "../src/index.js";
import { changesFrom, CLOCK_SYSVAR, confirm, heardSlot, jobPays, openProofEscrows, type RpcLike, signatureWatch } from "../src/internal.js";

const socket = vi.hoisted(() => ({ notes: [] as unknown[] }));

vi.mock("@solana/kit", async (importOriginal) => {
  const real = await importOriginal<typeof import("@solana/kit")>();
  return {
    ...real,
    createSolanaRpcSubscriptions: () => ({
      signatureNotifications: () => ({
        subscribe: async ({ abortSignal }: { abortSignal: AbortSignal }) => ({
          async *[Symbol.asyncIterator]() {
            yield* socket.notes;
            await new Promise<void>((resolve) => abortSignal.addEventListener("abort", () => resolve(), { once: true }));
          },
        }),
      }),
    }),
  };
});

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const PAGE = readFileSync(`${ROOT}/docs/sdk-client.md`, "utf8");
const LOCAL = "http://127.0.0.1:8899";
const SIG = "5".repeat(88) as Signature;

const key = (byte: number) => getAddressDecoder().decode(new Uint8Array(32).fill(byte));
const A = key(1);
const B = key(2);
const C = key(3);
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

function chain(slot: bigint) {
  const state = new Map<Address, Uint8Array>();
  const ledger = { slot, state, reads: 0, holding: false, release: undefined as (() => void) | undefined, hold: false };
  const transport = {
    intents: async (_owner?: Address, read?: { onSlot?: (slot: bigint) => void }) => {
      const at = ledger.slot;
      const snapshot = [...state].map(([address, data]): ProgramAccount => ({ address, data }));
      ledger.reads++;
      if (ledger.hold) {
        ledger.holding = true;
        await new Promise<void>((resolve) => {
          ledger.release = resolve;
        });
        ledger.holding = false;
      }
      read?.onSlot?.(at);
      return snapshot;
    },
  } as unknown as Transport;
  return { ledger, transport };
}

function stream() {
  const queue: unknown[] = [];
  const live = { opens: 0, open: false, ended: false, wake: undefined as (() => void) | undefined };
  const notifications: Notifications = async (signal) => {
    live.opens++;
    live.ended = false;
    live.open = true;
    return {
      async *[Symbol.asyncIterator]() {
        while (!signal.aborted && !live.ended) {
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
        live.open = false;
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
    drop: () => {
      live.ended = true;
      live.wake?.();
    },
  };
}

type Event = [string, Address, number, bigint | undefined];

function recorder() {
  const events: Event[] = [];
  const callback = (
    changed: { address: Address; intent: Intent; slot?: bigint }[],
    closed: { address: Address; intent: Intent; slot?: bigint }[],
  ) => {
    events.push(...changed.map(({ address, intent, slot }): Event => ["changed", address, intent.status, slot]));
    events.push(...closed.map(({ address, intent, slot }): Event => ["closed", address, intent.status, slot]));
  };
  return { events, callback };
}

describe("a watch that trusts only what the chain said last", () => {
  const ordered =
    "Each intent it reports carries the `slot` the node read it at, and the watch never reports a state of an intent older than one it already reported.";
  const closedSentence = "The callback's second argument, `closed`, holds the last state the watch saw of each intent before its account closed.";

  it("drops a notification older than the full read that saw its intent closed", async () => {
    expect(PAGE).toContain(ordered);
    expect(PAGE).toContain(closedSentence);
    const { ledger, transport } = chain(90n);
    ledger.state.set(A, bytes({ status: IntentStatus.Open }));
    const socketed = stream();
    const client = createClient({ url: LOCAL, transport, notifications: socketed.notifications, resyncSeconds: 0.05 });
    const { events, callback } = recorder();
    const controller = new AbortController();
    const watching = client.watch(callback, controller.signal);
    await until(() => events.length === 1);
    expect(events).toEqual([["changed", A, IntentStatus.Open, 90n]]);

    ledger.state.delete(A);
    ledger.slot = 105n;
    ledger.hold = true;
    await until(() => ledger.holding);
    socketed.push(note(A, bytes({ status: IntentStatus.Open, filled: 1n }), 100n));
    await new Promise((resolve) => setTimeout(resolve, 20));
    ledger.hold = false;
    ledger.release?.();
    await until(() => events.length >= 2);
    const reads = ledger.reads;
    await until(() => ledger.reads >= reads + 3);
    controller.abort();
    await watching;
    expect(events).toEqual([
      ["changed", A, IntentStatus.Open, 90n],
      ["closed", A, IntentStatus.Open, 90n],
    ]);
  });

  it("never reports a notification older than one it already reported for that address", async () => {
    const { ledger, transport } = chain(90n);
    const socketed = stream();
    const client = createClient({ url: LOCAL, transport, notifications: socketed.notifications, resyncSeconds: 60 });
    const { events, callback } = recorder();
    const controller = new AbortController();
    const watching = client.watch(callback, controller.signal);
    await until(() => ledger.reads === 1 && socketed.live.open);
    socketed.push(note(A, bytes({ status: IntentStatus.Filled }), 106n));
    await until(() => events.length === 1);
    socketed.push(note(A, bytes({ status: IntentStatus.Open }), 103n), note(B, bytes({ status: IntentStatus.Open }), 104n));
    await until(() => events.length === 2);
    controller.abort();
    await watching;
    expect(events).toEqual([
      ["changed", A, IntentStatus.Filled, 106n],
      ["changed", B, IntentStatus.Open, 104n],
    ]);
  });

  it("keeps the newest of the notifications it holds for one address", async () => {
    const socketed = stream();
    const changes = changesFrom(socketed.notifications);
    await until(() => socketed.live.open);
    socketed.push(note(A, bytes({ status: IntentStatus.Filled }), 106n), note(A, bytes({ status: IntentStatus.Open }), 103n));
    await new Promise((resolve) => setTimeout(resolve, 20));
    const heard = await changes.next(1);
    changes.close();
    expect(heard.reconnected).toBe(false);
    expect(heard.changed.map(({ address, slot, data }) => [address, slot, getIntentDecoder().decode(data).status])).toEqual([[A, 106n, IntentStatus.Filled]]);
  });

  it("rereads the chain at once when the notification stream reconnects", async () => {
    const sentence =
      "With notifications the watch rereads the chain every `resyncSeconds` and at once after the notification stream reconnects; without notifications it rereads every `pollMs`.";
    expect(PAGE).toContain(sentence);
    const { ledger, transport } = chain(90n);
    ledger.state.set(A, bytes({ status: IntentStatus.Open }));
    const socketed = stream();
    const client = createClient({ url: LOCAL, transport, notifications: socketed.notifications, resyncSeconds: 60 });
    const { events, callback } = recorder();
    const controller = new AbortController();
    const watching = client.watch(callback, controller.signal);
    await until(() => events.length === 1 && socketed.live.open);
    socketed.drop();
    await until(() => !socketed.live.open);
    ledger.state.set(A, bytes({ status: IntentStatus.Cancelled }));
    ledger.slot = 120n;
    await until(() => events.length === 2, 5_000);
    controller.abort();
    await watching;
    expect(socketed.live.opens).toBe(2);
    expect(ledger.reads).toBe(2);
    expect(events).toEqual([
      ["changed", A, IntentStatus.Open, 90n],
      ["changed", A, IntentStatus.Cancelled, 120n],
    ]);
  });

  it("polls every pollMs without notifications", async () => {
    const { ledger, transport } = chain(90n);
    const client = createClient({ url: LOCAL, transport, pollMs: 5, resyncSeconds: 60 });
    const controller = new AbortController();
    const watching = client.watch(() => undefined, controller.signal);
    await until(() => ledger.reads >= 5, 1_000);
    controller.abort();
    await watching;
  });

  it("skips an unreadable account and a throwing callback, reports both to onError and goes on", async () => {
    expect(PAGE).toContain(
      "Pass `onError` to hear about failed reads, accounts the watch cannot read and errors the callback throws; the watch skips each and goes on.",
    );
    const { ledger, transport } = chain(90n);
    ledger.state.set(A, bytes({ status: IntentStatus.Open }));
    ledger.state.set(B, bytes({ status: IntentStatus.Open, version: INTENT_VERSION + 1 }));
    const socketed = stream();
    const client = createClient({ url: LOCAL, transport, notifications: socketed.notifications, resyncSeconds: 0.05 });
    const boom = new Error("the callback broke");
    const errors: unknown[] = [];
    const { events, callback } = recorder();
    const controller = new AbortController();
    const watching = client.watch(
      (changed, closed) => {
        callback(changed, closed);
        if (events.length === 1) {
          throw boom;
        }
      },
      controller.signal,
      { onError: (error) => errors.push(error) },
    );
    await until(() => errors.length === 2 && socketed.live.open);
    ledger.state.set(A, bytes({ status: IntentStatus.Cancelled }));
    ledger.slot = 101n;
    socketed.push(note(C, new Uint8Array([1, 2, 3]), 100n), note(A, bytes({ status: IntentStatus.Cancelled }), 101n));
    await until(() => events.length === 2);
    const reads = ledger.reads;
    await until(() => ledger.reads >= reads + 2);
    controller.abort();
    await expect(watching).resolves.toBeUndefined();
    expect(events).toEqual([
      ["changed", A, IntentStatus.Open, 90n],
      ["changed", A, IntentStatus.Cancelled, 101n],
    ]);
    expect(errors).toHaveLength(3);
    expect(String(errors[0])).toContain(`intent ${B} cannot be read`);
    expect((errors[0] as Error).cause).toBeInstanceOf(AccountVersionError);
    expect(errors[1]).toBe(boom);
    expect(String(errors[2])).toContain(`intent ${C} cannot be read`);
  });

  it("rereads the chain for a notification that carries no slot instead of reporting it unordered", async () => {
    const { ledger, transport } = chain(90n);
    const socketed = stream();
    const client = createClient({ url: LOCAL, transport, notifications: socketed.notifications, resyncSeconds: 60 });
    const { events, callback } = recorder();
    const controller = new AbortController();
    const watching = client.watch(callback, controller.signal);
    await until(() => ledger.reads === 1 && socketed.live.open);
    ledger.state.set(A, bytes({ status: IntentStatus.Cancelled }));
    ledger.slot = 95n;
    socketed.push(note(A, bytes({ status: IntentStatus.Open })));
    await until(() => events.length === 1);
    controller.abort();
    await watching;
    expect(ledger.reads).toBe(2);
    expect(events).toEqual([["changed", A, IntentStatus.Cancelled, 95n]]);
  });
});

describe("intent reads that check the version first", () => {
  const PROOF = encodeParams({
    kind: Kind.AttestedResult,
    amountIn: 100n,
    minResult: 1n,
    maxResult: 1n,
    attestor: OWNER,
    specHash: new Uint8Array(32).fill(7),
    judgeFee: 0n,
  });
  const proof = (version: number) => bytes({ kind: Kind.AttestedResult, status: IntentStatus.Open, escrowed: 100n, params: PROOF, version });
  const holding = (accounts: ProgramAccount[]) =>
    ({
      intents: async () => accounts,
      getAccount: async (address: Address) => (address === CLOCK_SYSVAR ? { data: new Uint8Array(40), owner: OWNER, lamports: 1n } : null),
    }) as unknown as Transport;

  it("skips a proof escrow of a future layout of the same size", async () => {
    const accounts = [
      { address: A, data: proof(INTENT_VERSION) },
      { address: B, data: proof(INTENT_VERSION + 1) },
    ];
    expect((await openProofEscrows(holding(accounts))).map(({ address }) => address)).toEqual([A]);
    const job = (intent: Address) => ({ intent, inputMint: OWNER }) as Job;
    const terms = { feeBps: 0, kindFeeMask: 0, kindFeeBps: [], paused: 0, fillDisabledKinds: 0n };
    expect(await jobPays(holding(accounts), [job(A), job(B)], terms, async () => 0)).toEqual([
      { netPay: "100", payable: true },
      { netPay: "0", payable: false },
    ]);
  });

  it("refuses to list an intent of a future layout as if it were current", async () => {
    const client = createClient({ url: LOCAL, transport: holding([{ address: B, data: proof(INTENT_VERSION + 1) }]) });
    await expect(client.intents()).rejects.toThrow(AccountVersionError);
  });
});

describe("a confirmation that waits for a real result", () => {
  const failing = () => {
    let polls = 0;
    const rpc = {
      getSignatureStatuses: () => ({
        send: async () => {
          polls++;
          return {
            context: { slot: 10n },
            value: [polls < 4 ? null : { confirmationStatus: "confirmed", err: { InstructionError: [0, { Custom: 1 }] }, slot: 9n }],
          };
        },
      }),
      getEpochInfo: () => ({ send: async () => ({ blockHeight: 1n, absoluteSlot: 10n }) }),
    } as unknown as RpcLike;
    return { rpc, polls: () => polls };
  };
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));

  it("does not confirm on a malformed signature notification when the transaction later fails", async () => {
    socket.notes = [{ context: { slot: 9n } }, { context: { slot: 9n }, value: {} }, { value: null }, "junk", null];
    const { rpc, polls } = failing();
    await expect(confirm(rpc, SIG, 100n, tick, signatureWatch(LOCAL))).rejects.toThrow(FailedOnChain);
    expect(polls()).toBe(4);
  });

  it("confirms on the first notification that carries a result", async () => {
    socket.notes = [{ context: { slot: 8n }, value: {} }, { context: { slot: 9n }, value: { err: null } }];
    const watch = signatureWatch(LOCAL);
    expect(await watch(SIG, new AbortController().signal)).toEqual({ slot: 9n });
    expect(() => heardSlot(SIG, { context: { slot: 9n }, value: {} })).toThrow(/carries no result/);
    expect(() => heardSlot(SIG, { context: { slot: 9n } })).toThrow(/carries no result/);
  });
});
