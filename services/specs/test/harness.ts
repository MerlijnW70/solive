import { createHash } from "node:crypto";
import { createSolanaRpcFromTransport, getAddressDecoder, getBase58Encoder, type Address, type RpcTransport } from "@solana/kit";
import { type Intent, IntentStatus, Kind } from "@intent-engine/core";
import { encodeParams, getIntentDecoder, getIntentDiscriminatorBytes, getIntentEncoder, getIntentSize, INTENT_ENGINE_PROGRAM_ADDRESS, INTENT_VERSION } from "@intent-engine/core/internal";
import { CallerLimit } from "../src/callers.js";
import { mirror, type MirrorDeps, type MirrorResponse } from "../src/mirror.js";
import type { SpecStore } from "../src/store.js";

export const key = (byte: number): Address => getAddressDecoder().decode(new Uint8Array(32).fill(byte));
export const sha = (bytes: string | Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
export const OWNER = key(9);
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const MAINNET_GENESIS = "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export const MAX_NODE_FILTERS = 4;

const blank = new Uint8Array(getIntentSize());
blank.set(getIntentDiscriminatorBytes());
const BASE: Intent = { ...getIntentDecoder().decode(blank), owner: OWNER, inputMint: key(7), version: INTENT_VERSION, expiresAt: 1_000n };

export const proofIntent = (hex: string, patch: Partial<Intent> = {}): Intent => ({
  ...BASE,
  kind: Kind.AttestedResult,
  status: IntentStatus.Open,
  escrowed: 100n,
  params: encodeParams({ kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: key(8), specHash: Uint8Array.from(Buffer.from(hex, "hex")), judgeFee: 0n }),
  ...patch,
});

export const intentBytes = (intent: Intent): Uint8Array => Uint8Array.from(getIntentEncoder().encode(intent));

type Filter = { dataSize?: number | bigint; memcmp?: { offset: number | bigint; bytes: string; encoding: string } };
export type Lookup = { program: string; signal: AbortSignal | undefined; config: { filters: Filter[]; encoding: string; dataSlice?: { offset: number; length: number } } };

export class FakeNode {
  genesis = DEVNET_GENESIS;
  fails = false;
  readonly accounts: Uint8Array[] = [];
  readonly lookups: Lookup[] = [];
  readonly genesisSignals: (AbortSignal | undefined)[] = [];

  holds(...intents: Intent[]): void {
    this.accounts.push(...intents.map(intentBytes));
  }

  private matching(lookup: Lookup): Uint8Array[] {
    if (lookup.program !== INTENT_ENGINE_PROGRAM_ADDRESS) return [];
    return this.accounts.filter((data) =>
      lookup.config.filters.every((filter) => {
        if (filter.dataSize !== undefined) return data.length === Number(filter.dataSize);
        const wanted = getBase58Encoder().encode(filter.memcmp?.bytes ?? "");
        const offset = Number(filter.memcmp?.offset);
        return wanted.every((byte, i) => data[offset + i] === byte);
      }),
    );
  }

  readonly transport = (async ({ payload, signal }: { payload: { id: unknown; method: string; params: unknown[] }; signal?: AbortSignal }) => {
    if (this.fails) throw new Error("node down");
    const { id, method, params } = payload;
    if (method === "getGenesisHash") {
      this.genesisSignals.push(signal);
      return { jsonrpc: "2.0", id, result: this.genesis };
    }
    if (method === "getProgramAccounts") {
      const lookup = { program: params[0], signal, config: params[1] } as Lookup;
      this.lookups.push(lookup);
      if (lookup.config.filters.length > MAX_NODE_FILTERS) throw new Error(`Too many filters provided; max ${MAX_NODE_FILTERS}`);
      const result = this.matching(lookup).map(() => ({
        pubkey: key(91),
        account: { data: ["", "base64"], executable: false, lamports: 1, owner: INTENT_ENGINE_PROGRAM_ADDRESS, rentEpoch: 0, space: getIntentSize() },
      }));
      return { jsonrpc: "2.0", id, result };
    }
    throw new Error(`unexpected ${method}`);
  }) as unknown as RpcTransport;
}

export class MemoryStore implements SpecStore {
  readonly blobs = new Map<string, Uint8Array>();
  writes = 0;
  raceLost = false;
  counts = 0;
  held = 0;
  totalFails: Error | null = null;
  read = async (hex: string): Promise<Uint8Array | null> => this.blobs.get(hex) ?? null;
  has = async (hex: string): Promise<boolean> => this.blobs.has(hex);
  total = async (): Promise<number> => {
    this.counts += 1;
    if (this.totalFails !== null) throw this.totalFails;
    let sum = this.held;
    for (const bytes of this.blobs.values()) sum += bytes.length;
    return sum;
  };
  write = async (hex: string, bytes: Uint8Array): Promise<boolean> => {
    if (this.raceLost) return false;
    this.writes += 1;
    this.blobs.set(hex, bytes);
    return true;
  };
}

export type Harness = { node: FakeNode; store: MemoryStore; deps: MirrorDeps; clock: { at: number } };

export function harness(callers: CallerLimit = new CallerLimit()): Harness {
  const node = new FakeNode();
  const store = new MemoryStore();
  const clock = { at: Date.UTC(2026, 10, 2, 12) };
  return {
    node,
    store,
    clock,
    deps: {
      rpc: () => createSolanaRpcFromTransport(node.transport),
      store,
      callers,
      now: () => clock.at,
      deadlineMs: 5_000,
      log: () => undefined,
    },
  };
}

export const send = (deps: MirrorDeps, method: string, url: string, body: string | Uint8Array = new Uint8Array(), caller = "198.51.100.1"): Promise<MirrorResponse> => {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return mirror({ method, url, caller, body: async (limit) => (bytes.length > limit ? null : bytes) }, deps);
};

export const errorOf = (response: MirrorResponse): string => (JSON.parse(new TextDecoder().decode(response.body)) as { error: string }).error;
