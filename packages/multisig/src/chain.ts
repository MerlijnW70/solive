import {
  type Address,
  type Blockhash,
  createSolanaRpc,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  type Transaction,
} from "@solana/kit";
import { jsonText } from "./engine.js";

export type Simulation = { err: string | null; logs: string[] };

export type Account = { data: Uint8Array; owner: Address };

export type Latest = { blockhash: Blockhash; lastValidBlockHeight: bigint };

export type Chain = {
  account(address: Address): Promise<Account | null>;
  blockhash(): Promise<Latest>;
  genesisHash(): Promise<string>;
  simulate(tx: Transaction): Promise<Simulation>;
  send(tx: Transaction): Promise<string>;
};

const POLL_MS = 500;

export function connectionChain(url: string): Chain {
  const rpc = createSolanaRpc(url);
  const commitment = "confirmed";
  const latest = async (): Promise<Latest> => (await rpc.getLatestBlockhash({ commitment }).send()).value;
  return {
    account: async (address) => {
      const { value } = await rpc.getAccountInfo(address, { commitment, encoding: "base64" }).send();
      return value === null ? null : { data: new Uint8Array(getBase64Encoder().encode(value.data[0])), owner: value.owner };
    },
    blockhash: latest,
    genesisHash: async () => rpc.getGenesisHash().send(),
    simulate: async (tx) => {
      const { value } = await rpc
        .simulateTransaction(getBase64EncodedWireTransaction(tx), { commitment, encoding: "base64", sigVerify: false, replaceRecentBlockhash: true })
        .send();
      return { err: value.err === null ? null : jsonText(value.err), logs: [...(value.logs ?? [])] };
    },
    send: async (tx) => {
      const { lastValidBlockHeight } = await latest();
      const signature = getSignatureFromTransaction(tx);
      await rpc.sendTransaction(getBase64EncodedWireTransaction(tx), { encoding: "base64", preflightCommitment: commitment }).send();
      for (;;) {
        const [status] = (await rpc.getSignatureStatuses([signature]).send()).value;
        if (status !== null && status !== undefined) {
          if (status.err !== null) {
            throw new Error(`transaction ${signature} failed: ${jsonText(status.err)}`);
          }
          if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
            return signature;
          }
        }
        if ((await rpc.getBlockHeight({ commitment }).send()) > lastValidBlockHeight) {
          throw new Error(`transaction ${signature} expired before it was confirmed`);
        }
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
      }
    },
  };
}
