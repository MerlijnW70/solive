import type { Address } from "@solana/kit";
import type { Rent } from "./rent.js";
import type { Chain } from "./solver.js";

export const CONFIG_TTL_MS = 30_000;

export const BLOCKHASH_TTL_MS = 20_000;

export type Remembering = Chain & { forget(): void };

function fresh<T>(ttl: number, clock: () => number, load: () => Promise<T>): { get(): Promise<T>; clear(): void } {
  let held: { at: number; value: Promise<T> } | null = null;
  return {
    get: () => {
      if (held === null || clock() - held.at > ttl) {
        const value = load();
        const entry = { at: clock(), value };
        held = entry;
        value.catch(() => {
          if (held === entry) {
            held = null;
          }
        });
      }
      return held.value;
    },
    clear: () => {
      held = null;
    },
  };
}

export function remembering(chain: Chain, clock: () => number = Date.now): Remembering {
  const programs = new Map<Address, Promise<Address>>();
  const mints = new Map<Address, Promise<Uint8Array | null>>();
  const existing = new Set<Address>();
  const read = chain.rent;
  let rent: Promise<Rent> | null = null;
  const config = fresh(CONFIG_TTL_MS, clock, () => chain.config());
  const blockhash = fresh(BLOCKHASH_TTL_MS, clock, () => chain.blockhash());
  return {
    ...chain,
    config: () => config.get(),
    blockhash: () => blockhash.get(),
    tokenProgram: (mint) => {
      const known = programs.get(mint);
      if (known !== undefined) {
        return known;
      }
      const loaded = chain.tokenProgram(mint);
      programs.set(mint, loaded);
      loaded.catch(() => programs.delete(mint));
      return loaded;
    },
    ...(chain.mintData === undefined
      ? {}
      : {
          mintData: (mint: Address) => {
            const known = mints.get(mint);
            if (known !== undefined) {
              return known;
            }
            const loaded = chain.mintData?.(mint) ?? Promise.resolve(null);
            mints.set(mint, loaded);
            loaded.then(
              (data) => {
                if (data === null) {
                  mints.delete(mint);
                }
              },
              () => mints.delete(mint),
            );
            return loaded;
          },
        }),
    ...(read === undefined
      ? {}
      : {
          rent: () => {
            if (rent === null) {
              const loaded = read.call(chain);
              rent = loaded;
              loaded.catch(() => {
                rent = null;
              });
            }
            return rent;
          },
        }),
    exists: async (address) => {
      if (existing.has(address)) {
        return true;
      }
      const found = await chain.exists(address);
      if (found) {
        existing.add(address);
      }
      return found;
    },
    forget: () => {
      programs.clear();
      existing.clear();
      config.clear();
      blockhash.clear();
    },
  };
}
