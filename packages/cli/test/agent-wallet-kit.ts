import { type Address, getBase16Encoder, lamports, none, type Signature } from "@solana/kit";
import { AccountState, getMintEncoder, getMintSize, getTokenEncoder, getTokenSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { expect } from "vitest";
import { DEVNET_TEST_MINT, IntentStatus, NATIVE_MINT } from "@intent-engine/core";
import {
  EVENT_IX_TAG,
  getCreateIntentInstructionDataEncoder,
  getDeliveryReleasedEventEncoder,
  getIntentAttestedEventEncoder,
  getIntentCreatedEventEncoder,
  getIntentDecoder,
  getIntentEncoder,
  getIntentSplitEventEncoder,
  splitFee,
} from "@intent-engine/core/internal";
import type { EngineTransaction, ListedSignature, Transport } from "@intent-engine/client";
import { testSignature } from "@intent-engine/client/testing";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { EXIT_OK } from "../src/main.js";
import { cli, FEE_BPS, h, transport, world } from "./harness.js";
import { LAMPORTS_PER_SOL } from "../src/wallet.js";
import { approved } from "./approved.js";

export type Json = Record<string, unknown> & { [key: string]: any };

export const bytesOf = (hex: string) => Uint8Array.from(getBase16Encoder().encode(hex));

export const tag = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);

export function preset(at: Address, decimals = 9): void {
  const space = BigInt(getMintSize());
  h.svm.setAccount({
    address: at,
    data: Uint8Array.from(getMintEncoder().encode({ mintAuthority: none(), supply: 0n, decimals, isInitialized: true, freezeAuthority: none() })),
    executable: false,
    lamports: lamports(h.svm.minimumBalanceForRentExemption(space)),
    programAddress: TOKEN_PROGRAM_ADDRESS,
    space,
  });
}

export async function connect(argv: string[]): Promise<Client> {
  h.served.length = 0;
  const started = await cli(argv, {});
  expect([started.code, started.err]).toEqual([EXIT_OK, argv.includes("--wallet") ? WALLET_NOTICE.join("\n") : ""]);
  const server = h.served[0];
  if (server === undefined) {
    throw new Error("no server was started");
  }
  const [near, far] = InMemoryTransport.createLinkedPair();
  await server.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return client;
}

export async function call(client: Client, name: string, args: object = {}) {
  const result = await client.callTool({ name: `solive_${name}`, arguments: args as Record<string, unknown> });
  return { error: result.isError === true, value: result.structuredContent as Json };
}

export async function ok(client: Client, name: string, args: object = {}): Promise<Json> {
  const { error, value } = await call(client, name, args);
  expect(error, JSON.stringify(value)).toBe(false);
  return value;
}

export async function fresh(): Promise<Client> {
  await world();
  h.files.clear();
  for (const name of Object.keys(h.env)) {
    delete h.env[name];
  }
  preset(NATIVE_MINT);
  preset(DEVNET_TEST_MINT);
  return connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
}

export const AMOUNT = LAMPORTS_PER_SOL / 20n;

export function attested(intent: Address, owner: Address, payee: Address, attestor = owner, result = 1n, amountIn = AMOUNT) {
  const { fee, net } = splitFee(amountIn, FEE_BPS);
  return tag(
    getIntentAttestedEventEncoder().encode({ intent, owner, solver: attestor, payee, attestor, amountIn, result, fee, net, filled: amountIn, remaining: 0n, partnerFee: 0n }),
  );
}

export function splitEvent(intent: Address, owner: Address, attestor: Address, recipients: number, amountIn = AMOUNT) {
  const { fee, net } = splitFee(amountIn, FEE_BPS);
  return tag(getIntentSplitEventEncoder().encode({ intent, owner, solver: attestor, attestor, amountIn, result: 1n, fee, net, partnerFee: 0n, recipients, splitHash: new Uint8Array(32) }));
}

export function deliveryReleased(intent: Address, announcement: Address, worker: Address, attestor: Address, sha256: string, salt = "ab".repeat(16)) {
  return tag(
    getDeliveryReleasedEventEncoder().encode({
      intent,
      announcement,
      seq: 1n,
      worker,
      attestor,
      delivered: bytesOf(sha256),
      salt: bytesOf(salt),
      splitHash: new Uint8Array(32),
    }),
  );
}

