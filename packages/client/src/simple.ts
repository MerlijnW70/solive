import type { Address } from "@solana/kit";
import { formatAmount, NATIVE_MINT } from "@intent-engine/core";
import { createClient } from "./client.js";
import type { ClientOptions } from "./client-types.js";
import { MAINNET_GENESIS_HASH } from "./jobs.js";
import { orderSends, type SimpleContext } from "./simple-orders.js";
import { CLUSTER_URLS, clusterUrl, MainnetNotAllowed, mintOfToken, nameOfMint, wholeTokens } from "./simple-tokens.js";
import type { ConnectOptions, SimpleClient, WalletBalance } from "./simple-types.js";
import { workSends } from "./simple-work.js";

export type {
  Announcement,
  CancelInput,
  ConnectOptions,
  DeliveredWork,
  DeliveriesInput,
  DeliverWorkInput,
  HeldToken,
  LimitInput,
  OpenWork,
  Outcome,
  PayForWorkInput,
  Preview,
  ReceiptInput,
  ReleaseInput,
  ReleaseReceipt,
  Seconds,
  Sent,
  SimpleClient,
  SwapInput,
  WalletBalance,
} from "./simple-types.js";
export { ESCROW_EXPIRES_IN, PREVIEW_SIGNATURE, RECORD_TOKEN_NEEDED } from "./simple-orders.js";
export { notFirstAnnouncer, RELEASE_NEEDS_KEY_PAIR } from "./simple-work.js";
export {
  type Cluster,
  CLUSTER_URLS,
  clusterUrl,
  MAINNET_REFUSED,
  MainnetNotAllowed,
  mintOfToken,
  tokenAmount,
} from "./simple-tokens.js";

const SOL_DECIMALS = 9;

export async function connect(options: ConnectOptions): Promise<SimpleClient> {
  const url = clusterUrl(options);
  const { signer } = options;
  const clientOptions: ClientOptions = {
    url,
    ...(options.transport === undefined ? {} : { transport: options.transport }),
    ...(options.priority === undefined ? {} : { priority: options.priority }),
  };
  const client = createClient(clientOptions);
  if (options.allowMainnet !== true && (await client.transport.genesisHash()) === MAINNET_GENESIS_HASH) {
    throw new MainnetNotAllowed(url);
  }
  const ctx: SimpleContext = { url, signer, client, options: clientOptions };
  const { swap, limit, payForWork } = orderSends(ctx);
  const { findWork, deliver, release, cancel, deliveries, receipt } = workSends(ctx);

  const balance = async (tokens?: readonly string[]): Promise<WalletBalance> => {
    const named = tokens ?? (url === CLUSTER_URLS.devnet ? ["SOL", "TEST"] : ["SOL"]);
    const mints: Address[] = [...new Set(named.map((token) => mintOfToken(token, url)))];
    const { sol, tokens: held } = await client.balances(signer.address, mints);
    const listed = held.map(({ mint, account, amount, decimals }) => ({
      token: nameOfMint(mint),
      mint,
      account,
      amount: formatAmount(amount, decimals),
    }));
    const summary = [
      `${wholeTokens(sol, SOL_DECIMALS, NATIVE_MINT)} in ${signer.address}`,
      ...held.map(({ mint, amount, decimals }) => `${wholeTokens(amount, decimals, mint)}${mint === NATIVE_MINT ? " wrapped" : ""}`),
    ].join(", ");
    return { sol: formatAmount(sol, SOL_DECIMALS), tokens: listed, summary };
  };

  const send = { swap, limit, payForWork, deliver, release, cancel } as Pick<
    SimpleClient,
    "swap" | "limit" | "payForWork" | "deliver" | "release" | "cancel"
  >;

  return {
    url,
    signer,
    client,
    balance,
    ...send,
    findWork,
    deliveries,
    receipt,
    watch: (onChange, signal, filter = { owner: signer.address }) => client.watch(onChange, signal, filter),
  };
}
