import type { Address } from "@solana/kit";
import { getIntentDecoder } from "@intent-engine/core";
import type { IntentAccount, WatchCallback, WatchOptions } from "./client-types.js";
import { changesFrom, type Notifications, pause, type ProgramAccount, type Transport } from "./transport.js";

export const decoded = ({ address, data }: ProgramAccount): IntentAccount => ({ address, intent: getIntentDecoder().decode(data) });

export function watchIntents(
  transport: Transport,
  notifications: Notifications | undefined,
  pollMs: number,
  resyncSeconds: number,
) {
  const watch = async (onChange: WatchCallback, signal: AbortSignal, filter: WatchOptions = {}) => {
    if (signal.aborted) {
      return;
    }
    const seen = new Map<Address, { key: string; view: IntentAccount }>();
    const fresh = (accounts: readonly ProgramAccount[]) =>
      accounts.flatMap((account) => {
        const view = decoded(account);
        if (filter.owner !== undefined && view.intent.owner !== filter.owner) {
          return [];
        }
        const key = Buffer.from(account.data).toString("base64");
        if (seen.get(account.address)?.key === key) {
          return [];
        }
        seen.set(account.address, { key, view });
        return [view];
      });
    let read = false;
    const report = (changed: IntentAccount[], closed: IntentAccount[], first = false) => {
      if ((changed.length > 0 || closed.length > 0 || first) && !signal.aborted) {
        onChange(changed, closed);
      }
    };
    let highest: bigint | undefined;
    const raise = (slot: bigint | undefined) => {
      if (slot !== undefined && (highest === undefined || slot > highest)) {
        highest = slot;
      }
    };
    const failed = (error: unknown) => {
      if (!signal.aborted) {
        filter.onError?.(error);
      }
    };
    const sync = async (heard?: bigint) => {
      raise(heard);
      const floor = highest;
      const reading: { minContextSlot?: bigint; onSlot: (slot: bigint) => void; at?: bigint } = {
        ...(floor === undefined ? {} : { minContextSlot: floor }),
        onSlot: (slot) => {
          reading.at = slot;
        },
      };
      const accounts = await transport.intents(filter.owner, reading).catch((error: unknown) => {
        failed(error);
        return null;
      });
      if (accounts === null) {
        return;
      }
      if (reading.at !== undefined && floor !== undefined && reading.at < floor) {
        failed(new Error(`the intents read at slot ${reading.at} is older than slot ${floor}, which the watch has already seen`));
        return;
      }
      raise(reading.at);
      const present = new Set(accounts.map(({ address }) => address));
      const changed = fresh(accounts);
      const closed = [...seen].filter(([address]) => !present.has(address)).map(([, { view }]) => view);
      for (const { address } of closed) {
        seen.delete(address);
      }
      report(changed, closed, !read);
      read = true;
    };
    if (notifications === undefined) {
      while (!signal.aborted) {
        await sync();
        await pause(pollMs, signal);
      }
      return;
    }
    const changes = changesFrom(notifications);
    const stop = () => changes.close();
    signal.addEventListener("abort", stop, { once: true });
    try {
      await sync();
      let synced = Date.now();
      while (!signal.aborted) {
        report(fresh((await changes.wait(resyncSeconds)) ?? []), []);
        if (!signal.aborted && Date.now() - synced >= resyncSeconds * 1000) {
          await sync(changes.slot?.());
          synced = Date.now();
        }
      }
    } finally {
      signal.removeEventListener("abort", stop);
      changes.close();
    }
  };
  return watch;
}
