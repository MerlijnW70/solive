import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, getBase58Decoder, lamports, none } from "@solana/kit";
import { AccountState, getMintEncoder, getMintSize, getTokenEncoder, getTokenSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { expect } from "vitest";
import { DEVNET_TEST_MINT, findAssociatedTokenAddress, NATIVE_MINT } from "@intent-engine/core";
import { getIntentDecoder, getIntentEncoder } from "@intent-engine/core/internal";
import { svmTransport } from "@intent-engine/client/svm";
import { tool } from "../src/agent/names.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { EXIT_OK, main } from "../src/main.js";
import { cli, DOMAIN, h, runtime, world } from "./harness.js";
import { approved } from "./approved.js";

export type Json = Record<string, unknown> & { [key: string]: any };

const DEMO = join(fileURLToPath(new URL("../../..", import.meta.url)), "examples", "demo", "fizzbuzz");
export const SPEC = readFileSync(join(DEMO, "SPEC.md"));
export const SOLUTION = readFileSync(join(DEMO, "solution.mjs"));
export const SPEC_URL = "https://" + "spec.example.org/" + "s".repeat(32) + ".md";
export const HIRER = "/home/hirer";
export const WALLET = `${HIRER}/.config/intent-engine/wallet.json`;
export const STAKE = 10_000_000n;
export const SIGNATURE_COST = 5_000n;

export const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function preset(at: Address): void {
  const space = BigInt(getMintSize());
  h.svm.setAccount({
    address: at,
    data: Uint8Array.from(getMintEncoder().encode({ mintAuthority: none(), supply: 0n, decimals: 9, isInitialized: true, freezeAuthority: none() })),
    executable: false,
    lamports: lamports(h.svm.minimumBalanceForRentExemption(space)),
    programAddress: TOKEN_PROGRAM_ADDRESS,
    space,
  });
}

export async function connected(argv: string[], run: ReturnType<typeof runtime>): Promise<Client> {
  h.served.length = 0;
  const err: string[] = [];
  const code = await main(["mcp", "--url", "devnet", "--wallet", ...argv], run, { out: () => undefined, err: (t) => err.push(t) });
  expect([code, err.join("\n")]).toEqual([EXIT_OK, WALLET_NOTICE.join("\n")]);
  const [near, far] = InMemoryTransport.createLinkedPair();
  await h.served[0]?.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return client;
}

export const server = (argv: string[] = [], over: Partial<ReturnType<typeof runtime>> = {}) => connected(argv, { ...runtime({}), home: HIRER, ...over });

export async function call(client: Client, name: string, args: object = {}): Promise<{ error: boolean; value: Json }> {
  const result = await client.callTool({ name: tool(name), arguments: args as Record<string, unknown> });
  return { error: result.isError === true, value: result.structuredContent as Json };
}

export async function ok(client: Client, name: string, args: object = {}): Promise<Json> {
  const { error, value } = await call(client, name, args);
  expect(error, JSON.stringify(value)).toBe(false);
  return value;
}

export async function startHirer(): Promise<{ hirer: Client; wallet: Address }> {
  await world();
  preset(NATIVE_MINT);
  preset(DEVNET_TEST_MINT);
  h.through = svmTransport(h.svm, { genesisHash: getBase58Decoder().decode(DOMAIN) });
  const hirer = await server();
  const wallet = (await ok(hirer, "wallet_setup"))["address"] as Address;
  h.watched.push(wallet);
  return { hirer, wallet };
}

export async function hireWith(client: Client, attestor: Address, claims: boolean) {
  h.specPages.set(SPEC_URL, SPEC);
  const terms = { sell: "SOL", amount: "0.05", attestor, spec_hash: sha(SPEC), spec_url: SPEC_URL, ...(claims ? { claim_stake: "0.01", claim_secs: 3600 } : {}) };
  const escrow = await ok(client, "wallet_escrow", await approved(client, "wallet_escrow", terms));
  return { intent: escrow["intent"] as Address, nonce: escrow["nonce"] as string };
}

export async function makeWorker(client: Client, intent: Address) {
  const worker = await ok(client, "wallet_worker", { intent, send: true });
  return { worker: worker["worker"] as Address, keypair: worker["keypair"] as string, brief: worker["brief"] as string, value: worker };
}

export const lamportsOf = (wallet: Address) => {
  const held = h.svm.getAccount(wallet);
  return held.exists ? held.lamports : 0n;
};

export const statusOf = (intent: Address) => {
  const held = h.svm.getAccount(intent);
  return held.exists ? getIntentDecoder().decode(held.data).status : undefined;
};

export const rentOf = (bytes: number) => BigInt(h.svm.minimumBalanceForRentExemption(BigInt(bytes)));

export const workerFiles = () => [...h.files.keys()].filter((path) => path.includes("/workers/"));

export function commandsOf(brief: string): string[][] {
  return brief
    .split(/\r?\n|: (?=npx )/)
    .filter((line) => line.startsWith("npx -y @intent-engine/cli "))
    .map((line) => [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2] ?? "").slice(3));
}

export const commandNamed = (brief: string, ...verb: string[]) => {
  const found = commandsOf(brief).find((args) => verb.every((word, at) => args[at] === word));
  if (found === undefined) {
    throw new Error(`the brief has no ${verb.join(" ")} command: ${brief}`);
  }
  return found;
};

export const run = async (args: string[]) => {
  const done = await cli(args, {});
  expect([done.code, done.err], done.out).toEqual([EXIT_OK, ""]);
  return done;
};

const roots: string[] = [];

export const workFile = (bytes: Uint8Array, name = "solution.mjs") => {
  const dir = mkdtempSync(join(tmpdir(), "local-work-"));
  roots.push(dir);
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return path;
};

export const removeWorkFiles = () => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
};

export const forced = (intent: Address, status: number) => {
  const held = h.svm.getAccount(intent);
  if (!held.exists) {
    throw new Error("the escrow is gone");
  }
  h.svm.setAccount({ ...held, data: Uint8Array.from(getIntentEncoder().encode({ ...getIntentDecoder().decode(held.data), status })) });
};

export async function tokensAt(owner: Address, amount: bigint, mint: Address = DEVNET_TEST_MINT): Promise<Address> {
  const held = await findAssociatedTokenAddress({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  const space = BigInt(getTokenSize());
  h.svm.setAccount({
    address: held,
    data: Uint8Array.from(getTokenEncoder().encode({ mint, owner, amount, delegate: none(), state: AccountState.Initialized, isNative: none(), delegatedAmount: 0n, closeAuthority: none() })),
    executable: false,
    lamports: lamports(h.svm.minimumBalanceForRentExemption(space)),
    programAddress: TOKEN_PROGRAM_ADDRESS,
    space,
  });
  return held;
}

export const claimsOn = (args: string[], owner: Address, nonce: string) => args.map((word, at) => (args[at - 1] === "--owner" ? owner : args[at - 1] === "--nonce" ? nonce : word));
