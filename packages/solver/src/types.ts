import type { Address, Base64EncodedWireTransaction, Blockhash, Instruction, TransactionSigner } from "@solana/kit";
import type { Config, Intent } from "@intent-engine/core";
import type { Tip } from "./build.js";
import type { Backoff } from "./backoff.js";
import type { Hold } from "./holds.js";
import type { IntentListing } from "./listing.js";
import type { Low } from "./float.js";
import type { Pricer } from "./market.js";
import type { Strategy } from "./plan.js";
import type { Rent } from "./rent.js";

export type Chain = {
  config(): Promise<Config>;
  intents(): Promise<{ address: Address; intent: Intent }[]>;
  listing?(): Promise<IntentListing>;
  now(): Promise<bigint>;
  tokenProgram(mint: Address): Promise<Address>;
  exists(address: Address): Promise<boolean>;
  lookupTables(addresses: readonly Address[]): Promise<Record<Address, Address[]>>;
  blockhash(): Promise<{ blockhash: Blockhash; lastValidBlockHeight: bigint }>;
  tokenAmount(address: Address): Promise<bigint>;
  mintData?(mint: Address): Promise<Uint8Array | null>;
  allowance?(account: Address, delegate: Address): Promise<bigint>;
  rent?(): Promise<Rent>;
};

export type Simulated = { err: string | null; unitsConsumed: bigint | null; balances: readonly (bigint | null)[] };

export type Sent = { signature: string; confirmed: boolean };

export type SolverOptions = {
  chain: Chain;
  pricer: Pricer;
  solver: TransactionSigner;
  inventoryOwner?: Address;
  strategy: Strategy;
  tip: Tip | null;
  lookupTables?: readonly Address[];
  maxSolCost?: bigint;
  maxRent?: bigint;
  backoff?: Backoff;
  concurrency?: number;
  planned?(intent: Address): void;
  held?(account: Address): bigint;
  confirm?(intent: Address, accounts: readonly Address[]): Promise<string | null>;
  unitPrice(instructions: readonly Instruction[]): Promise<bigint>;
  simulate(wire: Base64EncodedWireTransaction, watch: readonly Address[]): Promise<Simulated>;
  send(wire: Base64EncodedWireTransaction): Promise<Sent>;
  sendBundle?: (wires: readonly Base64EncodedWireTransaction[]) => Promise<string>;
  bundleSize?: number;
};

export type Report = {
  filled: { intent: Address; profit: bigint; cost: bigint; signature: string; rent?: bigint }[];
  sent: { intent: Address; profit: bigint; cost: bigint; signature: string; rent?: bigint; holds?: Hold }[];
  skipped: { intent: Address; reason: string; rent?: bigint }[];
  failed: { intent: Address; error: string }[];
  low?: Low[];
  warnings?: string[];
};
