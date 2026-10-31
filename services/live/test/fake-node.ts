import { type Address, getBase64Decoder, type RpcTransport } from "@solana/kit";
import { DEVNET_TEST_MINT, INTENT_ENGINE_PROGRAM_ADDRESS, NATIVE_MINT, TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import { type Tx, transactionJson } from "./chain.js";

export type Call = { method: string; params: unknown[] };

type Listed = { signature: string; slot: number; blockTime: number; err: unknown; memo: string | null };

type Request = { method: string; params?: unknown[]; id?: unknown };

const mintData = (decimals: number): string => {
  const data = new Uint8Array(82);
  data[44] = decimals;
  data[45] = 1;
  return getBase64Decoder().decode(data);
};

export class FakeNode {
  readonly calls: Call[] = [];
  readonly program: Listed[] = [];
  readonly transactions = new Map<string, unknown>();
  readonly wallets = new Map<string, Listed[]>();
  readonly lamports = new Map<string, number>();
  readonly decimals = new Map<string, number>([
    [NATIVE_MINT, 9],
    [DEVNET_TEST_MINT, 6],
  ]);
  intents: { pubkey: Address; data: string }[] = [];
  fail: ((call: Call) => unknown) | null = null;
  hang: ((call: Call) => boolean) | null = null;

  add(...txs: Tx[]): void {
    for (const tx of txs) {
      this.program.unshift({ signature: tx.signature, slot: tx.slot, blockTime: tx.blockTime, err: null, memo: tx.memo ?? null });
      this.transactions.set(tx.signature, transactionJson(tx));
    }
  }

  addFailed(signature: string, slot: number, blockTime: number): void {
    this.program.unshift({ signature, slot, blockTime, err: { InstructionError: [0, "Custom"] }, memo: null });
  }

  count(method: string): number {
    return this.calls.filter((call) => call.method === method).length;
  }

  private listed(address: string, config: { limit?: number; until?: string; before?: string }): Listed[] {
    const all = address === INTENT_ENGINE_PROGRAM_ADDRESS ? this.program : (this.wallets.get(address) ?? []);
    const stop = config.until === undefined ? all.length : all.findIndex((entry) => entry.signature === config.until);
    return all.slice(0, stop === -1 ? all.length : stop).slice(0, config.limit ?? 1000);
  }

  private account(address: string): unknown {
    const places = this.decimals.get(address);
    if (places !== undefined) {
      return { owner: TOKEN_PROGRAM_ADDRESS, data: [mintData(places), "base64"], lamports: 1_000_000, executable: false, rentEpoch: 0, space: 82 };
    }
    const lamports = this.lamports.get(address);
    return lamports === undefined ? null : { owner: "11111111111111111111111111111111", data: ["", "base64"], lamports, executable: false, rentEpoch: 0, space: 0 };
  }

  private result(call: Call): unknown {
    const [first, config = {}] = call.params as [unknown, Record<string, unknown> | undefined];
    switch (call.method) {
      case "getSignaturesForAddress":
        return this.listed(first as string, config as { limit?: number; until?: string });
      case "getTransaction":
        return this.transactions.get(first as string) ?? null;
      case "getProgramAccounts": {
        const value = this.intents.map(({ pubkey, data }) => ({ pubkey, account: { owner: INTENT_ENGINE_PROGRAM_ADDRESS, data: [data, "base64"], lamports: 1, executable: false, rentEpoch: 0, space: 464 } }));
        return config["withContext"] === true ? { context: { slot: 1 }, value } : value;
      }
      case "getAccountInfo":
        return { context: { slot: 1 }, value: this.account(first as string) };
      case "getMultipleAccounts":
        return { context: { slot: 1 }, value: (first as string[]).map((address) => this.account(address)) };
      default:
        throw new Error(`the fake node has no ${call.method}`);
    }
  }

  readonly transport: RpcTransport = (async ({ payload, signal }: { payload: unknown; signal?: AbortSignal }) => {
    const request = payload as Request;
    const call: Call = { method: request.method, params: request.params ?? [] };
    this.calls.push(call);
    if (this.hang?.(call) === true) {
      await new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    }
    const failure = this.fail?.(call);
    if (failure !== undefined && failure !== null) {
      throw failure;
    }
    return { jsonrpc: "2.0", id: request.id, result: this.result(call) };
  }) as RpcTransport;
}
