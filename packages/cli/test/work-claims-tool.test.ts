import { createHash } from "node:crypto";
import { type Address, generateKeyPairSigner, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, Kind, NATIVE_MINT } from "@intent-engine/core";
import { createClient } from "@intent-engine/client";
import { lineWaiting } from "../src/claim-commands.js";
import { tool } from "../src/agent/names.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { EXIT_OK } from "../src/main.js";
import { cli, funded, h, NOW, setNow, transport, world } from "./harness.js";

type Json = Record<string, unknown>;

const SPEC = new Uint8Array(createHash("sha256").update("a job taken over MCP").digest());

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
  const started = await cli(["mcp", "--url", "devnet", "--wallet", "--all-tools"], {});
  expect([started.code, started.err]).toEqual([EXIT_OK, WALLET_NOTICE.join("\n")]);
  const [near, far] = InMemoryTransport.createLinkedPair();
  await h.served[0]?.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return client;
}

async function call(client: Client, name: string, args: object = {}) {
  const result = await client.callTool({ name: tool(name), arguments: args as Record<string, unknown> });
  return { error: result.isError === true, value: result.structuredContent as Json };
}

async function job() {
  const w = await world();
  h.files.clear();
  preset(NATIVE_MINT);
  preset(DEVNET_TEST_MINT);
  const [holder, waiter] = await Promise.all([funded(), funded()]);
  const judge = (await generateKeyPairSigner()).address;
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge, specHash: SPEC, judgeFee: 0n } as const;
  const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  const keys = { "owner.json": w.owner, "holder.json": holder, "waiter.json": waiter };
  const ref = ["--owner", w.owner.address, "--nonce", "0"];
  const run = async (args: string[]) => {
    const result = await cli(args, keys);
    expect([result.code, result.err]).toEqual([EXIT_OK, ""]);
  };
  await run(["claims", "open", "--keypair", "owner.json", "--nonce", "0", "--max-secs", "3600", "--stake", "0.05", "--yes"]);
  const client = await connect();
  const wallet = (await call(client, "wallet_setup")).value["address"] as Address;
  const escrow = { owner: w.owner.address, nonce: "0" };
  const sent = async (args: object) => {
    const shown = await call(client, "wallet_claim", { ...escrow, ...args });
    expect(shown.error, JSON.stringify(shown.value)).toBe(false);
    const done = await call(client, "wallet_claim", { ...escrow, ...args, approval: shown.value["approval"], send: true });
    expect(done.error, JSON.stringify(done.value)).toBe(false);
    return done.value;
  };
  return { intent, holder, waiter, wallet, client, ref, run, sent, escrow };
}

describe("wallet_claim over MCP", () => {
  it("says what to do next after a take and after a drop that frees the job", async () => {
    const j = await job();
    expect(await j.sent({ action: "take", secs: 600 })).toMatchObject({ sent: true, next: `you hold ${j.intent}; do the work, then ${tool("wallet_deliver")} before it lapses` });
    expect(await j.sent({ action: "drop" })).toMatchObject({ sent: true, next: "dropped; stake returned, job free for others" });
  });

  it("says a drop hands the job to the next worker in line", async () => {
    const j = await job();
    await j.sent({ action: "take", secs: 600 });
    await j.run(["claims", "standby", "--keypair", "waiter.json", ...j.ref, "--secs", "600", "--yes"]);
    expect(await j.sent({ action: "drop" })).toMatchObject({ sent: true, next: `dropped; stake returned, job handed to ${j.waiter.address}, next in line` });
  });

  it("refuses to take a job workers stand by for, even once its claim lapsed", async () => {
    const j = await job();
    await j.run(["claims", "take", "--keypair", "holder.json", ...j.ref, "--secs", "600", "--yes"]);
    await j.run(["claims", "standby", "--keypair", "waiter.json", ...j.ref, "--secs", "600", "--yes"]);
    setNow(NOW + 600n);
    const refused = await call(j.client, "wallet_claim", { ...j.escrow, action: "take", secs: 60 });
    expect(refused).toMatchObject({ error: true, value: { code: "LineWaiting", hint: lineWaiting(j.intent, 1) } });
  });
});
