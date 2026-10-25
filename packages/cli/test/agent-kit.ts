import { type Address, getBase64Encoder, getTransactionDecoder, type KeyPairSigner, partiallySignTransaction } from "@solana/kit";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { FailedTransactionMetadata } from "litesvm";
import { expect } from "vitest";
import { findVaultPda } from "@intent-engine/core/internal";
import { type Problem, refusalText } from "../src/agent/problems.js";
import { EXIT_OK } from "../src/main.js";
import { cli, ESCROW, h, type World, world } from "./harness.js";

export type Json = Record<string, unknown> & { [key: string]: any };

export async function heldBy(intent: Address): Promise<bigint> {
  const [vault] = await findVaultPda({ intent });
  return (h.svm.getBalance(intent) ?? 0n) + (h.svm.getBalance(vault) ?? 0n);
}

export async function connect(relayer?: KeyPairSigner, limits: string[] = []) {
  h.served.length = 0;
  const argv = ["mcp", "--url", "http://agent", ...(relayer === undefined ? [] : ["--relayer", "r.json", ...limits])];
  const started = await cli(argv, relayer === undefined ? {} : { "r.json": relayer });
  expect([started.code, started.out, started.err]).toEqual([EXIT_OK, "", ""]);
  expect(h.urls).toContain("http://agent");
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

export async function ok(client: Client, name: string, args: object = {}): Promise<Json> {
  const result = await client.callTool({ name: `solive_${name}`, arguments: args as Record<string, unknown> });
  expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
  const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
  expect(JSON.parse(text)).toEqual(result.structuredContent);
  return result.structuredContent as Json;
}

export async function fail(client: Client, name: string, args: object = {}): Promise<Problem> {
  const result = await client.callTool({ name: `solive_${name}`, arguments: args as Record<string, unknown> });
  expect(result.isError).toBe(true);
  const problem = result.structuredContent as Problem;
  expect((result.content as { text: string }[])[0]?.text).toBe(refusalText(problem));
  return problem;
}

export async function execute(prepared: { transaction: string }, ...signers: KeyPairSigner[]): Promise<void> {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(prepared.transaction));
  const signed = await partiallySignTransaction(
    signers.map((s) => s.keyPair),
    tx,
  );
  const result = h.svm.sendTransaction(signed);
  if (result instanceof FailedTransactionMetadata) {
    throw new Error(result.toString());
  }
}

export const exists = (address: Address) => h.svm.getAccount(address).exists;

type Swap = {
  owner: Address;
  input_mint: Address;
  output_mint: Address;
  order: { kind: string; amount_in: string; min_out: string };
  expires_in: number;
};

export const swapOf = (w: World, over: object = {}): Swap => ({
  owner: w.owner.address,
  input_mint: w.inputMint,
  output_mint: w.outputMint,
  order: { kind: "swap", amount_in: ESCROW.toString(), min_out: "300" },
  expires_in: 3_600,
  ...over,
});

export const createIntentOf = async (client: Client, w: World, over: object = {}, owner = w.owner) => {
  const made = await ok(client, "prepare_create", swapOf(w, { owner: owner.address, ...over }));
  await execute(made["prepared"], owner);
  return made;
};

export async function served(): Promise<{ w: World; client: Client }> {
  const w = await world();
  h.watched.length = 0;
  h.watched.push(w.owner.address);
  const client = await connect();
  return { w, client };
}
