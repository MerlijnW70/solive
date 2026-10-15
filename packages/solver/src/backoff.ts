import type { Address } from "@solana/kit";
import { type Intent, IntentStatus } from "@intent-engine/core";

export const BACKOFF_MAX_INTERVALS = 32;

export type Backoff = {
  waiting(address: Address, intent: Intent): { failures: number; seconds: number } | null;
  failed(address: Address, intent: Intent): void;
  succeeded(address: Address): void;
  retain(intents: readonly { address: Address; intent: Intent }[], now: bigint): void;
  size(): number;
};

const fingerprint = (intent: Intent): string =>
  JSON.stringify(intent, (_, value: unknown) => (typeof value === "bigint" ? value.toString() : value));

const MS_PER_SECOND = 1_000;

export function backoff(interval: number, clock: () => number = Date.now): Backoff {
  const held = new Map<Address, { print: string; failures: number; until: number }>();
  return {
    waiting: (address, intent) => {
      const entry = held.get(address);
      if (entry === undefined) {
        return null;
      }
      if (entry.print !== fingerprint(intent)) {
        held.delete(address);
        return null;
      }
      const left = entry.until - clock();
      return left > 0 ? { failures: entry.failures, seconds: Math.ceil(left / MS_PER_SECOND) } : null;
    },
    failed: (address, intent) => {
      const print = fingerprint(intent);
      const entry = held.get(address);
      const failures = (entry?.print === print ? entry.failures : 0) + 1;
      const wait = interval * Math.min(2 ** (failures - 1), BACKOFF_MAX_INTERVALS);
      held.set(address, { print, failures, until: clock() + wait * MS_PER_SECOND });
    },
    succeeded: (address) => {
      held.delete(address);
    },
    retain: (intents, now) => {
      const open = new Set(
        intents.filter(({ intent }) => intent.status === IntentStatus.Open && now < intent.expiresAt).map(({ address }) => address),
      );
      for (const address of [...held.keys()]) {
        if (!open.has(address)) {
          held.delete(address);
        }
      }
    },
    size: () => held.size,
  };
}

export const backingOff = (failures: number, seconds: number): string =>
  `${failures} fill${failures === 1 ? "" : "s"} of this intent failed in a row; it is tried again in ${seconds} second${seconds === 1 ? "" : "s"}`;
