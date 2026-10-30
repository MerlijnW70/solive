import { type Address, generateKeyPairSigner, lamports, none, SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, SolanaError } from "@solana/kit";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AccountState, getTokenEncoder, getTokenSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { findAssociatedTokenAddress, IntentStatus } from "@intent-engine/core";
import { EVENT_IX_TAG, findIntentPda, getIntentCancelledEventEncoder, getIntentCreatedEventEncoder, getIntentDecoder, getIntentEncoder, getFillBegunEventEncoder, getFillEndedEventEncoder, getIntentFilledEventEncoder, WARN_RECEIVER } from "@intent-engine/core/internal";
import { beforeEach, describe, expect, it } from "vitest";
import { testSignature } from "@intent-engine/client/testing";
import { BlockhashExpired, FailedOnChain, MaybeSent } from "@intent-engine/client";
import { failure } from "@intent-engine/client/internal";
import { WALLET_NOT_MAINNET } from "../src/args.js";
import { WRAPPED } from "../src/agent/create.js";
import { InvalidInput } from "../src/agent/schema.js";
import { MARKET_GUIDE, toolIndex, WALLET_INSTRUCTIONS } from "../src/agent/mcp.js";
import { DEFAULT_EXPIRES_IN, ESTIMATE_NEXT, ESTIMATE_SCAN, FILL_UNKNOWN, LANDING_SECONDS, MAINNET_GENESIS, NO_FILLS, UNREAD, RECORD_MINT_NEEDED, PREVIEW_ONLY, stillWaiting, WALLET_ACTIONS, WALLET_OFF, walletBalance, walletEmpty } from "../src/agent/wallet.js";
import { invoke } from "../src/agent/actions.js";
import { claimsOf } from "../src/agent/claims.js";
import { ACTIONS } from "../src/agent/registry.js";
import { EXIT_USAGE } from "../src/main.js";
import { DEVNET_TEST_MINT as TEST_TOKEN, NATIVE_MINT } from "@intent-engine/core";
import { airdropRefused, defaultWallet, faucetLink, LAMPORTS_PER_SOL } from "../src/wallet.js";
import { cli, creation, h, HOME, setNow, transport, world } from "./harness.js";
import { salesPath } from "../src/agent/sales.js";
import { call, connect, created, fresh, type Json, ok, tag } from "./agent-wallet-kit.js";
import { approved } from "./approved.js";

