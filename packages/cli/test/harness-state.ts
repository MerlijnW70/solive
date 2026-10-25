import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getBase58Decoder,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  type Instruction,
  type Transaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  signTransactionMessageWithSigners,
  type TransactionSigner,
} from "@solana/kit";
import { FailedTransactionMetadata, LiteSVM } from "litesvm";
import type { McpServer } from "@modelcontextprotocol/server";
import { type EngineTransaction, type Lookup, type SpecFetch, type Transport } from "@intent-engine/client";
import { fileSales } from "../src/agent/sales.js";

export const NOW = 1_700_000_000n;
export const FEE_BPS = 5;
export const ESCROW = 400n;
export const DOMAIN = new Uint8Array(32).fill(0x11);
export const enginePath =
  process.env["INTENT_ENGINE_SO"] ??
  fileURLToPath(new URL("../../../target/deploy/intent_engine.so", import.meta.url));

export const h = {
  keypairs: new Map<Address, Uint8Array>(),
  svm: new LiteSVM(),
  genesis: getBase58Decoder().decode(DOMAIN),
  urls: [] as string[],
  watched: [] as Address[],
  wires: [] as string[],
  jupiterReplies: [] as { status: number; body: unknown }[],
  specPages: new Map<string, Uint8Array>(),
  specReplies: new Map<string, SpecFetch>(),
  hosts: new Map<string, string[]>(),
  lookups: [] as string[],
  fetched: [] as { url: string; body: string | undefined; headers: Record<string, string> | undefined }[],
  requestedLimits: [] as number[],
  recentFees: [] as bigint[],
  feeQueries: [] as Address[][],
  files: new Map<string, string>(),
  env: {} as Record<string, string | undefined>,
  sleeps: [] as number[],
  onSleep: [] as (() => void)[],
  waits: [] as number[],
  changed: [] as { address: Address; data: Uint8Array }[][],
  scans: 0,
  submitted: [] as string[],
  dropSubmits: false,
  clock: 0n,
  steps: [] as bigint[],
  genesisReads: 0,
  failScans: 0,
  reads: new Map<Address, number>(),
  closed: 0,
  rounds: 0,
  engineLog: [] as EngineTransaction[],
  firstSlot: 0n,
  through: null as Transport | null,
  requestedOf: [] as (Address | undefined)[],
  simulated: [] as string[],
  sendFails: null as { error: Error; landed: boolean; after?: number } | null,
  packetLimit: false,
  served: [] as McpServer[],
  airdropRefused: false,
  airdrops: [] as { address: Address; lamports: bigint }[],
  saleRoot: mkdtempSync(join(tmpdir(), "solive-sales-")),
  touched: new Set<Address>(),
};

export const saleBook = fileSales((path) => join(h.saleRoot, path));

export const PUBLIC_TEST_ADDRESS = "93.184.215.14";

export const harnessLookup: Lookup = async (host) => {
  h.lookups.push(host);
  return h.hosts.get(host) ?? (host === "localhost" || host.endsWith(".localhost") ? ["127.0.0.1"] : [PUBLIC_TEST_ADDRESS]);
};

export const HOME = "/home/tester";
export const PACKET_LIMIT = 1_232;

export function touch(tx: Transaction): void {
  for (const address of getCompiledTransactionMessageDecoder().decode(tx.messageBytes).staticAccounts) {
    h.touched.add(address);
  }
}

export async function send(payer: TransactionSigner, ixs: readonly Instruction[]): Promise<string> {
  h.svm.expireBlockhash();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => h.svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const tx = await signTransactionMessageWithSigners(message);
  h.svm.withBlockhashCheck(false);
  const result = h.svm.sendTransaction(tx);
  h.svm.withBlockhashCheck(true);
  if (result instanceof FailedTransactionMetadata) {
    throw new Error(String(result.err()));
  }
  touch(tx);
  return getSignatureFromTransaction(tx);
}
