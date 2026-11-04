import { createHash } from "node:crypto";
import { type Address, getAddressEncoder, getBase64Encoder, type KeyPairSigner } from "@solana/kit";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { expect } from "vitest";
import { Kind } from "@intent-engine/core";
import { ACCOUNT_LAYOUTS, findConfigPda, getConfigDecoder, getConfigEncoder } from "@intent-engine/core/internal";
import type { Transport } from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import { tool } from "../src/agent/names.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { ENV_KEYPAIR } from "../src/clusters.js";
import { EXIT_OK, main } from "../src/main.js";
import { h, NOW, runtime, transport } from "./harness.js";
import type { Device } from "./ledger-device.js";

export type Json = Record<string, unknown>;

export const BOOK_VERSION_AT = 8 + (ACCOUNT_LAYOUTS.find(({ name }) => name === "delivery book")?.versionAt ?? 0);

export async function served(ledger?: Device): Promise<Client> {
  h.served.length = 0;
  const err: string[] = [];
  const base = ledger === undefined ? runtime({}) : { ...runtime({}), ledger: ledger.open };
  const code = await main(["mcp", "--url", "devnet", "--wallet", "--all-tools"], base, { out: () => undefined, err: (t) => err.push(t) });
  expect([code, err.join("\n")]).toEqual([EXIT_OK, WALLET_NOTICE.join("\n")]);
  const [near, far] = InMemoryTransport.createLinkedPair();
  await h.served[0]?.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return client;
}

export async function call(client: Client, name: string, args: object = {}) {
  const result = await client.callTool({ name: tool(name), arguments: args as Record<string, unknown> });
  return { error: result.isError === true, value: result.structuredContent as Json };
}

export async function ok(client: Client, name: string, args: object = {}): Promise<Json> {
  const { error, value } = await call(client, name, args);
  expect(error, JSON.stringify(value)).toBe(false);
  return value;
}

export function useWallet(signer: KeyPairSigner): void {
  h.files.set("wallet.json", JSON.stringify(Array.from(h.keypairs.get(signer.address) ?? [])));
  h.env[ENV_KEYPAIR] = "wallet.json";
}

export async function escrowTo(owner: KeyPairSigner, attestor: Address, inputMint: Address, outputMint: Address, nonce = 0n): Promise<Address> {
  const specHash = new Uint8Array(createHash("sha256").update("a bound job").digest());
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor, specHash, judgeFee: 0n } as const;
  const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: owner, params, inputMint, outputMint, nonce, expiresAt: NOW + 3_600n });
  return intent;
}

export async function cancelled(owner: KeyPairSigner, nonce = 0n): Promise<void> {
  await createClient({ url: "http://cluster", transport }).cancel(owner, { owner: owner.address, nonce });
}

export async function feeOf(fee: bigint): Promise<Address> {
  const [config] = await findConfigPda();
  const view = h.svm.getAccount(config);
  if (!view.exists) {
    throw new Error("no config");
  }
  const decoded = getConfigDecoder().decode(view.data);
  h.svm.setAccount({ ...view, data: Uint8Array.from(getConfigEncoder().encode({ ...decoded, announceFee: Number(fee) })) });
  return decoded.feeRecipient;
}

export async function recipientOf(feeRecipient: Address): Promise<void> {
  const [config] = await findConfigPda();
  const view = h.svm.getAccount(config);
  if (!view.exists) {
    throw new Error("no config");
  }
  const decoded = getConfigDecoder().decode(view.data);
  h.svm.setAccount({ ...view, data: Uint8Array.from(getConfigEncoder().encode({ ...decoded, feeRecipient })) });
}

export const lamportsOf = (address: Address): bigint => {
  const held = h.svm.getAccount(address);
  return held.exists ? BigInt(held.lamports) : 0n;
};

export function outdated(book: Address, by = 1): void {
  const view = h.svm.getAccount(book);
  if (!view.exists) {
    throw new Error("no book");
  }
  const data = Uint8Array.from(view.data);
  data[BOOK_VERSION_AT] = (data[BOOK_VERSION_AT] ?? 0) + by;
  h.svm.setAccount({ ...view, data });
}

const holds = (wire: string, address: Address): boolean => {
  const bytes = Uint8Array.from(getBase64Encoder().encode(wire));
  const key = getAddressEncoder().encode(address);
  return bytes.some((_, at) => key.every((byte, i) => bytes[at + i] === byte));
};

export function outdatedAfter(announcement: Address, book: Address): void {
  const live: Transport = transport;
  h.through = {
    ...live,
    send: async (instructions, payer) => {
      const signature = await live.send(instructions, payer);
      if (instructions.some(({ accounts }) => (accounts ?? []).some(({ address }) => address === announcement))) {
        outdated(book);
      }
      return signature;
    },
    sendWire: async (wire, latest) => {
      const signature = await live.sendWire(wire, latest);
      if (holds(wire, announcement)) {
        outdated(book);
      }
      return signature;
    },
  };
}