describe("the wallet server's limits and reads", () => {
  let client: Client;

  beforeEach(async () => {
    client = await fresh();
  });

  it("escrows SOL off devnet only with a record mint it is told, since TEST is a devnet name", async () => {
    client = await connect(["mcp", "--url", "localnet", "--wallet", "--all-tools"]);
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    expect((await call(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: owner })).value).toMatchObject({
      code: "InvalidInput",
      issues: [{ path: "record_mint", message: RECORD_MINT_NEEDED }],
    });
    const shown = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: owner, record_mint: TEST_TOKEN });
    expect(shown).toMatchObject({ sent: false });
  });

  it("pays what a swap buys to the wallet named as pay_to, creating its token account", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    const friend = (await generateKeyPairSigner()).address;
    const theirs = await findAssociatedTokenAddress({ owner: friend, mint: TEST_TOKEN, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const mine = await findAssociatedTokenAddress({ owner, mint: TEST_TOKEN, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const order = { sell: "SOL", buy: "TEST", amount: "0.05", min_receive: "5", exact: true, pay_to: friend };
    const preview = await ok(client, "wallet_swap", order);
    expect(preview["summary"]).toContain(`Pays to: ${friend}, who receives what the solver pays`);
    expect(preview["warnings"]).toEqual([WARN_RECEIVER]);
    expect((await call(client, "wallet_swap", { ...order, pay_to: owner })).value["summary"].join(" ")).not.toMatch(/Pays to/);
    expect(preview["summary"]).toContain(`Setup: creates ${friend}'s token account for ${TEST_TOKEN} (you pay its rent)`);
    expect(preview["summary"]).not.toContain(`Setup: creates your token account for ${TEST_TOKEN} (you pay its rent)`);
    const sent = await ok(client, "wallet_swap", await approved(client, "wallet_swap", { ...order }));
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
    const space = BigInt(getTokenSize());
    h.svm.setAccount({
      address: mine,
      data: Uint8Array.from(
        getTokenEncoder().encode({
          mint: TEST_TOKEN,
          owner,
          amount: LAMPORTS_PER_SOL,
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
    const back = await ok(client, "wallet_swap", { ...order, sell: "TEST", buy: "SOL", amount: "1", min_receive: "0.001" });
    expect(back["summary"].join(" ")).toContain(WRAPPED);
  });

  it("says how to fund an empty wallet before it tries to swap", async () => {
    h.airdropRefused = true;
    const made = await ok(client, "wallet_setup");
    const address = made["address"] as string;
    expect(made).toMatchObject({ sol: "0", next: airdropRefused(address) });
    expect(made["next"]).toContain(faucetLink(address));
    expect((await call(client, "wallet_swap", { sell: "SOL", buy: "TEST", amount: "0.05", min_receive: "5" })).value).toMatchObject({
      code: "WalletEmpty",
      hint: walletEmpty(address),
    });
    expect(walletEmpty(address)).toContain(faucetLink(address));
  });

  it("reads the cluster once per server and refuses to make, read or sign with a wallet on an RPC that serves mainnet under another name", async () => {
    const reads = h.genesisReads;
    await ok(client, "wallet_setup");
    await ok(client, "wallet_balance");
    await ok(client, "wallet_intents");
    expect(h.genesisReads - reads).toBe(1);
    h.genesis = MAINNET_GENESIS;
    client = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
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
    expect(longer["summary"]).toContain(`Expires: ${new Date(Number(start + BigInt(DEFAULT_EXPIRES_IN * 2)) * 1000).toISOString()}, 2 hours from now`);
    expect((await call(client, "wallet_auction", { ...args, start_receive: "9", end_receive: "12" })).error).toBe(true);
  });

  it("checks the cluster again before it sends, even after a preview passed", async () => {
    await ok(client, "wallet_setup");
    const args = { sell: "SOL", buy: "TEST", amount: "0.05", min_receive: "5" };
    expect(await ok(client, "wallet_swap", args)).toMatchObject({ sent: false });
    h.genesis = MAINNET_GENESIS;
    expect((await call(client, "wallet_swap", await approved(client, "wallet_swap", { ...args }))).value).toMatchObject({ code: "WalletNotMainnet", hint: WALLET_NOT_MAINNET });
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
    client = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools", "--wallet-per-trade", "SOL=0.1", "--wallet-per-hour", "SOL=0.15"]);
    expect(client.getInstructions()).toBe(
      [
        WALLET_INSTRUCTIONS,
        MARKET_GUIDE,
        "Whoever started this server set sell limits that no tool call can change:",
        "- SOL: at most 0.1 per trade and 0.15 per hour",
        "It sells no other token. Plan trades within these limits and tell the user when a request exceeds them.",
        ...toolIndex([...WALLET_ACTIONS, ...ACTIONS]),
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
    await ok(client, "wallet_swap", await approved(client, "wallet_swap", { ...swap, amount: "0.1" }));
    const auction = { sell: "SOL", buy: "TEST", amount: "0.06", start_receive: "12", end_receive: "11", falls_over: 600 };
    expect((await call(client, "wallet_auction", auction)).value).toMatchObject({
      code: "WalletHourLimit",
      retryable: true,
      hint: "this server sells at most 0.15 SOL per hour and has 0.05 left; this sells 0.06",
    });
    await ok(client, "wallet_auction", { ...auction, amount: "0.05", send: true });
    expect((await call(client, "wallet_swap", { ...swap, amount: "0.001" })).value).toMatchObject({ code: "WalletHourLimit" });
    setNow(h.svm.getClock().unixTimestamp + 3_601n);
    expect(await ok(client, "wallet_swap", await approved(client, "wallet_swap", { ...swap, amount: "0.1" }))).toMatchObject({ sent: true });
  });

  it("keeps counting a sale whose send failed unless the failure proves nothing landed", async () => {
    const limited = ["mcp", "--url", "devnet", "--wallet", "--all-tools", "--wallet-per-hour", "SOL=0.15"];
    const swap = { sell: "SOL", buy: "TEST", amount: "0.1", min_receive: "5" };
    client = await connect(limited);
    await ok(client, "wallet_setup");
    h.sendFails = { error: new Error("fetch failed"), landed: true };
    expect((await call(client, "wallet_swap", await approved(client, "wallet_swap", { ...swap }))).error).toBe(true);
    expect((await call(client, "wallet_swap", swap)).value).toMatchObject({ code: "WalletHourLimit" });
    setNow(h.svm.getClock().unixTimestamp + 3_601n);
    for (const error of [new BlockhashExpired("expired"), new FailedOnChain("failed", failure(testSignature("sent"), null))]) {
      client = await connect(limited);
      h.sendFails = { error, landed: false };
      expect((await call(client, "wallet_swap", await approved(client, "wallet_swap", { ...swap }))).error).toBe(true);
      expect(await ok(client, "wallet_swap", swap)).toMatchObject({ sent: false });
    }
  });

  it("two wallet servers share one hourly allowance", async () => {
    const limited = ["mcp", "--url", "devnet", "--wallet", "--all-tools", "--wallet-per-hour", "SOL=0.15"];
    const first = await connect(limited);
    await ok(first, "wallet_setup");
    const second = await connect(limited);
    const swap = { sell: "SOL", buy: "TEST", amount: "0.1", min_receive: "5", exact: true };
    expect(await ok(first, "wallet_swap", await approved(first, "wallet_swap", { ...swap }))).toMatchObject({ sent: true });
    const left = { code: "WalletHourLimit", retryable: true, hint: "this server sells at most 0.15 SOL per hour and has 0.05 left; this sells 0.1" };
    expect((await call(second, "wallet_swap", swap)).value).toMatchObject(left);
    expect((await call(second, "wallet_swap", await approved(second, "wallet_swap", { ...swap }))).value).toMatchObject(left);
    const book = join(h.saleRoot, salesPath(defaultWallet(HOME)));
    expect(statSync(book).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(book, "utf8"))).toMatchObject([{ mint: NATIVE_MINT, amount: String(LAMPORTS_PER_SOL / 10n) }]);
    const third = await connect(limited);
    const racing = await Promise.all([second, third].map((server) => approved(server, "wallet_swap", { ...swap, amount: "0.05" })));
    const raced = await Promise.all([second, third].map((server, i) => call(server, "wallet_swap", racing[i] ?? {})));
    expect(raced.map((r) => (r.error ? r.value["code"] : "sent")).sort()).toEqual(["WalletHourLimit", "sent"]);
    expect(JSON.parse(readFileSync(book, "utf8"))).toHaveLength(2);
    setNow(h.svm.getClock().unixTimestamp + 3_601n);
    expect(await ok(second, "wallet_swap", await approved(second, "wallet_swap", { ...swap }))).toMatchObject({ sent: true });
    expect((await call(third, "wallet_swap", { ...swap, amount: "0.06" })).value).toMatchObject({ code: "WalletHourLimit" });
  });

  it("a tilde keypair path and its absolute form share one sales book", async () => {
    const limited = ["mcp", "--url", "devnet", "--wallet", "--all-tools", "--wallet-per-hour", "SOL=0.15"];
    const first = await connect(limited);
    await ok(first, "wallet_setup");
    const swap = { sell: "SOL", buy: "TEST", amount: "0.1", min_receive: "5", exact: true };
    expect(await ok(first, "wallet_swap", await approved(first, "wallet_swap", { ...swap }))).toMatchObject({ sent: true });
    const tilde = "~/.config/intent-engine/wallet.json";
    h.files.set(tilde, h.files.get(defaultWallet(HOME)) ?? "");
    h.env["INTENT_ENGINE_KEYPAIR"] = tilde;
    const second = await connect(limited);
    expect((await call(second, "wallet_swap", await approved(second, "wallet_swap", { ...swap }))).value).toMatchObject({ code: "WalletHourLimit" });
    expect(await ok(second, "wallet_swap", await approved(second, "wallet_swap", { ...swap, amount: "0.05" }))).toMatchObject({ sent: true });
    expect(JSON.parse(readFileSync(join(h.saleRoot, salesPath(defaultWallet(HOME))), "utf8"))).toHaveLength(2);
    expect(existsSync(join(h.saleRoot, "~"))).toBe(false);
    expect(existsSync(join(h.saleRoot, salesPath(tilde)))).toBe(false);
  });

  it("a send refused at preflight does not count against the limit", async () => {
    const limited = ["mcp", "--url", "devnet", "--wallet", "--all-tools", "--wallet-per-hour", "SOL=0.15"];
    client = await connect(limited);
    await ok(client, "wallet_setup");
    const swap = { sell: "SOL", buy: "TEST", amount: "0.1", min_receive: "5" };
    const refusals = [
      new SolanaError(SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE, {
        accounts: null,
        logs: ["Transfer: insufficient lamports"],
        returnData: null,
        unitsConsumed: 0n,
      } as never),
      new SolanaError(SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR, { headers: new Headers(), message: "Too Many Requests", statusCode: 429 }),
      new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8899"), { code: "ECONNREFUSED" }) }),
    ];
    for (const error of refusals) {
      h.sendFails = { error, landed: false };
      expect((await call(client, "wallet_swap", await approved(client, "wallet_swap", { ...swap }))).error).toBe(true);
      expect(await ok(client, "wallet_swap", swap)).toMatchObject({ sent: false });
    }
    expect(JSON.parse(readFileSync(join(h.saleRoot, salesPath(defaultWallet(HOME))), "utf8"))).toEqual([]);
    h.sendFails = { error: new MaybeSent(testSignature("sent"), 0n, "transaction was sent but its confirmation could not be read"), landed: true };
    const unsure = await call(client, "wallet_swap", await approved(client, "wallet_swap", { ...swap }));
    expect(unsure.error).toBe(true);
    expect(unsure.value).toMatchObject({ code: "MaybeSent", retryable: false, signature: testSignature("sent") });
    expect(unsure.value["hint"]).toContain(`intent-engine lookup --signature ${testSignature("sent")} --valid-until 0`);
    expect((await call(client, "wallet_swap", swap)).value).toMatchObject({ code: "WalletHourLimit" });
  });

  it("a nonce collision on create is retried with the next free nonce", async () => {
    const first = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    const owner = (await ok(first, "wallet_setup"))["address"] as Address;
    const swap = { sell: "SOL", buy: "TEST", amount: "0.01", min_receive: "1", exact: true };
    expect(await ok(first, "wallet_swap", await approved(first, "wallet_swap", { ...swap }))).toMatchObject({ nonce: "0" });
    let raced = false;
    h.through = {
      ...transport,
      sendWire: async (wire, latest) => {
        if (!raced) {
          raced = true;
          expect(await ok(first, "wallet_swap", await approved(first, "wallet_swap", { ...swap, amount: "0.02" }))).toMatchObject({ nonce: "1" });
        }
        return transport.sendWire(wire, latest);
      },
    };
    const second = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    h.through = null;
    const [taken] = await findIntentPda({ owner, nonce: 1n });
    const [next] = await findIntentPda({ owner, nonce: 2n });
    expect(await ok(second, "wallet_swap", await approved(second, "wallet_swap", { ...swap }))).toMatchObject({ intent: next, nonce: "2", sent: true });
    expect(raced).toBe(true);
    expect(h.svm.getAccount(taken).exists).toBe(true);
    expect(h.svm.getAccount(next).exists).toBe(true);
  });

  it("sells none of a token whose limit has more decimals than the token", async () => {
    client = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools", "--wallet-per-trade", "SOL=0.0000000001"]);
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
    const tx = (label: string, emitted: Uint8Array[], failed = false) => ({ signature: testSignature(label), slot: 1n, blockTime: 1_700_000_000n, failed, emitted });
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
        { sold: "0.05", received: "5", at: "1700000000", signature: testSignature("newest") },
        { sold: "0.1", received: "19.93", at: "1700000000", signature: testSignature("older") },
      ],
      receive_at_best: "9.965",
      receive_at_median: "5",
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
    const sent = await ok(client, "wallet_swap", await approved(client, "wallet_swap", { sell: "SOL", buy: "TEST", amount: "0.05", min_receive: "5" }));
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
    h.engineLog = [{ signature: testSignature("fill"), slot: 1n, blockTime: null, failed: false, emitted: [tag(fill)] }, creation(intent)];
    h.requestedOf.length = 0;
    expect(await ok(client, "wallet_wait", { nonce: "0" })).toEqual({ intent, status: "filled", waited: 0, received: "5", token: "TEST", signature: testSignature("fill") });
    expect(h.requestedOf).toEqual([intent]);
    h.svm.setAccount({ ...account, data: Uint8Array.from(getIntentEncoder().encode({ ...decoded, status: IntentStatus.Open })) });
    await ok(client, "wallet_cancel", { nonce: "0", send: true });
    const cancelled = getIntentCancelledEventEncoder().encode({ intent, owner, refunded: LAMPORTS_PER_SOL / 20n });
    h.engineLog = [{ signature: testSignature("cancel"), slot: 1n, blockTime: null, failed: false, emitted: [tag(cancelled)] }];
    expect(await ok(client, "wallet_wait", { nonce: "0" })).toEqual({ intent, status: "cancelled", waited: 0 });
    h.engineLog = [creation(intent)];
    expect(await ok(client, "wallet_wait", { nonce: "0" })).toEqual({ intent, status: "closed", waited: 0 });
    h.engineLog = [];
    expect(await ok(client, "wallet_wait", { nonce: "0" })).toEqual({ intent, status: "closed", waited: 0, next: FILL_UNKNOWN });
    h.engineLog = [{ signature: testSignature("lagging"), slot: 2n, blockTime: null, failed: false, emitted: [], unread: true }];
    expect(await ok(client, "wallet_wait", { nonce: "0" })).toEqual({ intent, status: "closed", waited: 0, next: UNREAD });
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
