import type { Address } from "@solana/kit";
import { SdkError } from "@intent-engine/core";
import { loopbackUrl } from "./address-ranges.js";
import type { Transport } from "./transport.js";

export const MAINNET_GENESIS_HASH = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const DEVNET_GENESIS_HASH = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const TESTNET_GENESIS_HASH = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsfY";
export const PUBLIC_GENESIS_HASHES: ReadonlySet<string> = new Set([MAINNET_GENESIS_HASH, DEVNET_GENESIS_HASH, TESTNET_GENESIS_HASH]);
export const MAX_SPEC_BYTES = 1_048_576;
export const SPEC_TIMEOUT_MS = 10_000;
export const PLAIN_HTTP_ON_PUBLIC = "is a plain http url, which a public cluster may not use";
export const NOT_HTTP = "is not an http or https url";
export const NOT_PUBLIC_SPEC = "points to a private, loopback or local network address, which is not fetched";
export const SPEC_FETCH_FAILED = "could not be fetched";
export const SPEC_REDIRECTS = "redirects, and a spec url is read without following redirects";

export async function plainHttpOnPublic(transport: Transport, url: string): Promise<boolean> {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return false;
  }
  if (protocol !== "http:" || (transport.offline === true && loopbackUrl(url))) {
    return false;
  }
  return PUBLIC_GENESIS_HASHES.has(await transport.genesisHash());
}

export type SpecRequest = { method?: "GET" | "POST"; headers?: Readonly<Record<string, string>>; body?: string };

export type SpecFetch = (url: string, init: { redirect: "error"; signal: AbortSignal; addresses?: readonly string[] } & SpecRequest) => Promise<Response>;

export class SpecSealed extends SdkError {
  readonly code = "spec-sealed";
  override readonly name = "SpecSealed";
  readonly url: string;
  readonly to: Address[];
  readonly keyed: boolean;

  constructor(url: string, to: Address[], keyed: boolean) {
    super(
      `the spec at ${url} is sealed to ${to.length} invited wallet${to.length === 1 ? "" : "s"}; ${keyed ? "this wallet is not one of them" : "read it with the key of an invited wallet"}`,
    );
    this.url = url;
    this.to = to;
    this.keyed = keyed;
  }
}

export class SpecUnreadable extends SdkError {
  readonly code = "spec-unreadable";
  override readonly name = "SpecUnreadable";
  readonly url: string;

  constructor(url: string, reason: string, options?: ErrorOptions) {
    super(`the spec at ${url} ${reason}`, options);
    this.url = url;
  }
}
