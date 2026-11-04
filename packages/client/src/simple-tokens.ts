import { type Address, isAddress } from "@solana/kit";
import type { ClusterChoice } from "./simple-types.js";
import { DEVNET_TEST_MINT, formatAmount, InvalidInput, NATIVE_MINT, parseAmount, SdkError, tokenName } from "@intent-engine/core";
import { U64_MAX } from "@intent-engine/core/internal";
import { hexBytes } from "./encoding.js";
import { specHashText } from "./spec-hash.js";

export type Cluster = "devnet" | "testnet" | "mainnet" | "localnet";

export const CLUSTER_URLS: Readonly<Record<Cluster, string>> = {
  devnet: "https://api.devnet.solana.com",
  testnet: "https://api.testnet.solana.com",
  mainnet: "https://api.mainnet-beta.solana.com",
  localnet: "http://127.0.0.1:8899",
};

export const CLUSTER_NAMES: Readonly<Record<string, Cluster>> = {
  localnet: "localnet",
  devnet: "devnet",
  testnet: "testnet",
  "mainnet-beta": "mainnet",
  mainnet: "mainnet",
};

export const MAINNET_REFUSED = "this url serves mainnet; pass allowMainnet: true to connect to it";

export class MainnetNotAllowed extends SdkError {
  readonly code = "mainnet-not-allowed";
  override readonly name = "MainnetNotAllowed";
  readonly url: string;

  constructor(url: string) {
    super(`${url}: ${MAINNET_REFUSED}`);
    this.url = url;
  }
}

export function clusterUrl(options: ClusterChoice): string {
  if (options.url !== undefined && options.cluster !== undefined) {
    throw new InvalidInput("cluster", "conflict", "pass cluster or url, not both");
  }
  if (options.url !== undefined) {
    return options.url;
  }
  return urlOfClusterName(options.cluster);
}

export function urlOfClusterName(name: unknown): string {
  if (typeof name !== "string" || !Object.hasOwn(CLUSTER_NAMES, name)) {
    throw new InvalidInput("cluster", "unsupported", `pass url, or cluster as one of ${Object.keys(CLUSTER_NAMES).join(", ")}`);
  }
  return CLUSTER_URLS[CLUSTER_NAMES[name] as Cluster];
}

export function mintOfToken(token: string, url: string, devnet: boolean): Address {
  const name = token.trim();
  if (name.toUpperCase() === "SOL") {
    return NATIVE_MINT;
  }
  if (name.toUpperCase() === "TEST") {
    if (!devnet) {
      throw new InvalidInput("token", "unsupported", `TEST names the devnet test token; on ${url} pass the token's mint address`);
    }
    return DEVNET_TEST_MINT;
  }
  if (!isAddress(name)) {
    throw new InvalidInput("token", "format", `${token} is not SOL, TEST or a token mint address`);
  }
  return name;
}

export const nameOfMint = (mint: Address): string => tokenName(mint) ?? mint;

export function amountText(text: string, decimals: number, field = "amount"): bigint {
  if (typeof text !== "string") {
    throw new InvalidInput(field, "format", `${field}: ${String(text)} is not a token amount like 12 or 0.5`);
  }
  try {
    return parseAmount(text.trim(), decimals);
  } catch (error) {
    throw new InvalidInput(field, "format", `${field}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

export function amountShown(amount: bigint, decimals: number, field = "amount"): string {
  if (typeof amount !== "bigint" || amount < 0n || amount > U64_MAX) {
    throw new InvalidInput(field, "range", `${field}: ${String(amount)} is not a token amount in base units, from 0 to ${U64_MAX}`);
  }
  return formatAmount(amount, decimals);
}

export function tokenAmount(text: string, decimals: number, field = "amount"): bigint {
  const raw = amountText(text, decimals, field);
  if (raw === 0n) {
    throw new InvalidInput(field, "range", `${field}: ${text} must be more than 0`);
  }
  return raw;
}

export const wholeTokens = (raw: bigint, decimals: number, mint: Address): string => `${formatAmount(raw, decimals)} ${nameOfMint(mint)}`;

export function secondsOf(value: number | bigint | undefined, fallback: bigint): bigint {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new InvalidInput("expiresIn", "range", `expiresIn ${value} is not a whole number of seconds`);
  }
  return BigInt(value);
}

export function specHashBytes(specHash: string | Uint8Array): Uint8Array {
  if (typeof specHash !== "string") {
    if (specHash.length !== 32) {
      throw new InvalidInput("specHash", "length", "specHash must be 32 bytes");
    }
    return Uint8Array.from(specHash);
  }
  return hexBytes(specHashText(specHash, "specHash"));
}

export const hexOf = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
