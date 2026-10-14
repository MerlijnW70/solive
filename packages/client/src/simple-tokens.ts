import { type Address, isAddress } from "@solana/kit";
import { DEVNET_TEST_MINT, formatAmount, NATIVE_MINT, parseAmount, tokenName } from "@intent-engine/core";

export type Cluster = "devnet" | "testnet" | "mainnet" | "localnet";

export const CLUSTER_URLS: Readonly<Record<Cluster, string>> = {
  devnet: "https://api.devnet.solana.com",
  testnet: "https://api.testnet.solana.com",
  mainnet: "https://api.mainnet-beta.solana.com",
  localnet: "http://127.0.0.1:8899",
};

export const MAINNET_REFUSED = "this url serves mainnet; pass allowMainnet: true to connect to it";

export class MainnetNotAllowed extends Error {
  readonly url: string;

  constructor(url: string) {
    super(`${url}: ${MAINNET_REFUSED}`);
    this.name = "MainnetNotAllowed";
    this.url = url;
  }
}

export function clusterUrl(options: { cluster?: Cluster | undefined; url?: string | undefined }): string {
  if (options.url !== undefined && options.cluster !== undefined) {
    throw new TypeError("pass cluster or url, not both");
  }
  if (options.url !== undefined) {
    return options.url;
  }
  if (options.cluster === undefined || !(options.cluster in CLUSTER_URLS)) {
    throw new TypeError(`pass url, or cluster as one of ${Object.keys(CLUSTER_URLS).join(", ")}`);
  }
  return CLUSTER_URLS[options.cluster];
}

export function mintOfToken(token: string, url: string): Address {
  const name = token.trim();
  if (name.toUpperCase() === "SOL") {
    return NATIVE_MINT;
  }
  if (name.toUpperCase() === "TEST") {
    if (url !== CLUSTER_URLS.devnet) {
      throw new RangeError(`TEST names the devnet test token; on ${url} pass the token's mint address`);
    }
    return DEVNET_TEST_MINT;
  }
  if (!isAddress(name)) {
    throw new RangeError(`${token} is not SOL, TEST or a token mint address`);
  }
  return name;
}

export const nameOfMint = (mint: Address): string => tokenName(mint) ?? mint;

export function tokenAmount(text: string, decimals: number, field = "amount"): bigint {
  let raw: bigint;
  try {
    raw = parseAmount(text.trim(), decimals);
  } catch (error) {
    throw new RangeError(`${field}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (raw === 0n) {
    throw new RangeError(`${field}: ${text} must be more than 0`);
  }
  return raw;
}

export const wholeTokens = (raw: bigint, decimals: number, mint: Address): string => `${formatAmount(raw, decimals)} ${nameOfMint(mint)}`;

export function secondsOf(value: number | bigint | undefined, fallback: bigint): bigint {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value === "number" && !Number.isSafeInteger(value)) {
    throw new RangeError(`expiresIn ${value} is not a whole number of seconds`);
  }
  return BigInt(value);
}

export function specHashBytes(specHash: string | Uint8Array): Uint8Array {
  if (typeof specHash !== "string") {
    if (specHash.length !== 32) {
      throw new RangeError("specHash must be 32 bytes");
    }
    return Uint8Array.from(specHash);
  }
  const hex = specHash.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new RangeError("specHash must be a sha256 as 64 hex digits");
  }
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));
}

export const hexOf = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
