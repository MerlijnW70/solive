import { DEVNET_URL } from "./tokens.js";

export const DEFAULT_URL = "http://127.0.0.1:8899";

export const CLUSTERS: Readonly<Record<string, string>> = {
  localnet: DEFAULT_URL,
  devnet: DEVNET_URL,
  testnet: "https://api.testnet.solana.com",
  "mainnet-beta": "https://api.mainnet-beta.solana.com",
};

export const ENV_URL = "INTENT_ENGINE_URL";
export const ENV_KEYPAIR = "INTENT_ENGINE_KEYPAIR";

export const SAVED_CONFIRM_URL = "confirm-url";

export const WALLET_NOT_MAINNET = "mcp --wallet keeps its key in a file on this machine, so it serves devnet, testnet and localnet only";

export function clusterUrl(text: string): string {
  return CLUSTERS[text] ?? text;
}
