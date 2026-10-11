import { type Address, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { findAssociatedTokenAddress, findIntentPda } from "@intent-engine/core";
import { beforeEach, describe, expect, it } from "vitest";
import { WALLET_NOT_MAINNET } from "../src/args.js";
import { START_PROMPT, WALLET_INSTRUCTIONS } from "../src/agent/mcp.js";
import {
  DEFAULT_EXPIRES_IN,
  LANDING_SECONDS,
  MAINNET_GENESIS,
  NO_WALLET,
  PREVIEW_ONLY,
  WALLET_ACTIONS,
  WALLET_NOTICE,
  WALLET_OFF,
  walletBalance,
  walletEmpty,
} from "../src/agent/wallet.js";
import { invoke } from "../src/agent/actions.js";
import { claimsOf } from "../src/agent/claims.js";
import { ACTIONS } from "../src/agent/registry.js";
import { EXIT_OK, EXIT_USAGE } from "../src/main.js";
import { NATIVE_MINT, TEST_TOKEN } from "../src/tokens.js";
import { AIRDROP, AIRDROP_REFUSED, defaultWallet, FUNDED, LAMPORTS_PER_SOL } from "../src/wallet.js";
import { balance, cli, h, HOME, transport, world } from "./harness.js";

type Json = Record<string, unknown> & { [key: string]: any };

function preset(at: Address, decimals = 9): void {
  const space = BigInt(getMintSize());
  h.svm.setAccount({
    address: at,
    data: Uint8Array.from(
      getMintEncoder().encode({ mintAuthority: none(), supply: 0n, decimals, isInitialized: true, freezeAuthority: none() }),
    ),
    executable: false,
    lamports: lamports(h.svm.minimumBalanceForRentExemption(space)),
    programAddress: TOKEN_PROGRAM_ADDRESS,
    space,
  });
}

async function connect(argv: string[]): Promise<Client> {
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

async function call(client: Client, name: string, args: object = {}) {
  const result = await client.callTool({ name: `solive_${name}`, arguments: args as Record<string, unknown> });
  return { error: result.isError === true, value: result.structuredContent as Json };
}

async function ok(client: Client, name: string, args: object = {}): Promise<Json> {
  const { error, value } = await call(client, name, args);
  expect(error, JSON.stringify(value)).toBe(false);
  return value;
}

describe("the wallet server", () => {
  let client: Client;

  beforeEach(async () => {
    await world();
    h.files.clear();
    for (const name of Object.keys(h.env)) {
      delete h.env[name];
    }
    preset(NATIVE_MINT);
    preset(TEST_TOKEN);
    client = await connect(["mcp", "--url", "devnet", "--wallet"]);
  });

  it("offers its wallet tools first, says how to use them and how to start", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([...WALLET_ACTIONS, ...ACTIONS].map((a) => a.name));
    expect(client.getInstructions()).toBe(WALLET_INSTRUCTIONS);
    for (const line of WALLET_NOTICE) {
      expect(WALLET_INSTRUCTIONS).toContain(`- ${line}`);
    }
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toEqual(["start"]);
    const start = await client.getPrompt({ name: "start" });
    expect(start.messages).toEqual([{ role: "user", content: { type: "text", text: START_PROMPT } }]);
  });

  it("sets up a funded wallet, previews a swap, sends it only when told to, lists it and cancels it", async () => {
    expect((await call(client, "wallet_swap", { sell: "SOL", buy: "TEST", amount: "0.05", min_receive: "5" })).value).toMatchObject({
      code: "NoWallet",
      hint: NO_WALLET,
    });
    const made = await ok(client, "wallet_setup");
    expect(made).toMatchObject({ keypair: defaultWallet(HOME), created: true, sol: "1", next: FUNDED, notice: WALLET_NOTICE });
    const owner = made["address"] as Address;
    expect(h.airdrops).toEqual([{ address: owner, lamports: AIRDROP }]);
    expect(await ok(client, "wallet_setup")).toMatchObject({ address: owner, created: false });
    const preview = await ok(client, "wallet_swap", { sell: "SOL", buy: "TEST", amount: "0.05", min_receive: "5" });
    expect(preview).toMatchObject({ nonce: "0", sent: false, next: PREVIEW_ONLY });
    expect(preview["summary"]).toContain("Setup: wraps 0.05 of your SOL into your wrapped SOL account");
    expect(preview["summary"].slice(0, 2)).toEqual([`Sell: exactly 0.05 of SOL (${NATIVE_MINT})`, `Receive: at least 5 of TEST (${TEST_TOKEN})`]);
    const [intent] = await findIntentPda({ owner, nonce: 0n });
    expect(preview["intent"]).toBe(intent);
    expect(h.svm.getAccount(intent).exists).toBe(false);
    const swapped = await ok(client, "wallet_swap", { sell: "sol", buy: "test", amount: "0.05", min_receive: "5", send: true });
    expect(swapped).toMatchObject({ intent, sent: true, signature: expect.any(String) });
    h.watched.push(owner);
    const listed = await ok(client, "wallet_intents");
    expect(listed["intents"]).toMatchObject([{ address: intent, status: "open", nonce: "0" }]);
    const opened = listed["intents"][0];
    expect(BigInt(opened.expires_at) - BigInt(opened.created_at)).toBe(BigInt(DEFAULT_EXPIRES_IN + LANDING_SECONDS));
    const wrapped = await findAssociatedTokenAddress({ owner, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const shown = await ok(client, "wallet_balance");
    expect(shown).toMatchObject({ address: owner, tokens: [{ mint: NATIVE_MINT, account: wrapped, balance: "0" }, { mint: TEST_TOKEN, name: "TEST" }] });
    const cancel = await ok(client, "wallet_cancel", { nonce: "0" });
    expect(cancel).toMatchObject({ intent, refund: (LAMPORTS_PER_SOL / 20n).toString(), sent: false, next: PREVIEW_ONLY });
    expect(cancel["summary"]).toContain(`Returns 0.05 of SOL (${NATIVE_MINT}) to your token account`);
    expect(h.svm.getAccount(intent).exists).toBe(true);
    expect(await ok(client, "wallet_cancel", { nonce: "0", send: true })).toMatchObject({ intent, sent: true });
    expect(h.svm.getAccount(intent).exists).toBe(false);
    expect(balance(wrapped)).toBe(LAMPORTS_PER_SOL / 20n);
    expect((await ok(client, "wallet_intents"))["intents"]).toEqual([]);
  });

  it("says how to fund an empty wallet before it tries to swap", async () => {
    h.airdropRefused = true;
    const made = await ok(client, "wallet_setup");
    expect(made).toMatchObject({ sol: "0", next: AIRDROP_REFUSED });
    expect((await call(client, "wallet_swap", { sell: "SOL", buy: "TEST", amount: "0.05", min_receive: "5" })).value).toMatchObject({
      code: "WalletEmpty",
      hint: walletEmpty(made["address"] as string),
    });
  });

  it("reads the cluster once per server and refuses to make, read or sign with a wallet on an RPC that serves mainnet under another name", async () => {
    const reads = h.genesisReads;
    await ok(client, "wallet_setup");
    await ok(client, "wallet_balance");
    await ok(client, "wallet_intents");
    expect(h.genesisReads - reads).toBe(1);
    h.genesis = MAINNET_GENESIS;
    client = await connect(["mcp", "--url", "devnet", "--wallet"]);
    for (const [name, args] of [
      ["wallet_setup", {}],
      ["wallet_balance", {}],
      ["wallet_intents", {}],
      ["wallet_swap", { sell: "SOL", buy: "TEST", amount: "0.05", min_receive: "5", send: true }],
      ["wallet_cancel", { nonce: "0", send: true }],
    ] as const) {
      expect((await call(client, name, args)).value).toMatchObject({ code: "WalletNotMainnet", hint: WALLET_NOT_MAINNET });
    }
  });

  it("refuses tokens it cannot name and amounts it cannot read", async () => {
    await ok(client, "wallet_setup");
    for (const args of [
      { sell: "DOGE", buy: "TEST", amount: "1", min_receive: "1" },
      { sell: "SOL", buy: "TEST", amount: "lots", min_receive: "1" },
      { sell: "SOL", buy: "TEST", amount: "0.0000000001", min_receive: "1" },
    ]) {
      expect((await call(client, "wallet_swap", args)).value).toMatchObject({ code: "InvalidInput" });
    }
  });
});

describe("wallet mode", () => {
  beforeEach(async () => {
    await world();
    h.files.clear();
  });

  it("is off unless asked for and never serves mainnet", async () => {
    const plain = await connect(["mcp", "--url", "devnet"]);
    const { tools } = await plain.listTools();
    expect(tools.map((t) => t.name)).toEqual(ACTIONS.map((a) => a.name));
    expect(plain.getInstructions()).toBeUndefined();
    const refused = await cli(["mcp", "--url", "mainnet-beta", "--wallet"], {});    expect([refused.code, refused.err]).toEqual([EXIT_USAGE, WALLET_NOT_MAINNET]);
    const off = await invoke(walletBalance, { transport, relay: undefined, agent: undefined, claims: claimsOf() }, {});
    expect(off).toEqual({ ok: false, problem: expect.objectContaining({ code: "WalletNotConfigured", hint: WALLET_OFF }) });
  });
});
