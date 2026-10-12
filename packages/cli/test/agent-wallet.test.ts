import { type Address, generateKeyPairSigner, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import {
  EVENT_IX_TAG,
  findAssociatedTokenAddress,
  findIntentPda,
  getIntentCancelledEventEncoder,
  getIntentCreatedEventEncoder,
  getIntentDecoder,
  getIntentEncoder,
  getFillBegunEventEncoder,
  getFillEndedEventEncoder,
  getIntentFilledEventEncoder,
  IntentStatus,
  formatAmount,
  splitFee,
  WARN_ATTESTOR,
} from "@intent-engine/core";
import { beforeEach, describe, expect, it } from "vitest";
import { WALLET_NOT_MAINNET } from "../src/args.js";
import { BlockhashExpired, FailedOnChain } from "../src/transport.js";
import { START_PROMPT, WALLET_INSTRUCTIONS } from "../src/agent/mcp.js";
import {
  DEFAULT_EXPIRES_IN,
  ESTIMATE_NEXT,
  ESTIMATE_SCAN,
  LANDING_SECONDS,
  MAINNET_GENESIS,
  NO_FILLS,
  notAttestor,
  NO_WALLET,
  PREVIEW_ONLY,
  stillWaiting,
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
import { balance, cli, FEE_BPS, h, HOME, setNow, transport, world } from "./harness.js";

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

  it("starts reading recent engine transactions as it starts, so the first estimate finds them ready", async () => {
    h.requestedLimits.length = 0;
    await connect(["mcp", "--url", "devnet", "--wallet"]);
    expect(h.requestedLimits).toEqual([ESTIMATE_SCAN]);
    h.requestedLimits.length = 0;
    await connect(["mcp", "--url", "devnet"]);
    expect(h.requestedLimits).toEqual([]);
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
    const preview = await ok(client, "wallet_swap", { sell: "SOL", buy: "TEST", amount: "0.05", min_receive: "5", exact: true });
    expect(preview).toMatchObject({ nonce: "0", sent: false, next: PREVIEW_ONLY });
    expect(preview["start_receive"]).toBeUndefined();
    expect(preview["summary"]).toContain("Setup: wraps 0.05 of your SOL into your wrapped SOL account");
    expect(preview["summary"].slice(0, 2)).toEqual([`Sell: exactly 0.05 of SOL (${NATIVE_MINT})`, `Receive: at least 5 of TEST (${TEST_TOKEN})`]);
    const [intent] = await findIntentPda({ owner, nonce: 0n });
    expect(preview["intent"]).toBe(intent);
    expect(h.svm.getAccount(intent).exists).toBe(false);
    const swapped = await ok(client, "wallet_swap", { sell: "sol", buy: "test", amount: "0.05", min_receive: "5", exact: true, send: true });
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

  it("lets the ask fall from a little above the best recent fill to the minimum unless told to ask the minimum", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    const swap = { sell: "SOL", buy: "TEST", amount: "0.05", min_receive: "5" };
    h.engineLog = [];
    expect(await ok(client, "wallet_swap", swap)).toMatchObject({ start_receive: "6.25" });
    const tag = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);
    const intent = "11111111111111111111111111111112" as Address;
    h.engineLog = [
      {
        signature: "fill",
        slot: 1n,
        blockTime: null,
        failed: false,
        emitted: [
          tag(
            getIntentCreatedEventEncoder().encode({
              intent,
              owner: intent,
              nonce: 0n,
              kind: 2,
              inputMint: NATIVE_MINT,
              outputMint: TEST_TOKEN,
              receiver: intent,
              escrowed: LAMPORTS_PER_SOL / 20n,
              expiresAt: 0n,
              rentPayer: intent,
              flags: 0,
              bounty: 0,
              createFee: 0,
            }),
          ),
          tag(
            getIntentFilledEventEncoder().encode({
              intent,
              owner: intent,
              solver: intent,
              receiver: intent,
              solverInput: intent,
              amountIn: LAMPORTS_PER_SOL / 20n,
              delivered: (9_966_666_667n * LAMPORTS_PER_SOL) / 1_000_000_000n,
              required: 0n,
              fee: 0n,
              net: 0n,
              filled: LAMPORTS_PER_SOL / 20n,
              remaining: 0n,
              partnerFee: 0n,
            }),
          ),
        ],
      },
    ];
    const preview = await ok(client, "wallet_swap", swap);
    expect(preview).toMatchObject({ start_receive: "10.166" });
    expect(await ok(client, "wallet_swap", { ...swap, min_receive: "11" })).not.toHaveProperty("start_receive");
    const now = h.svm.getClock().unixTimestamp;
    const sent = await ok(client, "wallet_swap", { ...swap, start_receive: preview["start_receive"], falls_over: 90, send: true });
    expect(sent).toMatchObject({ sent: true, start_receive: "10.166" });
    h.watched.push(owner);
    const [listed] = (await ok(client, "wallet_intents"))["intents"] as Json[];
    const start = now + BigInt(LANDING_SECONDS);
    expect(listed).toMatchObject({
      order: { kind: "dutch", start_out: String((10_166n * LAMPORTS_PER_SOL) / 1_000n), end_out: String(5n * LAMPORTS_PER_SOL), start_time: String(start), end_time: String(start + 90n) },
      expires_at: String(start + BigInt(DEFAULT_EXPIRES_IN)),
    });
    expect(await ok(client, "wallet_swap", { ...swap, exact: true })).not.toHaveProperty("start_receive");
  });

  it("schedules a repeated swap as orders sent now, each holding its ask until its turn", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    h.engineLog = [];
    const plan = { sell: "SOL", buy: "TEST", amount: "0.05", min_receive: "5", every: 600, times: 3 };
    const now = h.svm.getClock().unixTimestamp;
    const opens = [0n, 600n, 1_200n].map((k) => now + BigInt(LANDING_SECONDS) + k);
    const preview = await ok(client, "wallet_recurring", plan);
    expect(preview).toMatchObject({ orders: opens.map((at) => ({ opens_at: String(at) })), start_receive: "6.25", sent: false, next: PREVIEW_ONLY });
    expect(preview["orders"][0]).not.toHaveProperty("intent");
    h.watched.push(owner);
    expect((await ok(client, "wallet_intents"))["intents"]).toEqual([]);
    const sent = await ok(client, "wallet_recurring", { ...plan, start_receive: "6.25", falls_over: 300, send: true });
    expect(sent["orders"]).toHaveLength(3);
    expect(sent).toMatchObject({ sent: true, orders: opens.map((at, i) => ({ opens_at: String(at), nonce: String(i), signature: expect.any(String) })) });
    const listed = ((await ok(client, "wallet_intents"))["intents"] as Json[]).sort((a, b) => Number(a["nonce"]) - Number(b["nonce"]));
    expect(listed.map((intent) => intent["order"])).toEqual(
      opens.map((at) => expect.objectContaining({ kind: "dutch", start_out: String(625n * LAMPORTS_PER_SOL / 100n), end_out: String(5n * LAMPORTS_PER_SOL), start_time: String(at), end_time: String(at + 300n) })),
    );
    expect(listed.map((intent) => intent["expires_at"])).toEqual(opens.map((at) => String(at + 600n)));
    expect((await call(client, "wallet_recurring", { ...plan, min_receive: "7", start_receive: "7" })).value).toMatchObject({ code: "InvalidInput" });
  });

  it("refuses a schedule past the hourly limit before sending any of it, and reports how far a failed one got", async () => {
    client = await connect(["mcp", "--url", "devnet", "--wallet", "--wallet-per-hour", "SOL=0.12"]);
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    h.engineLog = [];
    h.watched.push(owner);
    const plan = { sell: "SOL", buy: "TEST", amount: "0.05", min_receive: "5", every: 600, times: 3, send: true };
    expect((await call(client, "wallet_recurring", plan)).value).toMatchObject({ code: "WalletHourLimit" });
    expect((await ok(client, "wallet_intents"))["intents"]).toEqual([]);
    h.sendFails = { error: new BlockhashExpired("expired"), landed: false, after: 1 };
    const partly = await ok(client, "wallet_recurring", { ...plan, times: 2 });
    expect(partly).toMatchObject({ sent: true, next: "1 of 2 orders were sent; the next failed with Failed: expired" });
    expect(partly["orders"][0]).toHaveProperty("intent");
    expect(partly["orders"][1]).not.toHaveProperty("intent");
    expect((await ok(client, "wallet_intents"))["intents"]).toHaveLength(1);
  });

  it("escrows a payment that only the named attestor can release, to the wallet it names", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    const worker = (await generateKeyPairSigner()).address;
    const stranger = (await generateKeyPairSigner()).address;
    const preview = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: owner });
    expect(preview).toMatchObject({ sent: false, next: PREVIEW_ONLY, warnings: expect.arrayContaining([WARN_ATTESTOR]) });
    expect(h.svm.getAccount(preview["intent"] as Address).exists).toBe(false);
    const escrow = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: owner, min_result: "1", max_result: "3", send: true });
    const intent = escrow["intent"] as Address;
    const nonce = escrow["nonce"] as string;
    expect(h.svm.getAccount(intent).exists).toBe(true);
    const release = { owner, nonce, pay_to: worker };
    expect((await call(client, "wallet_attest", { ...release, result: "4" })).value).toMatchObject({ code: "InvalidInput" });
    const shown = await ok(client, "wallet_attest", release);
    const payee = await findAssociatedTokenAddress({ owner: worker, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const { fee, net } = splitFee(LAMPORTS_PER_SOL / 20n, FEE_BPS);
    expect(shown).toMatchObject({ intent, pay_to: worker, payee, result: "1", paid: formatAmount(net, 9), fee: formatAmount(fee, 9), sent: false });
    expect(shown["summary"][0]).toBe(`Pays: ${formatAmount(net, 9)} of SOL to ${worker} from ${owner}'s escrow`);
    expect(shown["summary"]).toContain(`Setup: creates ${worker}'s SOL account, paid by this wallet`);
    expect(shown["summary"]).toContain("Setup: creates the engine treasury's SOL account for the fee, paid by this wallet");
    expect(JSON.stringify(shown)).not.toMatch(/transaction/);
    expect(h.svm.getAccount(payee).exists).toBe(false);
    expect(await ok(client, "wallet_attest", { ...release, result: "2", send: true })).toMatchObject({ sent: true, signature: expect.any(String) });
    expect(balance(payee)).toBe(net);
    expect((await call(client, "wallet_attest", release)).value).toMatchObject({ code: "InvalidTransition" });
    const other = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.01", attestor: stranger, send: true });
    expect((await call(client, "wallet_attest", { owner, nonce: other["nonce"], pay_to: worker, send: true })).value).toMatchObject({
      code: "Unauthorized",
      hint: notAttestor(stranger),
    });
    expect((await call(client, "wallet_attest", { owner, nonce: "99", pay_to: worker })).value).toMatchObject({ code: "NotFound" });
  });

  it("pays what a swap buys to the wallet named as pay_to, creating its token account", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    const friend = (await generateKeyPairSigner()).address;
    const theirs = await findAssociatedTokenAddress({ owner: friend, mint: TEST_TOKEN, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const mine = await findAssociatedTokenAddress({ owner, mint: TEST_TOKEN, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const order = { sell: "SOL", buy: "TEST", amount: "0.05", min_receive: "5", exact: true, pay_to: friend };
    const preview = await ok(client, "wallet_swap", order);
    expect(preview["summary"]).toContain(`Pays to: ${friend}, who receives what the solver pays`);
    expect(preview["summary"]).toContain(`Setup: creates ${friend}'s token account for ${TEST_TOKEN} (you pay its rent)`);
    expect(preview["summary"]).not.toContain(`Setup: creates your token account for ${TEST_TOKEN} (you pay its rent)`);
    const sent = await ok(client, "wallet_swap", { ...order, send: true });
    const account = h.svm.getAccount(sent["intent"] as Address);
    if (!account.exists) {
      throw new Error("the intent was not created");
    }
    expect(getIntentDecoder().decode(account.data).receiver).toBe(theirs);
    expect(h.svm.getAccount(theirs).exists).toBe(true);
    expect(h.svm.getAccount(mine).exists).toBe(false);
    const again = await ok(client, "wallet_auction", { sell: "SOL", buy: "TEST", amount: "0.01", start_receive: "3", end_receive: "1", falls_over: 60, pay_to: friend });
    expect(again["summary"]).toContain(`Pays to: ${friend}, who receives what the solver pays`);
    expect(again["summary"].join(" ")).not.toMatch(/creates .*token account for/);
    const plan = await ok(client, "wallet_recurring", { sell: "SOL", buy: "TEST", amount: "0.01", min_receive: "1", start_receive: "2", every: 60, times: 2, pay_to: friend });
    expect(plan["summary"]).toContain(`Pays to: ${friend}, who receives what the solver pays`);
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

  it("runs a Dutch auction from the wallet: previews it, sends it only when told to, and asks less over the given seconds from when it lands", async () => {
    const made = await ok(client, "wallet_setup");
    const owner = made["address"] as Address;
    const args = { sell: "SOL", buy: "TEST", amount: "0.05", start_receive: "12", end_receive: "9.5", falls_over: 600 };
    const preview = await ok(client, "wallet_auction", args);
    expect(preview).toMatchObject({ nonce: "0", sent: false, next: PREVIEW_ONLY });
    expect(preview["summary"]).toContain("Setup: wraps 0.05 of your SOL into your wrapped SOL account");
    expect(h.svm.getAccount(preview["intent"] as Address).exists).toBe(false);
    const now = h.svm.getClock().unixTimestamp;
    expect(await ok(client, "wallet_auction", { ...args, send: true })).toMatchObject({ intent: preview["intent"], sent: true });
    h.watched.push(owner);
    const [listed] = (await ok(client, "wallet_intents"))["intents"] as Json[];
    const start = now + BigInt(LANDING_SECONDS);
    expect(listed).toMatchObject({
      status: "open",
      order: {
        kind: "dutch",
        amount_in: String(LAMPORTS_PER_SOL / 20n),
        start_out: String(12n * LAMPORTS_PER_SOL),
        end_out: String((95n * LAMPORTS_PER_SOL) / 10n),
        start_time: String(start),
        end_time: String(start + 600n),
      },
      expires_at: String(start + BigInt(DEFAULT_EXPIRES_IN)),
    });
    const longer = await ok(client, "wallet_auction", { ...args, falls_over: DEFAULT_EXPIRES_IN * 2 });
    expect(longer["summary"]).toContain(`Expires: ${new Date(Number(start + BigInt(DEFAULT_EXPIRES_IN * 2)) * 1000).toISOString()}`);
    expect((await call(client, "wallet_auction", { ...args, start_receive: "9", end_receive: "12" })).error).toBe(true);
  });

  it("checks the cluster again before it sends, even after a preview passed", async () => {
    await ok(client, "wallet_setup");
    const args = { sell: "SOL", buy: "TEST", amount: "0.05", min_receive: "5" };
    expect(await ok(client, "wallet_swap", args)).toMatchObject({ sent: false });
    h.genesis = MAINNET_GENESIS;
    expect((await call(client, "wallet_swap", { ...args, send: true })).value).toMatchObject({ code: "WalletNotMainnet", hint: WALLET_NOT_MAINNET });
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

  it("refuses, even on preview, to sell past the limits the server was started with, and counts only what it sent", async () => {
    client = await connect(["mcp", "--url", "devnet", "--wallet", "--wallet-per-trade", "SOL=0.1", "--wallet-per-hour", "SOL=0.15"]);
    expect(client.getInstructions()).toBe(
      [
        WALLET_INSTRUCTIONS,
        "Whoever started this server set sell limits that no tool call can change:",
        "- SOL: at most 0.1 per trade and 0.15 per hour",
        "It sells no other token. Plan trades within these limits and tell the user when a request exceeds them.",
      ].join("\n"),
    );
    await ok(client, "wallet_setup");
    const swap = { sell: "SOL", buy: "TEST", min_receive: "5" };
    expect((await call(client, "wallet_swap", { ...swap, amount: "0.11" })).value).toMatchObject({
      code: "WalletTradeLimit",
      retryable: false,
      hint: "this server sells at most 0.1 SOL per trade and this sells 0.11; sell less, or the user restarts the server with a higher --wallet-per-trade",
    });
    expect((await call(client, "wallet_swap", { sell: "TEST", buy: "SOL", amount: "1", min_receive: "0.001" })).value).toMatchObject({
      code: "WalletTokenNotAllowed",
      hint: "this server sells only SOL, not TEST; its limits were set when it started",
    });
    for (let i = 0; i < 3; i++) {
      await ok(client, "wallet_swap", { ...swap, amount: "0.1" });
    }
    await ok(client, "wallet_swap", { ...swap, amount: "0.1", send: true });
    const auction = { sell: "SOL", buy: "TEST", amount: "0.06", start_receive: "12", end_receive: "11", falls_over: 600 };
    expect((await call(client, "wallet_auction", auction)).value).toMatchObject({
      code: "WalletHourLimit",
      retryable: true,
      hint: "this server sells at most 0.15 SOL per hour and has 0.05 left; this sells 0.06",
    });
    await ok(client, "wallet_auction", { ...auction, amount: "0.05", send: true });
    expect((await call(client, "wallet_swap", { ...swap, amount: "0.001" })).value).toMatchObject({ code: "WalletHourLimit" });
    setNow(h.svm.getClock().unixTimestamp + 3_601n);
    expect(await ok(client, "wallet_swap", { ...swap, amount: "0.1", send: true })).toMatchObject({ sent: true });
  });

  it("keeps counting a sale whose send failed unless the failure proves nothing landed", async () => {
    const limited = ["mcp", "--url", "devnet", "--wallet", "--wallet-per-hour", "SOL=0.15"];
    const swap = { sell: "SOL", buy: "TEST", amount: "0.1", min_receive: "5" };
    client = await connect(limited);
    await ok(client, "wallet_setup");
    h.sendFails = { error: new Error("fetch failed"), landed: true };
    expect((await call(client, "wallet_swap", { ...swap, send: true })).error).toBe(true);
    expect((await call(client, "wallet_swap", swap)).value).toMatchObject({ code: "WalletHourLimit" });
    for (const error of [new BlockhashExpired("expired"), new FailedOnChain("failed")]) {
      client = await connect(limited);
      h.sendFails = { error, landed: false };
      expect((await call(client, "wallet_swap", { ...swap, send: true })).error).toBe(true);
      expect(await ok(client, "wallet_swap", swap)).toMatchObject({ sent: false });
    }
  });

  it("sells none of a token whose limit has more decimals than the token", async () => {
    client = await connect(["mcp", "--url", "devnet", "--wallet", "--wallet-per-trade", "SOL=0.0000000001"]);
    await ok(client, "wallet_setup");
    expect((await call(client, "wallet_swap", { sell: "SOL", buy: "TEST", amount: "0.1", min_receive: "5" })).value).toMatchObject({
      code: "WalletTokenNotAllowed",
      hint: "this server's limit of 0.0000000001 SOL does not fit a token with 9 decimals, so it sells none; the user restarts it with a valid limit",
    });
  });

  it("estimates a swap from the rates of recent fills of the same pair, newest first", async () => {
    await ok(client, "wallet_setup");
    const key = (n: number) => `1111111111111111111111111111111${n}` as Address;
    const tag = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);
    const created = (intent: Address, inputMint: Address, outputMint: Address) =>
      tag(
        getIntentCreatedEventEncoder().encode({
          intent,
          owner: intent,
          nonce: 0n,
          kind: 0,
          inputMint,
          outputMint,
          receiver: intent,
          escrowed: 1n,
          expiresAt: 0n,
          rentPayer: intent,
          flags: 0,
          bounty: 0,
          createFee: 0,
        }),
      );
    const filled = (intent: Address, amountIn: bigint, delivered: bigint) =>
      tag(
        getIntentFilledEventEncoder().encode({
          intent,
          owner: intent,
          solver: intent,
          receiver: intent,
          solverInput: intent,
          amountIn,
          delivered,
          required: delivered,
          fee: amountIn / 2_000n,
          net: amountIn - amountIn / 2_000n,
          filled: amountIn,
          remaining: 0n,
          partnerFee: 0n,
        }),
      );
    const begun = (intent: Address, amountIn: bigint) =>
      tag(
        getFillBegunEventEncoder().encode({
          intent,
          solver: intent,
          solverInput: intent,
          endIndex: 1,
          amountIn,
          fee: amountIn / 2_000n,
          net: amountIn - amountIn / 2_000n,
          filled: amountIn,
          remaining: 0n,
          partnerFee: 0n,
        }),
      );
    const ended = (intent: Address, delivered: bigint) =>
      tag(getFillEndedEventEncoder().encode({ intent, owner: intent, solver: intent, receiver: intent, delivered, required: delivered }));
    const tx = (signature: string, emitted: Uint8Array[], failed = false) => ({ signature, slot: 1n, blockTime: 1_700_000_000n, failed, emitted });
    const sol = LAMPORTS_PER_SOL;
    h.engineLog = [
      tx("newest", [created(key(2), NATIVE_MINT, TEST_TOKEN), filled(key(2), sol / 20n, 5n * sol)]),
      tx("other-pair", [created(key(3), TEST_TOKEN, NATIVE_MINT), filled(key(3), sol, sol / 200n)]),
      tx("failed", [created(key(4), NATIVE_MINT, TEST_TOKEN), filled(key(4), sol / 20n, 50n * sol)], true),
      tx("older", [begun(key(5), sol / 10n), ended(key(5), (1993n * sol) / 100n)]),
      tx("older-created", [created(key(5), NATIVE_MINT, TEST_TOKEN)]),
    ];
    h.requestedLimits.length = 0;
    expect(await ok(client, "wallet_estimate", { sell: "SOL", buy: "TEST", amount: "0.05" })).toEqual({
      fills: [
        { sold: "0.05", received: "5", at: "1700000000", signature: "newest" },
        { sold: "0.1", received: "19.93", at: "1700000000", signature: "older" },
      ],
      receive_at_best: "9.965",
      receive_at_latest: "5",
      next: ESTIMATE_NEXT,
    });
    expect(h.requestedLimits).toEqual([ESTIMATE_SCAN]);
    expect(await ok(client, "wallet_estimate", { sell: "SOL", buy: "TEST", amount: "1" })).toMatchObject({ receive_at_best: "199.3" });
    h.engineLog = [];
    expect(await ok(client, "wallet_estimate", { sell: "SOL", buy: "TEST", amount: "0.05" })).toEqual({ fills: [], next: NO_FILLS });
  });

  it("waits for a sent intent and says whether it filled, for how much, or was cancelled", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    const sent = await ok(client, "wallet_swap", { sell: "SOL", buy: "TEST", amount: "0.05", min_receive: "5", send: true });
    const intent = sent["intent"] as Address;
    h.engineLog = [];
    h.sleeps.length = 0;
    h.rounds = 3;
    expect(await ok(client, "wallet_wait", { nonce: "0", within: 5 })).toEqual({ intent, status: "open", waited: 2, next: stillWaiting("open") });
    expect(h.sleeps).toEqual([1, 1, 1]);
    h.sleeps.length = 0;
    expect(await ok(client, "wallet_wait", { nonce: "0", within: 1 })).toMatchObject({ status: "open", waited: 1 });
    const account = h.svm.getAccount(intent);
    if (!account.exists) {
      throw new Error("the intent was not created");
    }
    const decoded = getIntentDecoder().decode(account.data);
    h.svm.setAccount({ ...account, data: Uint8Array.from(getIntentEncoder().encode({ ...decoded, status: IntentStatus.Filled })) });
    const tag = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);
    const fill = getIntentFilledEventEncoder().encode({
      intent,
      owner,
      solver: owner,
      receiver: owner,
      solverInput: owner,
      amountIn: LAMPORTS_PER_SOL / 20n,
      delivered: 5n * LAMPORTS_PER_SOL,
      required: 5n * LAMPORTS_PER_SOL,
      fee: LAMPORTS_PER_SOL / 40_000n,
      net: LAMPORTS_PER_SOL / 20n - LAMPORTS_PER_SOL / 40_000n,
      filled: LAMPORTS_PER_SOL / 20n,
      remaining: 0n,
      partnerFee: 0n,
    });
    h.engineLog = [{ signature: "fill", slot: 1n, blockTime: null, failed: false, emitted: [tag(fill)] }];
    h.requestedOf.length = 0;
    expect(await ok(client, "wallet_wait", { nonce: "0" })).toEqual({ intent, status: "filled", waited: 0, received: "5", token: "TEST", signature: "fill" });
    expect(h.requestedOf).toEqual([intent]);
    h.svm.setAccount({ ...account, data: Uint8Array.from(getIntentEncoder().encode({ ...decoded, status: IntentStatus.Open })) });
    await ok(client, "wallet_cancel", { nonce: "0", send: true });
    const cancelled = getIntentCancelledEventEncoder().encode({ intent, owner, refunded: LAMPORTS_PER_SOL / 20n });
    h.engineLog = [{ signature: "cancel", slot: 1n, blockTime: null, failed: false, emitted: [tag(cancelled)] }];
    expect(await ok(client, "wallet_wait", { nonce: "0" })).toEqual({ intent, status: "cancelled", waited: 0 });
    h.engineLog = [];
    expect(await ok(client, "wallet_wait", { nonce: "0" })).toEqual({ intent, status: "closed", waited: 0 });
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
