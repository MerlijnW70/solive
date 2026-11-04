import { type Address, lamports } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { NATIVE_MINT } from "@intent-engine/core";
import { AGENT_IS_WALLET, OWNER_IS_WALLET, RELAYER_IS_WALLET } from "../src/command-builders.js";
import { AGENT_KEY_IS_WALLET, OWNER_IS_THIS_WALLET } from "../src/agent/mandate-agent.js";
import { RELAYER_KEY_IS_WALLET } from "../src/agent/signed-submit.js";
import { SERVER_PROBLEMS } from "../src/agent/problems.js";
import { defaultWallet, serverKeyNotWallet } from "../src/wallet.js";
import { execute, grantOf } from "./agent-mandate-kit.js";
import { keyed } from "./announce.js";
import { HOME } from "./harness-state.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { ENV_KEYPAIR } from "../src/clusters.js";
import { EXIT_OK, EXIT_USAGE, main } from "../src/main.js";
import { call, connect, ok } from "./agent-wallet-kit.js";
import { order } from "./agent-mandate-kit.js";
import { cli, funded, h, runtime, world } from "./harness.js";
import { device, deviceKey, found } from "./ledger-device.js";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { airdropped } from "./airdrop.js";

const NOTICE_LINE = "This wallet pays only after you approve a preview.";

async function walletKey(): Promise<{ keypair: string; address: Address }> {
  await world();
  const client = await connect(["mcp", "--url", "devnet", "--wallet"]);
  const made = await ok(client, "wallet_setup");
  return { keypair: made["keypair"] as string, address: made["address"] as Address };
}

async function refused(argv: string[], signers: Parameters<typeof cli>[1] = {}) {
  h.served.length = 0;
  const started = await cli(["mcp", "--url", "devnet", "--wallet", ...argv], signers);
  return { code: started.code, err: started.err, served: h.served.length };
}

describe("a wallet server keeps the wallet's key apart from the agent and relayer keys", () => {
  it("refuses at startup an --agent key that is the wallet's own key", async () => {
    const wallet = await walletKey();
    const owner = await funded();
    const started = await refused(["--agent", wallet.keypair, "--agent-owners", owner.address]);
    expect([started.code, started.served, started.err.endsWith(AGENT_IS_WALLET)]).toEqual([EXIT_USAGE, 0, true]);
  });

  it("refuses at startup a --relayer key that is the wallet's own key", async () => {
    const wallet = await walletKey();
    const started = await refused(["--relayer", wallet.keypair, "--relay-fee", `${NATIVE_MINT}=0`]);
    expect([started.code, started.served, started.err.endsWith(RELAYER_IS_WALLET)]).toEqual([EXIT_USAGE, 0, true]);
  });

  it("refuses at startup an --agent-owners list that names the wallet's own address", async () => {
    const wallet = await walletKey();
    const agent = await funded();
    const other = await funded();
    const started = await refused(["--agent", "a.json", "--agent-owners", `${other.address},${wallet.address}`], { "a.json": agent });
    expect([started.code, started.served, started.err.endsWith(OWNER_IS_WALLET)]).toEqual([EXIT_USAGE, 0, true]);
  });

  it("starts with keys of their own, and serves the notice line in every served set", async () => {
    await walletKey();
    const agent = await funded();
    const relayer = await funded();
    const owner = await funded();
    const keys = { "a.json": agent, "r.json": relayer };
    for (const extra of [[], ["--agent", "a.json", "--agent-owners", owner.address], ["--relayer", "r.json", "--relay-fee", `${NATIVE_MINT}=0`], ["--all-tools"]]) {
      const started = await refused(extra, keys);
      expect([extra, started.code, started.served, started.err]).toEqual([extra, EXIT_OK, 1, WALLET_NOTICE.join("\n")]);
    }
    expect(WALLET_NOTICE).toContain(NOTICE_LINE);
  });

  it("refuses agent_create for a Ledger wallet's own address, whose address startup cannot read, and moves nothing", async () => {
    await world();
    const key = await deviceKey();
    airdropped(h.svm, key.address, lamports(10_000_000_000n));
    h.env[ENV_KEYPAIR] = "usb://ledger?key=4";
    const ledger = device(key, found([44, 501, 4], key));
    const agent = await funded();
    h.served.length = 0;
    const err: string[] = [];
    const code = await main(["mcp", "--url", "devnet", "--wallet", "--agent", "a.json", "--agent-owners", key.address], { ...runtime({ "a.json": agent }), ledger: ledger.open }, { out: () => undefined, err: (t) => err.push(t) });
    expect([code, err.join("\n")]).toEqual([EXIT_OK, WALLET_NOTICE.join("\n")]);
    const [near, far] = InMemoryTransport.createLinkedPair();
    await h.served[0]?.connect(near);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(far);
    const before = [h.svm.getBalance(key.address), h.svm.getBalance(agent.address)];
    const refusal = await call(client, "agent_create", { owner: key.address, order: order("300", "150"), expires_in: 600 });
    expect(refusal.value).toMatchObject({ code: "OwnerNotServed", hint: OWNER_IS_THIS_WALLET });
    expect([h.svm.getBalance(key.address), h.svm.getBalance(agent.address)]).toEqual(before);
    expect(ledger.signed).toEqual([]);
  });
});

