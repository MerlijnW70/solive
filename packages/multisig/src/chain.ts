import { type AccountInfo, Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";

export type Simulation = { err: string | null; logs: string[] };

export type Chain = {
  account(address: PublicKey): Promise<AccountInfo<Buffer> | null>;
  blockhash(): Promise<string>;
  simulate(tx: VersionedTransaction): Promise<Simulation>;
  send(tx: VersionedTransaction): Promise<string>;
};

export function connectionChain(url: string): Chain {
  const connection = new Connection(url, "confirmed");
  return {
    account: (address) => connection.getAccountInfo(address),
    blockhash: async () => (await connection.getLatestBlockhash()).blockhash,
    simulate: async (tx) => {
      const { value } = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
      return { err: value.err === null ? null : JSON.stringify(value.err), logs: value.logs ?? [] };
    },
    send: async (tx) => {
      const { lastValidBlockHeight } = await connection.getLatestBlockhash();
      const signature = await connection.sendTransaction(tx);
      const blockhash = tx.message.recentBlockhash;
      const confirmed = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight });
      if (confirmed.value.err !== null) {
        throw new Error(`transaction ${signature} failed: ${JSON.stringify(confirmed.value.err)}`);
      }
      return signature;
    },
  };
}

export const asConnection = (chain: Chain): Connection =>
  ({
    getAccountInfo: (address: PublicKey) => chain.account(address),
  }) as unknown as Connection;
