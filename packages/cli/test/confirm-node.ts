import type { Address, KeyPairSigner } from "@solana/kit";
import { getTokenDecoder, getTokenEncoder } from "@solana-program/token";
import { deliveryBookAddress, getDeliveryBookDecoder, getDeliveryBookEncoder, getIntentDecoder, getIntentEncoder } from "@intent-engine/core";
import type { AccountView, EngineAccount, Transport } from "@intent-engine/client";
import { clusterUrl } from "../src/clusters.js";
import { main } from "../src/main.js";
import { h, runtime, transport } from "./harness.js";

export const SECOND = "testnet";

export const SECOND_URL = clusterUrl(SECOND);

export type Lie = {
  genesis?: string;
  intent?: Address;
  balance?: Address;
  book?: Address;
  accounts?: (found: readonly EngineAccount[]) => EngineAccount[];
  down?: boolean;
};

export type SecondNode = { lie: Lie; reads: number; transport: Transport };

const changed = (view: AccountView): AccountView => {
  const held = getIntentDecoder().decode(view.data);
  return { ...view, data: Uint8Array.from(getIntentEncoder().encode({ ...held, revision: held.revision + 1 })) };
};

const later = (view: AccountView): AccountView => {
  const held = getDeliveryBookDecoder().decode(view.data);
  return { ...view, data: Uint8Array.from(getDeliveryBookEncoder().encode({ ...held, nextSeq: held.nextSeq + 1n })) };
};

const richer = (view: AccountView): AccountView => {
  const held = getTokenDecoder().decode(view.data);
  return { ...view, data: Uint8Array.from(getTokenEncoder().encode({ ...held, amount: held.amount + 1n })) };
};

export function secondNode(): SecondNode {
  const node: SecondNode = { lie: {}, reads: 0, transport };
  const reached = () => {
    node.reads++;
    if (node.lie.down === true) {
      throw new TypeError("fetch failed");
    }
  };
  const read = async (address: Address) => {
    reached();
    const view = await transport.getAccount(address);
    if (view === null) {
      return view;
    }
    return address === node.lie.intent ? changed(view) : address === node.lie.balance ? richer(view) : address === node.lie.book ? later(view) : view;
  };
  node.transport = {
    ...transport,
    getAccount: read,
    getAccounts: (addresses) => Promise.all(addresses.map(read)),
    genesisHash: async () => {
      reached();
      return node.lie.genesis ?? h.genesis;
    },
    engineTransactions: async (limit, of, memo) => {
      reached();
      return transport.engineTransactions(limit, of, memo);
    },
    engineAccounts: async (filter) => {
      reached();
      const found = (await transport.engineAccounts?.(filter)) ?? [];
      return node.lie.accounts === undefined ? found : node.lie.accounts(found);
    },
    send: async () => {
      throw new Error("the second node sends nothing");
    },
  };
  return node;
}

export async function cliWith(argv: string[], signers: Record<string, KeyPairSigner>, second: SecondNode) {
  const out: string[] = [];
  const err: string[] = [];
  const base = runtime(signers);
  const urls: string[] = [];
  const code = await main(
    argv,
    {
      ...base,
      transport: (url) => {
        urls.push(url);
        return url === SECOND_URL ? second.transport : base.transport(url);
      },
    },
    { out: (t) => out.push(t), err: (t) => err.push(t) },
  );
  return { code, urls, out: out.join("\n"), err: err.join("\n"), json: () => JSON.parse(out.join("\n")) as Record<string, unknown> };
}

export const OTHER_GENESIS = "11111111111111111111111111111111";

export const WORK_URL = "https://" + "example.org/count.mjs";

export type Disagreement = { field: string; lie: Lie; second: string };

export async function disagreements(intent: Address): Promise<Disagreement[]> {
  const book = await deliveryBookAddress(intent);
  return [
    { field: "genesis hash", lie: { genesis: OTHER_GENESIS }, second: `the second ${OTHER_GENESIS}` },
    { field: "intent account", lie: { intent }, second: "the second sha256 " },
    { field: "delivery book", lie: { book }, second: "the second next seq " },
    { field: "announcements", lie: { accounts: (found) => found.slice(1) }, second: "the second " },
  ];
}

export const UNREADABLE: Disagreement = { field: "second node", lie: { down: true }, second: "the second RPC node could not be read (unreadable: fetch failed)" };