async function servedThrough(argv: string[], signers: Parameters<typeof cli>[1], ledger?: ReturnType<typeof device>): Promise<Client> {
  h.served.length = 0;
  const err: string[] = [];
  const base = runtime(signers);
  const code = await main(["mcp", "--url", "devnet", "--wallet", ...argv], ledger === undefined ? base : { ...base, ledger: ledger.open }, { out: () => undefined, err: (t) => err.push(t) });
  expect([code, err.join("\n")]).toEqual([EXIT_OK, WALLET_NOTICE.join("\n")]);
  const [near, far] = InMemoryTransport.createLinkedPair();
  await h.served[0]?.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return client;
}

const SUBMIT = (owner: Address) => ({
  owner,
  input_mint: NATIVE_MINT,
  output_mint: owner,
  order: { kind: "swap", amount_in: "1", min_out: "1" },
  expires_at: "4000000000",
  nonce: "0",
  submit_by: "4000000000",
  epoch: "0",
  relayer_fee: "0",
  signature: "1".repeat(64),
});

describe("a server key placed where the wallet would be", () => {
  it("is never adopted as the wallet, and agent_create refuses once the agent key is the wallet's", async () => {
    await world();
    const path = defaultWallet(HOME);
    const agent = await keyed(path);
    const owner = await funded();
    const client = await servedThrough(["--agent", path, "--agent-owners", owner.address], {});
    expect((await call(client, "wallet_setup")).value).toMatchObject({ code: "KeyIsWallet", hint: serverKeyNotWallet(path) });
    h.env[ENV_KEYPAIR] = path;
    const before = h.svm.getBalance(agent.address);
    expect((await call(client, "agent_create", { owner: owner.address, order: order("300", "150"), expires_in: 600 })).value).toMatchObject({ code: "KeyIsWallet", hint: AGENT_KEY_IS_WALLET });
    expect(h.svm.getBalance(agent.address)).toBe(before);
  });

  it("is never adopted as the wallet, and submit_signed_intent refuses once the relayer key is the wallet's", async () => {
    await world();
    const path = defaultWallet(HOME);
    const relayer = await keyed(path);
    const owner = await funded();
    const client = await servedThrough(["--relayer", path, "--relay-fee", `${NATIVE_MINT}=0`], {});
    expect((await call(client, "wallet_setup")).value).toMatchObject({ code: "KeyIsWallet", hint: serverKeyNotWallet(path) });
    h.env[ENV_KEYPAIR] = path;
    const before = h.svm.getBalance(relayer.address);
    expect((await call(client, "submit_signed_intent", SUBMIT(owner.address))).value).toMatchObject({ code: "KeyIsWallet", hint: RELAYER_KEY_IS_WALLET });
    expect(h.svm.getBalance(relayer.address)).toBe(before);
  });

  it("refuses agent_create when a Ledger wallet's address cannot be read, and moves nothing", async () => {
    const w = await world();
    h.watched.length = 0;
    h.watched.push(w.owner.address);
    const key = await deviceKey();
    h.env[ENV_KEYPAIR] = "usb://ledger?key=4";
    const unplugged = device(key, [], async () => {
      throw new Error("no Ledger was found");
    });
    const agent = await funded();
    const client = await servedThrough(["--agent", "a.json", "--agent-owners", w.owner.address], { "a.json": agent }, unplugged);
    await execute((await ok(client, "prepare_mandate", grantOf(w, agent)))["prepared"], w.owner);
    const before = [h.svm.getBalance(agent.address), h.svm.getBalance(w.owner.address)];
    const refused = await call(client, "agent_create", { owner: w.owner.address, order: order("300", "150"), expires_in: 600 });
    expect(refused.value["code"]).toBeDefined();
    expect(refused.value["intent"]).toBeUndefined();
    expect([h.svm.getBalance(agent.address), h.svm.getBalance(w.owner.address)]).toEqual(before);
    expect(unplugged.signed).toEqual([]);
  });
});

