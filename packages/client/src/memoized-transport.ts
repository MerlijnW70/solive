import type { Address } from "@solana/kit";
import type { AccountView, Transport } from "./rpc-shapes.js";

export function boundMembers<T extends object>(inner: T): T {
  const members: Record<PropertyKey, unknown> = {};
  for (let at: object | null = inner; at !== null && at !== Object.prototype; at = Object.getPrototypeOf(at) as object | null) {
    for (const key of Reflect.ownKeys(at)) {
      if (key === "constructor" || Object.prototype.hasOwnProperty.call(members, key)) {
        continue;
      }
      const value: unknown = Reflect.get(inner, key);
      members[key] = typeof value === "function" ? value.bind(inner) : value;
    }
  }
  return members as T;
}

const MEMOIZED = Symbol("memoized");
const UNDERLYING = Symbol("underlying");

export const unmemoized = (transport: Transport): Transport =>
  (transport as { [UNDERLYING]?: Transport })[UNDERLYING] ?? transport;

export function memoized(inner: Transport): Transport {
  if ((inner as { [MEMOIZED]?: true })[MEMOIZED] === true) {
    return inner;
  }
  const members = boundMembers(inner);
  const seen = new Map<Address, Promise<AccountView | null>>();
  const keep = (address: Address, pending: Promise<AccountView | null>) => {
    seen.set(address, pending);
    pending.catch(() => {
      if (seen.get(address) === pending) {
        seen.delete(address);
      }
    });
    return pending;
  };
  const getAccount = (address: Address) => seen.get(address) ?? keep(address, members.getAccount(address));
  const warm = async (addresses: readonly Address[]) => {
    const missing = [...new Set(addresses)].filter((address) => !seen.has(address));
    if (missing.length === 0) {
      return;
    }
    const fetched = members.getAccounts(missing);
    missing.forEach((address, i) => keep(address, fetched.then((views) => views[i] ?? null)));
    await fetched;
  };
  const writing =
    <A extends unknown[], R>(write: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      try {
        return await write(...args);
      } finally {
        seen.clear();
      }
    };
  return {
    ...members,
    [MEMOIZED]: true,
    [UNDERLYING]: inner,
    getAccount,
    send: writing(members.send),
    sendWire: writing(members.sendWire),
    submitWire: writing(members.submitWire),
    airdrop: writing(members.airdrop),
    getAccounts: async (addresses) => {
      await warm(addresses);
      return Promise.all(addresses.map(getAccount));
    },
    warm,
  } as Transport;
}
