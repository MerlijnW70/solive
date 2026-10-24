import type { Address } from "@solana/kit";
import { IntentUnreadable, StaleRead } from "./client-errors.js";
import type { IntentAccount, WatchCallback, WatchOptions } from "./client-types.js";
import { intentFrom } from "./job-proofs.js";
import { changesFrom, type HeardAccount, type Notifications, pause, type ProgramAccount, type Transport } from "./transport.js";

type Watched = IntentAccount & { slot?: bigint };

export const decoded = ({ address, data }: ProgramAccount): IntentAccount => ({ address, intent: intentFrom(data) });

const keyOf = (data: Uint8Array) => Buffer.from(data).toString("base64");

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
    const seen = new Map<Address, { key: string; view: Watched }>();
    const skipped = new Map<Address, string>();
    const failed = (error: unknown) => {
      if (!signal.aborted) {
        filter.onError?.(error);
      }
    };
    const apply = (account: ProgramAccount, slot: bigint | undefined): Watched[] => {
      const key = keyOf(account.data);
      if (skipped.get(account.address) === key) {
        return [];
      }
      let view: IntentAccount;
      try {
        view = decoded(account);
      } catch (error) {
        skipped.set(account.address, key);
        failed(new IntentUnreadable(account.address, error));
        return [];
      }
      skipped.delete(account.address);
      if (filter.owner !== undefined && view.intent.owner !== filter.owner) {
        return [];
      }
      const known = seen.get(account.address);
      const watched: Watched = slot === undefined ? view : { ...view, slot };
      seen.set(account.address, { key, view: watched });
      return known?.key === key ? [] : [watched];
    };
    let read = false;
    const report = (changed: Watched[], closed: Watched[], first = false) => {
      if ((changed.length > 0 || closed.length > 0 || first) && !signal.aborted) {
        try {
          onChange(changed, closed);
        } catch (error) {
          failed(error);
        }
      }
    };
    let highest: bigint | undefined;
    let covered: bigint | undefined;
    const raise = (slot: bigint | undefined) => {
      if (slot !== undefined && (highest === undefined || slot > highest)) {
        highest = slot;
      }
    };
    const heard = (account: HeardAccount): Watched[] => {
      const { slot } = account;
      const known = seen.get(account.address)?.view.slot;
      if (slot === undefined || (covered !== undefined && slot <= covered) || (known !== undefined && slot <= known)) {
        return [];
      }
      raise(slot);
      return apply(account, slot);
    };
    const sync = async (heardAt?: bigint) => {
      raise(heardAt);
      const floor = highest;
      const reading: { minContextSlot?: bigint; onSlot: (slot: bigint) => void; at?: bigint } = {
        ...(floor === undefined ? {} : { minContextSlot: floor }),
        onSlot: (slot) => {
          reading.at = slot;
        },
      };
      const accounts = await transport.intents({ owner: filter.owner }, reading).catch((error: unknown) => {
        failed(error);
        return null;
      });
      if (accounts === null) {
        return;
      }
      const { at } = reading;
      if (at !== undefined && floor !== undefined && at < floor) {
        failed(new StaleRead(at, floor));
        return;
      }
      raise(at);
      const present = new Set(accounts.map(({ address }) => address));
      const changed = accounts.flatMap((account) => apply(account, at));
      const closed = [...seen].filter(([address]) => !present.has(address)).map(([, { view }]) => view);
      for (const { address } of closed) {
        seen.delete(address);
      }
      for (const address of skipped.keys()) {
        if (!present.has(address)) {
          skipped.delete(address);
        }
      }
      if (at !== undefined && (covered === undefined || at > covered)) {
        covered = at;
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
        const { changed, reconnected } = await changes.next(resyncSeconds);
        report(changed.flatMap(heard), []);
        const unordered = changed.some(({ slot }) => slot === undefined);
        if (!signal.aborted && (reconnected || unordered || Date.now() - synced >= resyncSeconds * 1000)) {
          await sync(changes.slot());
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
