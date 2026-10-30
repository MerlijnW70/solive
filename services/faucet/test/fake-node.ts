import { generateKeyPairSync } from "node:crypto";
import {
  createKeyPairSignerFromBytes,
  createSolanaRpcFromTransport,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type Address,
  type RpcTransport,
} from "@solana/kit";
import { CallerLimit } from "../src/callers.js";
import type { Clock, FaucetRpc } from "../src/chain.js";
import type { DripDeps } from "../src/drip.js";
import { DEVNET_GENESIS_HASH, FLOOR_LAMPORTS } from "../src/limits.js";

export const START_MS = Date.UTC(2026, 9, 30, 12);
export const BLOCKHASH = "4uhcVJyU9pJkvQyS88uRDiswHXSCkY3zQawwpjk2NsNY";

export type Listed = { readonly signature: string; readonly blockTime: number | null; readonly err?: unknown };
export type Landed = { readonly feePayer: string; readonly err?: unknown } | null;
export type Status = { readonly confirmationStatus: string; readonly err?: unknown } | null;
export type Sent = { readonly from: string; readonly to: string; readonly program: string; readonly data: Uint8Array; readonly signature: string };

export type Faucet = { readonly secret: string; readonly bytes: number[]; readonly address: Address };

export async function newFaucet(): Promise<Faucet> {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d ?? "", "base64url");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x ?? "", "base64url");
  const bytes = [...seed, ...pub];
  const signer = await createKeyPairSignerFromBytes(Uint8Array.from(bytes));
  return { secret: JSON.stringify(bytes), bytes, address: signer.address };
}

export class FakeNode {
  genesis = DEVNET_GENESIS_HASH;
  readonly balances = new Map<string, bigint>();
  readonly listed = new Map<string, Listed[]>();
  readonly landed = new Map<string, Landed>();
  statuses: (polls: number) => Status = () => ({ confirmationStatus: "confirmed" });
  readonly failing = new Set<string>();
  readonly calls: { method: string; params: unknown[] }[] = [];
  readonly sent: Sent[] = [];
  polls = 0;

  constructor(readonly faucet: Faucet) {
    this.balances.set(faucet.address, FLOOR_LAMPORTS * 4n);
  }

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }

  transport: RpcTransport = (async ({ payload }: { payload: unknown }) => {
    const { method, params, id } = payload as { method: string; params: unknown[]; id: unknown };
    this.calls.push({ method, params });
    if (this.failing.has(method)) return { jsonrpc: "2.0", id, error: { code: -32000, message: `${method} is down` } };
    return { jsonrpc: "2.0", id, result: this.answer(method, params) };
  }) as RpcTransport;

  rpc(): FaucetRpc {
    return createSolanaRpcFromTransport(this.transport);
  }

  private answer(method: string, params: unknown[]): unknown {
    const context = { slot: 7 };
    switch (method) {
      case "getGenesisHash":
        return this.genesis;
      case "getBalance":
        return { context, value: Number(this.balances.get(params[0] as string) ?? 0n) };
      case "getSignaturesForAddress": {
        const config = (params[1] ?? {}) as { before?: string; limit?: number };
        const all = this.listed.get(params[0] as string) ?? [];
        const from = config.before === undefined ? 0 : all.findIndex((entry) => entry.signature === config.before) + 1;
        return all.slice(from, from + (config.limit ?? 1000)).map((entry) => ({
          signature: entry.signature,
          blockTime: entry.blockTime,
          err: entry.err ?? null,
          slot: 5,
          memo: null,
          confirmationStatus: "finalized",
        }));
      }
      case "getTransaction": {
        const landed = this.landed.get(params[0] as string);
        if (landed === undefined || landed === null) return null;
        return {
          slot: 5,
          blockTime: null,
          meta: { err: landed.err ?? null, fee: 5000, preBalances: [], postBalances: [] },
          transaction: { signatures: [params[0]], message: { accountKeys: [landed.feePayer], instructions: [], recentBlockhash: BLOCKHASH } },
        };
      }
      case "getLatestBlockhash":
        return { context, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 900 } };
      case "sendTransaction":
        return this.receive(params[0] as string);
      case "getSignatureStatuses": {
        this.polls += 1;
        const status = this.statuses(this.polls);
        return {
          context,
          value: [status === null ? null : { slot: 6, confirmations: 0, err: status.err ?? null, status: { Ok: null }, confirmationStatus: status.confirmationStatus }],
        };
      }
      default:
        throw new Error(`unexpected method ${method}`);
    }
  }

  private receive(wire: string): string {
    const transaction = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
    const message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
    if (!("instructions" in message) || message.version !== 0) throw new Error("expected a version 0 message");
    const instruction = message.instructions[0];
    const keys = message.staticAccounts;
    const signature = getSignatureFromTransaction(transaction);
    if (instruction === undefined || message.instructions.length !== 1) throw new Error("expected one instruction");
    const [fromIndex, toIndex] = instruction.accountIndices ?? [];
    this.sent.push({
      from: keys[fromIndex ?? -1] ?? "",
      to: keys[toIndex ?? -1] ?? "",
      program: keys[instruction.programAddressIndex] ?? "",
      data: Uint8Array.from(instruction.data ?? []),
      signature,
    });
    return signature;
  }
}

export type FakeClock = Clock & { at: number; slept: number[] };

export function fakeClock(start: number = START_MS): FakeClock {
  const clock: FakeClock = {
    at: start,
    slept: [],
    now: () => clock.at,
    sleep: async (ms) => {
      clock.slept.push(ms);
      clock.at += ms;
    },
    signal: () => new AbortController().signal,
  };
  return clock;
}

export type Harness = { node: FakeNode; clock: FakeClock; lines: string[]; deps: DripDeps; secretReads: number };

export function harness(faucet: Faucet, options: { readonly secret?: string | undefined; readonly callers?: CallerLimit } = {}): Harness {
  const secret = "secret" in options ? options.secret : faucet.secret;
  const callers = options.callers ?? new CallerLimit();
  const node = new FakeNode(faucet);
  const clock = fakeClock();
  const lines: string[] = [];
  const h: Harness = {
    node,
    clock,
    lines,
    secretReads: 0,
    deps: {
      rpc: () => node.rpc(),
      secret: () => {
        h.secretReads += 1;
        return secret;
      },
      callers,
      clock,
      log: (line) => lines.push(line),
    },
  };
  return h;
}

export const post = (address: unknown, ip: string = "203.0.113.7") => ({
  method: "POST",
  headers: { "x-forwarded-for": ip },
  body: JSON.stringify({ address }),
});