export function created(intent: Address, owner: Address, nonce: bigint) {
  return tag(
    getIntentCreatedEventEncoder().encode({
      intent,
      owner,
      nonce,
      kind: 4,
      inputMint: NATIVE_MINT,
      outputMint: DEVNET_TEST_MINT,
      receiver: owner,
      escrowed: AMOUNT,
      expiresAt: 0n,
      rentPayer: owner,
      flags: 0,
      bounty: 0,
      createFee: 0,
    }),
  );
}

export function markFilled(intent: Address, status: number = IntentStatus.Filled) {
  const held = h.svm.getAccount(intent);
  if (!held.exists) {
    throw new Error("the escrow was not created");
  }
  h.svm.setAccount({ ...held, data: Uint8Array.from(getIntentEncoder().encode({ ...getIntentDecoder().decode(held.data), status })) });
}

export function createdAtOfEscrow(intent: Address): bigint {
  const held = h.svm.getAccount(intent);
  if (!held.exists) {
    throw new Error("the escrow was not created");
  }
  return getIntentDecoder().decode(held.data).createdAt;
}

export function createdFrom(intent: Address) {
  const held = h.svm.getAccount(intent);
  if (!held.exists) {
    throw new Error("the escrow was not created");
  }
  const escrow = getIntentDecoder().decode(held.data);
  const event = getIntentCreatedEventEncoder().encode({
    intent,
    owner: escrow.owner,
    nonce: escrow.nonce,
    kind: escrow.kind,
    inputMint: escrow.inputMint,
    outputMint: escrow.outputMint,
    receiver: escrow.owner,
    escrowed: escrow.escrowed,
    expiresAt: escrow.expiresAt,
    rentPayer: escrow.owner,
    flags: 0,
    bounty: 0,
    createFee: 0,
  });
  const args = { nonce: escrow.nonce, kind: escrow.kind, flags: 0, params: escrow.params, expiresAt: escrow.expiresAt, ext: new Uint8Array(), maxCreateFee: 0, maxBounty: 0 };
  return {
    signature: testSignature(`made-${intent}`),
    slot: 1n,
    blockTime: null,
    failed: false,
    emitted: [new Uint8Array([...EVENT_IX_TAG, ...event])],
    called: [Uint8Array.from(getCreateIntentInstructionDataEncoder().encode({ args }))],
    calledAccounts: [[escrow.owner, escrow.owner, escrow.owner, intent]],
    feePayer: escrow.owner,
  } satisfies EngineTransaction;
}

export const closeAccount = (address: Address) =>
  h.svm.setAccount({ address, data: new Uint8Array(), executable: false, lamports: lamports(0n), programAddress: "11111111111111111111111111111111" as Address, space: 0n });

export async function releasedEscrow(client: Client, hint: string) {
  const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
  h.engineLog = [];
  const escrow = await ok(client, "wallet_escrow", await approved(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: wallet, min_result: "1", max_result: "1", spec_hash: hint.repeat(32) }));
  const intent = escrow["intent"] as Address;
  markFilled(intent);
  return { wallet, owner: wallet, intent, nonce: escrow["nonce"] as string, attestedTo: (payee: Address) => attested(intent, wallet, payee, wallet) };
}

export function tokenAccountAt(address: Address, holder: Address) {
  const space = BigInt(getTokenSize());
  h.svm.setAccount({
    address,
    data: Uint8Array.from(
      getTokenEncoder().encode({
        mint: NATIVE_MINT,
        owner: holder,
        amount: 0n,
        delegate: none(),
        state: AccountState.Initialized,
        isNative: none(),
        delegatedAmount: 0n,
        closeAuthority: none(),
      }),
    ),
    executable: false,
    lamports: lamports(h.svm.minimumBalanceForRentExemption(space)),
    programAddress: TOKEN_PROGRAM_ADDRESS,
    space,
  });
}

const transfers = new Map<number, Signature>();
const transferSignatures = new Set<string>();

