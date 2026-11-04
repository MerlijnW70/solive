import { CLUSTER_NAMES, CLUSTER_URLS, urlOfClusterName } from "@intent-engine/client/internal";
import { UsageError } from "./arg-values.js";

export const DEFAULT_URL = CLUSTER_URLS.localnet;

export const CLUSTERS: Readonly<Record<string, string>> = Object.fromEntries(["localnet", "devnet", "testnet", "mainnet-beta"].map((name) => [name, urlOfClusterName(name)]));

export const ENV_URL = "INTENT_ENGINE_URL";
export const ENV_KEYPAIR = "INTENT_ENGINE_KEYPAIR";

export const SAVED_CONFIRM_URL = "confirm-url";

export const WALLET_NOT_MAINNET = "mcp --wallet keeps its key in a file on this machine, so it serves devnet, testnet and localnet only";

export function clusterUrl(text: string): string {
  if (text.includes("://")) {
    return text;
  }
  try {
    return urlOfClusterName(text);
  } catch {
    throw new UsageError(`${text} is neither an RPC url nor one of ${Object.keys(CLUSTER_NAMES).join(", ")}`);
  }
}
