import type { TransactionSigner } from "@solana/kit";
import type { Lookup } from "./address-ranges.js";
import { createClient as webClient } from "./client.js";
import type { Client, ClientOptions } from "./client-types.js";
import { type CheckedFetch, FetchFailed } from "./fetch-failed.js";
import type { SpecFetch } from "./job-specs.js";
import { pinnedFetch } from "./pinned-fetch.js";
import { systemLookup } from "./public-host.js";
import { connect as webConnect } from "./simple.js";
import type { ClusterChoice, ConnectSettings, SimpleClient } from "./simple-types.js";

export { ledgerModule, ledgerSigner, messageHash, notOwnEnvelope, openUsb, plainLedgerError } from "./ledger.js";
export { pinnedFetch } from "./pinned-fetch.js";
export { systemLookup } from "./public-host.js";

export type NodeFetchOptions = { fetch?: CheckedFetch; lookup?: Lookup };

export type NodeClientOptions = Omit<ClientOptions, "fetch" | "lookup"> & NodeFetchOptions;

export type NodeConnectOptions<S extends TransactionSigner = TransactionSigner> = ClusterChoice & ConnectSettings<S> & NodeFetchOptions;

export function checkedFetch(get: CheckedFetch): SpecFetch {
  return (url, init) => {
    const { addresses } = init;
    if (addresses === undefined) {
      return Promise.reject(new FetchFailed(url, "no-address", "no checked address to connect to"));
    }
    return get(url, { redirect: init.redirect, signal: init.signal, addresses });
  };
}

const hardened = (options: NodeFetchOptions): { fetch: SpecFetch; lookup: Lookup } => ({
  fetch: options.fetch === undefined ? pinnedFetch : checkedFetch(options.fetch),
  lookup: options.lookup ?? systemLookup,
});

export function createClient(options: NodeClientOptions): Client {
  return webClient({ ...options, ...hardened(options) });
}

export function connect<S extends TransactionSigner>(options: NodeConnectOptions<S>): Promise<SimpleClient<S>> {
  return webConnect({ ...options, ...hardened(options) });
}
