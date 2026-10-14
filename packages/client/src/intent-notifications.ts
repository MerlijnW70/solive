import {
  type Address,
  type Base58EncodedBytes,
  createSolanaRpcSubscriptions,
  getBase58Decoder,
} from "@solana/kit";
import { getIntentDiscriminatorBytes, getIntentSize, INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core";
import type { ProgramAccount } from "./rpc-shapes.js";

export type IntentChanges = { wait(seconds: number): Promise<ProgramAccount[] | null>; close(): void; slot?(): bigint | undefined };

export type Notifications = (signal: AbortSignal) => Promise<AsyncIterable<unknown>>;

export function socketUrl(url: string): string {
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol === "http:" ? "ws:" : "wss:";
  if (parsed.port === "8899") {
    parsed.port = "8900";
  }
  return parsed.toString();
}

export function intentNotifications(url: string): Notifications {
  const subscriptions = createSolanaRpcSubscriptions(socketUrl(url));
  return (abortSignal) =>
    subscriptions
      .programNotifications(INTENT_ENGINE_PROGRAM_ADDRESS, {
        commitment: "confirmed",
        encoding: "base64",
        filters: [
          { dataSize: BigInt(getIntentSize()) },
          { memcmp: { offset: 0n, bytes: getBase58Decoder().decode(getIntentDiscriminatorBytes()) as Base58EncodedBytes, encoding: "base58" } },
        ],
      })
      .subscribe({ abortSignal });
}

export function changedAccount(note: unknown): ProgramAccount | null {
  const value = (note as { value?: { pubkey?: unknown; account?: { data?: unknown } } } | null)?.value;
  const data = value?.account?.data;
  if (typeof value?.pubkey !== "string" || !Array.isArray(data) || typeof data[0] !== "string") {
    return null;
  }
  return { address: value.pubkey as Address, data: new Uint8Array(Buffer.from(data[0], "base64")) };
}

export const RECONNECT_MS: readonly number[] = [1_000, 2_000, 5_000, 10_000, 30_000];

export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const stop = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    signal.addEventListener("abort", stop, { once: true });
  });
}

export function changesFrom(notifications: Notifications, reconnect: readonly number[] = RECONNECT_MS): IntentChanges {
  const controller = new AbortController();
  const pending = new Map<Address, Uint8Array>();
  let wake: (() => void) | undefined;
  let highest: bigint | undefined;
  const drain = () => {
    const changed = [...pending].map(([address, data]) => ({ address, data }));
    pending.clear();
    return changed;
  };
  let failures = 0;
  const consume = async () => {
    const iterator = (await notifications(controller.signal))[Symbol.asyncIterator]();
    for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) {
      failures = 0;
      const changed = changedAccount(next.value);
      if (changed !== null) {
        const slot = (next.value as { context?: { slot?: unknown } }).context?.slot;
        if (typeof slot === "bigint" && (highest === undefined || slot > highest)) {
          highest = slot;
        }
        pending.set(changed.address, changed.data);
        wake?.();
      }
    }
  };
  const listen = async () => {
    while (!controller.signal.aborted) {
      await consume().catch(() => undefined);
      if (controller.signal.aborted) {
        return;
      }
      await pause(reconnect[Math.min(failures, reconnect.length - 1)] ?? 0, controller.signal);
      failures++;
    }
  };
  void listen();
  return {
    wait: (seconds) =>
      new Promise((resolve) => {
        if (pending.size > 0) {
          resolve(drain());
          return;
        }
        const timer = setTimeout(() => {
          wake = undefined;
          resolve([]);
        }, seconds * 1000);
        wake = () => {
          clearTimeout(timer);
          wake = undefined;
          resolve(drain());
        };
      }),
    close: () => {
      wake?.();
      controller.abort();
    },
    slot: () => highest,
  };
}