export function transferSignature(at: number): Signature {
  const known = transfers.get(at);
  if (known !== undefined) {
    return known;
  }
  const made = testSignature(`transfer${at}`);
  transfers.set(at, made);
  transferSignatures.add(made);
  return made;
}

export const zeroTransfers = (count: number, from = 0) =>
  Array.from({ length: count }, (_, i): EngineTransaction => ({ signature: transferSignature(from + i), slot: 9n, blockTime: null, failed: false, emitted: [] }));

export const earlierTransfers = (count: number, from = 0) => zeroTransfers(count, from).map((tx) => ({ ...tx, slot: 2n }));

export const floodFetches = (fetched: readonly string[]) => fetched.filter((signature) => transferSignatures.has(signature)).length;

const listedOf = (tx: EngineTransaction): ListedSignature => ({
  signature: tx.signature,
  slot: tx.slot,
  blockTime: tx.blockTime,
  failed: tx.failed,
  memo: tx.memos === undefined ? null : tx.memos.map((text) => `[${text.length}] ${text}`).join("; "),
});

type LogIndex = { all: EngineTransaction[]; positions: Map<string, number>; known: Map<string, EngineTransaction> };

export const indexing = { builds: 0 };

export const PAGED_ADDRESS = "11111111111111111111111111111111" as Address;

const logIndex = (all: EngineTransaction[]): LogIndex => {
  indexing.builds++;
  return { all, positions: new Map(all.map((tx, i) => [tx.signature, i])), known: new Map(all.map((tx) => [tx.signature, tx])) };
};

export function pagedThrough(log: () => EngineTransaction[], fetched: string[]) {
  const indexed = new WeakMap<EngineTransaction[], LogIndex>();
  const indexOf = () => {
    const all = log();
    const seen = indexed.get(all);
    if (seen !== undefined) {
      return seen;
    }
    const made = logIndex(all);
    indexed.set(all, made);
    return made;
  };
  return {
    ...transport,
    engineTransactions: async (limit: number) => log().slice(0, limit),
    signaturesOf: async (_: Address, limit: number, before?: string) => {
      const { all, positions } = indexOf();
      const start = before === undefined ? 0 : (positions.get(before) ?? -1) + 1;
      return all.slice(start, start + limit).map(listedOf);
    },
    transactionsOf: async (wanted: readonly ListedSignature[]) => {
      const { known } = indexOf();
      fetched.push(...wanted.map((entry) => entry.signature));
      return wanted.flatMap((entry) => known.get(entry.signature) ?? []);
    },
    transactionOf: async (signature: string) => {
      fetched.push(signature);
      return indexOf().known.get(signature) ?? null;
    },
  } satisfies Transport;
}

export function routedThrough(logs: ReadonlyMap<Address, EngineTransaction[]>, other: EngineTransaction[], fetched: string[]) {
  const known = new Map<string, EngineTransaction>();
  const positions = new Map<EngineTransaction[], Map<string, number>>();
  for (const log of [...logs.values(), other]) {
    positions.set(log, new Map(log.map((tx, i) => [tx.signature, i])));
    for (const tx of log) {
      known.set(tx.signature, tx);
    }
  }
  const logOf = (of?: Address) => (of === undefined ? other : (logs.get(of) ?? other));
  return {
    ...transport,
    engineTransactions: async (limit: number, of?: Address) => logOf(of).slice(0, limit),
    signaturesOf: async (of: Address, limit: number, before?: string) => {
      const log = logOf(of);
      const start = before === undefined ? 0 : (positions.get(log)?.get(before) ?? -1) + 1;
      return log.slice(start, start + limit).map(listedOf);
    },
    transactionsOf: async (wanted: readonly ListedSignature[]) => {
      fetched.push(...wanted.map((entry) => entry.signature));
      return wanted.flatMap((entry) => known.get(entry.signature) ?? []);
    },
    transactionOf: async (signature: string) => {
      fetched.push(signature);
      return known.get(signature) ?? null;
    },
  } satisfies Transport;
}

export async function connectThrough(routed: Transport) {
  h.through = routed;
  return connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
}