const UNREAD_PATH = "unread-wallet.json";

describe("a wallet key file that cannot be read when a server key is checked against it", () => {
  it("refuses agent_create and sends nothing, then creates once the file reads again", async () => {
    const w = await world();
    h.watched.length = 0;
    h.watched.push(w.owner.address);
    const agent = await funded();
    const client = await servedThrough(["--agent", "a.json", "--agent-owners", w.owner.address], { "a.json": agent });
    await execute((await ok(client, "prepare_mandate", grantOf(w, agent)))["prepared"], w.owner);
    h.env[ENV_KEYPAIR] = UNREAD_PATH;
    h.files.set(UNREAD_PATH, "not a key file");
    const before = [h.svm.getBalance(agent.address), h.svm.getBalance(w.owner.address)];
    const terms = { owner: w.owner.address, order: order("300", "150"), expires_in: 600 };
    const refused = await call(client, "agent_create", terms);
    expect(refused.value).toMatchObject({ code: "WalletKeyUnread", retryable: false, hint: SERVER_PROBLEMS.WalletKeyUnread.hint });
    expect(refused.value["intent"]).toBeUndefined();
    expect([h.svm.getBalance(agent.address), h.svm.getBalance(w.owner.address)]).toEqual(before);
    h.files.delete(UNREAD_PATH);
    expect((await call(client, "agent_create", terms)).value).toMatchObject({ code: "WalletKeyUnread" });
    expect([h.svm.getBalance(agent.address), h.svm.getBalance(w.owner.address)]).toEqual(before);
    await keyed(UNREAD_PATH);
    const created = await call(client, "agent_create", terms);
    expect([created.error, typeof created.value["intent"]]).toEqual([false, "string"]);
  });

  it("refuses submit_signed_intent before it reads the signed terms", async () => {
    await world();
    const relayer = await funded();
    const owner = await funded();
    const client = await servedThrough(["--relayer", "r.json", "--relay-fee", `${NATIVE_MINT}=0`], { "r.json": relayer });
    h.env[ENV_KEYPAIR] = UNREAD_PATH;
    h.files.set(UNREAD_PATH, "not a key file");
    const before = h.svm.getBalance(relayer.address);
    expect((await call(client, "submit_signed_intent", SUBMIT(owner.address))).value).toMatchObject({ code: "WalletKeyUnread", hint: SERVER_PROBLEMS.WalletKeyUnread.hint });
    expect(h.svm.getBalance(relayer.address)).toBe(before);
    await keyed(UNREAD_PATH);
    expect((await call(client, "submit_signed_intent", SUBMIT(owner.address))).value["code"]).not.toBe("WalletKeyUnread");
  });
});
