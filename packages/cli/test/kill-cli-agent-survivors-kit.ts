import { createHash } from "node:crypto";
import { type Address, generateKeyPairSigner, type KeyPairSigner, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { expect } from "vitest";
import { DEVNET_TEST_MINT, Kind, NATIVE_MINT } from "@intent-engine/core";
import { createClient } from "@intent-engine/client/node";
import { tool } from "../src/agent/names.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { EXIT_OK } from "../src/main.js";
import { cli, funded, h, NOW, transport, world } from "./harness.js";

export type Json = Record<string, unknown> & { [key: string]: any };

const SPEC = new Uint8Array(createHash("sha256").update("a job for the agent survivors").digest());

function preset(at: Address): void {
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

async function connect(): Promise<Client> {
  h.served.length = 0;
  const started = await cli(["mcp", "--url", "devnet", "--wallet"], {});
  expect([started.code, started.err]).toEqual([EXIT_OK, WALLET_NOTICE.join("\n")]);
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

export type Job = {
  owner: Address;
  intent: Address;
  holder: KeyPairSigner;
  third: KeyPairSigner;
  fourth: KeyPairSigner;
  wallet: Address;
  client: Client;
  escrow: { owner: Address; nonce: string };
  ok: (name: string, args: object) => Promise<Json>;
  sent: (args: object) => Promise<Json>;
  refused: (args: object) => Promise<Json>;
  as: (who: string, verb: string, secs?: number) => Promise<void>;
  run: (args: string[]) => Promise<void>;
};

export async function job(options: { stake?: string; maxSecs?: string } = {}): Promise<Job> {
  const w = await world();
  h.files.clear();
  preset(NATIVE_MINT);
  preset(DEVNET_TEST_MINT);
  const [holder, third, fourth] = await Promise.all([funded(), funded(), funded()]);
  const judge = (await generateKeyPairSigner()).address;
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge, specHash: SPEC, judgeFee: 0n } as const;
  const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  const keys = { "owner.json": w.owner, "holder.json": holder, "third.json": third, "fourth.json": fourth };
  const run = async (args: string[]) => {
    const result = await cli(args, keys);
    expect([result.code, result.err]).toEqual([EXIT_OK, ""]);
  };
  await run(["claims", "open", "--keypair", "owner.json", "--nonce", "0", "--max-secs", options.maxSecs ?? "3600", "--stake", options.stake ?? "0.05", "--yes"]);
  const client = await connect();
  const wallet = (await call(client, "wallet_setup")).value["address"] as Address;
  const escrow = { owner: w.owner.address, nonce: "0" };
  const ok = async (name: string, args: object) => {
    const done = await call(client, name, args);
    expect(done.error, JSON.stringify(done.value)).toBe(false);
    return done.value;
  };
  const sent = async (args: object) => {
    const shown = await ok("wallet_claim", { ...escrow, ...args });
    return ok("wallet_claim", { ...escrow, ...args, approval: shown["approval"], send: true });
  };
  const refused = async (args: object) => {
    const done = await call(client, "wallet_claim", { ...escrow, ...args });
    expect(done.error).toBe(true);
    return done.value;
  };
  const ref = ["--owner", w.owner.address, "--nonce", "0"];
  const as = (who: string, verb: string, secs?: number) => run(["claims", verb, "--keypair", `${who}.json`, ...ref, ...(secs === undefined ? [] : ["--secs", String(secs)]), "--yes"]);
  return { owner: w.owner.address, intent, holder, third, fourth, wallet, client, escrow, ok, sent, refused, as, run };
}
