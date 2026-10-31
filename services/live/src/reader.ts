import { type Address, createSolanaRpcFromTransport, type RpcTransport, type Signature } from "@solana/kit";
import { type Client, createClient, type EngineTransaction, type IntentAccount, type ListedSignature } from "@intent-engine/client";
import { type RpcLike, rpcTransport } from "@intent-engine/client/internal";
import { IntentStatus, Kind } from "@intent-engine/core";
import { INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core/internal";
import { CLUSTER } from "./limits.js";

export type Reader = {
  newSignatures(limit: number, until: string | null): Promise<ListedSignature[]>;
  transactions(listed: readonly ListedSignature[]): Promise<EngineTransaction[]>;
  openJobs(): Promise<IntentAccount[]>;
  lastActivity(wallet: Address): Promise<bigint | null>;
  lamports(wallet: Address): Promise<bigint>;
  decimals(mint: Address): Promise<number>;
};

export function readerOf(transport: RpcTransport): Reader {
  const rpc = createSolanaRpcFromTransport(transport);
  const client: Client = createClient({ url: CLUSTER, transport: rpcTransport(rpc as unknown as RpcLike) });
  return {
    async newSignatures(limit, until) {
      const listed = await rpc
        .getSignaturesForAddress(INTENT_ENGINE_PROGRAM_ADDRESS, { limit, commitment: "confirmed", ...(until === null ? {} : { until: until as Signature }) })
        .send();
      return listed.map((entry) => ({
        signature: entry.signature,
        slot: entry.slot,
        blockTime: entry.blockTime === null ? null : BigInt(entry.blockTime),
        failed: entry.err !== null,
        memo: null,
      }));
    },
    transactions: (listed) => (listed.length === 0 ? Promise.resolve([]) : client.transport.transactionsOf!(listed)),
    async openJobs() {
      const { intents } = await client.intents({ kind: Kind.AttestedResult, status: IntentStatus.Open });
      return intents;
    },
    async lastActivity(wallet) {
      const [newest] = await client.transport.signaturesOf!(wallet, 1);
      return newest?.blockTime ?? null;
    },
    async lamports(wallet) {
      return (await client.transport.getAccount(wallet))?.lamports ?? 0n;
    },
    async decimals(mint) {
      return (await client.mint(mint)).decimals;
    },
  };
}
