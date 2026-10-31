import type { Address } from "@solana/kit";
import { type Client, type EngineTransaction, type IntentAccount, type ListedSignature, TransportLacks } from "@intent-engine/client";
import { INTENT_ENGINE_PROGRAM_ADDRESS, IntentStatus, Kind } from "@intent-engine/core";
import { guarded } from "./rpc.js";

export type Reader = {
  newSignatures(limit: number, until: string | null): Promise<ListedSignature[]>;
  transactions(listed: readonly ListedSignature[]): Promise<EngineTransaction[]>;
  openJobs(): Promise<IntentAccount[]>;
  lastActivity(wallet: Address): Promise<bigint | null>;
  lamports(wallet: Address): Promise<bigint>;
  decimals(mint: Address): Promise<number>;
};

export function readerOf(client: Client): Reader {
  const { transport } = client;
  const { signaturesOf, transactionsOf } = transport;
  if (signaturesOf === undefined || transactionsOf === undefined) {
    throw new TransportLacks(signaturesOf === undefined ? "signaturesOf" : "transactionsOf");
  }
  const listed = (of: Address, limit: number, until?: string) => guarded(() => signaturesOf.call(transport, of, limit, undefined, until));
  return {
    newSignatures: (limit, until) => listed(INTENT_ENGINE_PROGRAM_ADDRESS, limit, until ?? undefined),
    transactions: (wanted) => (wanted.length === 0 ? Promise.resolve([]) : guarded(() => transactionsOf.call(transport, wanted))),
    openJobs: () => guarded(async () => (await client.intents({ kind: Kind.AttestedResult, status: IntentStatus.Open })).intents),
    async lastActivity(wallet) {
      const [newest] = await listed(wallet, 1);
      return newest?.blockTime ?? null;
    },
    lamports: (wallet) => guarded(async () => (await transport.getAccount(wallet))?.lamports ?? 0n),
    decimals: (mint) => guarded(async () => (await client.mint(mint)).decimals),
  };
}
