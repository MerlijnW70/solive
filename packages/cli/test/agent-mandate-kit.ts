import { type Address, getBase64Encoder, getTransactionDecoder, type KeyPairSigner, partiallySignTransaction } from "@solana/kit";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { FailedTransactionMetadata } from "litesvm";
import { expect } from "vitest";
import { MANDATE_NONCE_BIT } from "@intent-engine/core/internal";
import { getTokenDecoder } from "@solana-program/token";
import { type Problem } from "../src/agent/problems.js";
import { EXIT_OK } from "../src/main.js";
import { cli, funded, h, type World, world } from "./harness.js";

export const FIRST_LANE = MANDATE_NONCE_BIT | (1n << 32n);

export type Json = Record<string, unknown> & { [key: string]: any };

export async function serve(extra: string[], signers: Record<string, KeyPairSigner>) {
  h.served.length = 0;
  const started = await cli(["mcp", "--url", "http://agent", ...extra], signers);
  expect([started.code, started.out, started.err]).toEqual([EXIT_OK, "", ""]);
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

export async function call(client: Client, name: string, args: object): Promise<{ ok: boolean; value: Json }> {
  const result = await client.callTool({ name: `solive_${name}`, arguments: args as Record<string, unknown> });
  return { ok: result.isError !== true, value: result.structuredContent as Json };
}

export async function ok(client: Client, name: string, args: object): Promise<Json> {
  const r = await call(client, name, args);
  expect(r.ok, JSON.stringify(r.value)).toBe(true);
  return r.value;
}

export async function fail(client: Client, name: string, args: object): Promise<Problem> {
  const r = await call(client, name, args);
  expect(r.ok, JSON.stringify(r.value)).toBe(false);
  return r.value as Problem;
}

export async function execute(prepared: { transaction: string }, signer: KeyPairSigner): Promise<void> {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(prepared.transaction));
  const result = h.svm.sendTransaction(await partiallySignTransaction([signer.keyPair], tx));
  if (result instanceof FailedTransactionMetadata) {
    throw new Error(result.toString());
  }
}

export function allowance(account: Address): bigint {
  const view = h.svm.getAccount(account);
  return view.exists ? getTokenDecoder().decode(view.data).delegatedAmount : -1n;
}

type Grant = {
  owner: Address;
  agent: Address;
  input_mint: Address;
  output_mint: Address;
  kinds: string[];
  per_intent: string;
  total: string;
  max_intents: number;
  max_ttl: number;
  valid_for: number;
  floor: { out: string; in: string };
};

export const grantOf = (w: World, agent: KeyPairSigner, over: object = {}): Grant => ({
  owner: w.owner.address,
  agent: agent.address,
  input_mint: w.inputMint,
  output_mint: w.outputMint,
  kinds: ["swap", "limit"],
  per_intent: "400",
  total: "600",
  max_intents: 2,
  max_ttl: 3_600,
  valid_for: 86_400,
  floor: { out: "1", in: "2" },
  ...over,
});

export const order = (amountIn: string, minOut: string) => ({ kind: "swap", amount_in: amountIn, min_out: minOut });

export async function mandateServed(): Promise<{ w: World; agent: KeyPairSigner; client: Client }> {
  const w = await world();
  h.watched.length = 0;
  h.watched.push(w.owner.address);
  const agent = await funded();
  const client = await serve(["--agent", "a.json", "--agent-owners", w.owner.address], { "a.json": agent });
  return { w, agent, client };
}
