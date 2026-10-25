import { createHash } from "node:crypto";
import { type Address, lamports, none, some } from "@solana/kit";
import { AccountState, getTokenEncoder, getTokenSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { findAssociatedTokenAddress, formatAmount } from "@intent-engine/core";
import { EVENT_IX_TAG, findIntentPda, getIntentCreatedEventEncoder, getIntentFilledEventEncoder, WARN_LONG_LIVED, formatTime } from "@intent-engine/core/internal";
import { beforeEach, describe, expect, it } from "vitest";
import { BlockhashExpired } from "@intent-engine/client";
import { AgentRefusal } from "../src/agent/problems.js";
import { InvalidInput } from "../src/agent/schema.js";
import { instructionsFor, START_PROMPT, WALLET_INSTRUCTIONS } from "../src/agent/mcp.js";
import { DEFAULT_EXPIRES_IN, ESTIMATE_SCAN, LANDING_SECONDS, mayHaveLanded, NO_FALL, NOTHING_WRAPPED, partlySent, WARN_EARLY, NO_WALLET, PREVIEW_ONLY, WALLET_ACTIONS, WALLET_NOTICE } from "../src/agent/wallet.js";
import { ACTIONS } from "../src/agent/registry.js";
import { DEVNET_TEST_MINT as TEST_TOKEN, NATIVE_MINT } from "@intent-engine/core";
import { AIRDROP, defaultWallet, holdsEnough, keptDefault, LAMPORTS_PER_SOL, savedDefault, settingsPath } from "../src/wallet.js";
import { WALLET_START } from "../src/agent/wallet/account.js";
import { unwrapped } from "../src/agent/wallet/unwrap.js";
import { balance, funded, h, HOME } from "./harness.js";
import { orderPreviewNext } from "../src/agent/wallet/trade.js";
import { call, connect, created, fresh, type Json, ok, tag } from "./agent-wallet-kit.js";
import { keyed } from "./announce.js";
import { approved } from "./approved.js";

describe("the wallet server's trades", () => {
  let client: Client;

  beforeEach(async () => {
    client = await fresh();
  });

  it("starts reading recent engine transactions as it starts, so the first estimate finds them ready", async () => {
    h.requestedLimits.length = 0;
    await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    expect(h.requestedLimits).toEqual([ESTIMATE_SCAN]);
    h.requestedLimits.length = 0;
    await connect(["mcp", "--url", "devnet"]);
    expect(h.requestedLimits).toEqual([]);
  });

  it("offers its wallet tools first, says how to use them and how to start", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([...WALLET_ACTIONS, ...ACTIONS].map((a) => a.name));
    expect(client.getInstructions()).toBe(instructionsFor([...WALLET_ACTIONS, ...ACTIONS]));
    expect(client.getInstructions()?.startsWith(WALLET_INSTRUCTIONS)).toBe(true);
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
    expect(made).toMatchObject({ keypair: defaultWallet(HOME), created: true, sol: "1", next: holdsEnough("1", WALLET_START), notice: WALLET_NOTICE });
    const owner = made["address"] as Address;
    expect(h.airdrops).toEqual([{ address: owner, lamports: AIRDROP }]);
    expect(await ok(client, "wallet_setup")).toMatchObject({ address: owner, created: false });
    const preview = await ok(client, "wallet_swap", { sell: "SOL", buy: "TEST", amount: "0.05", min_receive: "5", exact: true });
    expect(preview).toMatchObject({ nonce: "0", sent: false, next: orderPreviewNext(false) });
    expect(preview["start_receive"]).toBeUndefined();
    expect(preview["summary"]).toContain("Setup: wraps 0.05 of your SOL into your wrapped SOL account");
    expect(preview["summary"].slice(0, 2)).toEqual([`Sell: exactly 0.05 of SOL (${NATIVE_MINT})`, `Receive: at least 5 of TEST (${TEST_TOKEN})`]);
    const [intent] = await findIntentPda({ owner, nonce: 0n });
    expect(preview["intent"]).toBe(intent);
    expect(h.svm.getAccount(intent).exists).toBe(false);
    const swapped = await ok(client, "wallet_swap", await approved(client, "wallet_swap", { sell: "sol", buy: "test", amount: "0.05", min_receive: "5", exact: true }));
    expect(swapped).toMatchObject({ intent, sent: true, signature: expect.any(String) });
    expect(swapped["next"]).toContain("solive_wallet_wait");
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
    expect(await ok(client, "wallet_cancel", { nonce: "0", close: false })).toMatchObject({ intent, sent: false });
    expect(h.svm.getAccount(intent).exists).toBe(true);
    const cancelled = await ok(client, "wallet_cancel", { nonce: "0", send: true });
    expect(cancelled).toMatchObject({ intent, sent: true });
    expect(cancelled["next"]).toContain("solive_wallet_balance");
    expect(h.svm.getAccount(intent).exists).toBe(false);
    expect(balance(wrapped)).toBe(LAMPORTS_PER_SOL / 20n);
    expect((await ok(client, "wallet_intents"))["intents"]).toEqual([]);
  });

  it("hashes text and pre-checks a spec url against spec_hash before funding", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    const spec = "the acceptance spec the work must pass\n";
    const specHash = createHash("sha256").update(spec).digest("hex");
    expect((await ok(client, "hash", { text: spec }))["sha256"]).toBe(specHash);
    const url = "https://example.org/jobs/spec.md";
    h.specPages.set(url, new TextEncoder().encode(spec));
    const good = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: owner, spec_hash: specHash, spec_url: url });
    expect((good["warnings"] as string[]).some((w) => w.includes("hashes to"))).toBe(false);
    const bad = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: owner, spec_hash: "aa".repeat(32), spec_url: url });
    expect((bad["warnings"] as string[]).some((w) => w.includes("hashes to"))).toBe(true);
    const missing = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: owner, spec_hash: specHash, spec_url: "https://example.org/jobs/missing.md" });
    expect((missing["warnings"] as string[]).some((w) => w.includes("could not be fetched"))).toBe(true);
  });

  it("wallet setup returns a redacted url", async () => {
    const secret = "https://user:pass@rpc.example.org:8443/v1/path?api-key=hidden";
    const keyed = await connect(["mcp", "--url", secret, "--wallet", "--all-tools"]);
    const made = await ok(keyed, "wallet_setup");
    expect(made).toMatchObject({ url: "https://rpc.example.org:8443", settings: savedDefault(secret) });
    expect(savedDefault(secret)).toBe("saved https://rpc.example.org:8443 as the default RPC for later CLI commands");
    expect(JSON.stringify(made)).not.toMatch(/hidden|user:pass|v1\/path/);
    expect(JSON.parse(h.files.get(settingsPath(HOME)) ?? "{}")).toMatchObject({ url: secret });
    const other = await connect(["mcp", "--url", "https://other.example.org/?api-key=also", "--wallet", "--all-tools"]);
    const again = await ok(other, "wallet_setup");
    expect(again).toMatchObject({ url: "https://other.example.org", settings: keptDefault(secret), created: false });
    expect(keptDefault(secret)).toBe("left the saved default RPC https://rpc.example.org:8443 unchanged");
    expect(JSON.stringify(again)).not.toMatch(/hidden|also/);
    expect(JSON.parse(h.files.get(settingsPath(HOME)) ?? "{}")).toMatchObject({ url: secret });
  });

  it("lets the ask fall from a little above the median recent fill, held between 1.25 and 2 times the minimum, unless told to ask the minimum", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    const swap = { sell: "SOL", buy: "TEST", amount: "0.05", min_receive: "7" };
    h.engineLog = [];
    expect(await ok(client, "wallet_swap", { ...swap, min_receive: "5" })).toMatchObject({ start_receive: "6.25" });
    const tag = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);
    const filledAt = (intent: Address, amountIn: bigint, delivered: bigint) => ({
      signature: `fill-${intent}`,
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
            escrowed: amountIn,
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
            amountIn,
            delivered,
            required: 0n,
            fee: 0n,
            net: 0n,
            filled: amountIn,
            remaining: 0n,
            partnerFee: 0n,
          }),
        ),
      ],
    });
    const honest = filledAt("11111111111111111111111111111112" as Address, LAMPORTS_PER_SOL / 20n, (9_966_666_667n * LAMPORTS_PER_SOL) / 1_000_000_000n);
    const staged = (k: number) => filledAt(`1111111111111111111111111111111${k}` as Address, 1n, 1_000_000n * LAMPORTS_PER_SOL);
    h.engineLog = [honest];
    const preview = await ok(client, "wallet_swap", swap);
    expect(preview).toMatchObject({ start_receive: "10.166" });
    expect(await ok(client, "wallet_swap", { ...swap, min_receive: "5" })).toMatchObject({ start_receive: "10" });
    expect(await ok(client, "wallet_swap", { ...swap, min_receive: "11" })).toMatchObject({ start_receive: "13.75" });
    const market = await ok(client, "wallet_swap", { sell: "SOL", buy: "TEST", amount: "0.05" });
    expect(Number(market["min_receive"])).toBeGreaterThan(9.8);
    expect(Number(market["min_receive"])).toBeLessThan(9.967);
    const looser = await ok(client, "wallet_swap", { sell: "SOL", buy: "TEST", amount: "0.05", max_slippage_bps: 2000 });
    expect(Number(looser["min_receive"])).toBeLessThan(Number(market["min_receive"]));
    h.engineLog = [];
    expect((await call(client, "wallet_swap", { sell: "SOL", buy: "TEST", amount: "0.05" })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "min_receive" }] });
    h.engineLog = [staged(3), honest];
    expect(await ok(client, "wallet_swap", swap)).toMatchObject({ start_receive: "10.166" });
    h.engineLog = [staged(3), staged(4), honest];
    expect(await ok(client, "wallet_swap", swap)).toMatchObject({ start_receive: "14" });
    h.engineLog = [honest];
    const now = h.svm.getClock().unixTimestamp;
    const sent = await ok(client, "wallet_swap", await approved(client, "wallet_swap", { ...swap, start_receive: preview["start_receive"], falls_over: 90 }));
    expect(sent).toMatchObject({ sent: true, start_receive: "10.166" });
    h.watched.push(owner);
    const [listed] = (await ok(client, "wallet_intents"))["intents"] as Json[];
    const start = now + BigInt(LANDING_SECONDS);
    expect(listed).toMatchObject({
      order: { kind: "dutch", start_out: String((10_166n * LAMPORTS_PER_SOL) / 1_000n), end_out: String(7n * LAMPORTS_PER_SOL), start_time: String(start), end_time: String(start + 90n) },
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
    expect(preview).toMatchObject({ orders: opens.map((at) => ({ opens_at: String(at) })), start_receive: "6.25", sent: false, next: orderPreviewNext(true) });
    expect(preview["orders"][0]).not.toHaveProperty("intent");
    expect(preview["summary"].slice(0, 2)).toEqual([
      "Plan: 3 orders of 0.05 of SOL, 0.15 of SOL in all, escrowed now",
      `Schedule: the orders open from ${formatTime(opens[0] as bigint)} to ${formatTime(opens[2] as bigint)}; the last expires ${formatTime((opens[2] as bigint) + 600n)}, 30 minutes 10 seconds from now`,
    ]);
    expect(preview["warnings"]).toEqual([WARN_EARLY]);
    const yearly = await ok(client, "wallet_recurring", { ...plan, every: 30 * 24 * 60 * 60, times: 2 });
    expect(yearly["warnings"]).toEqual([WARN_LONG_LIVED, WARN_EARLY]);
    const later = await ok(client, "wallet_recurring", { ...plan, every: 15 * 24 * 60 * 60, times: 3 });
    expect(later["warnings"]).toEqual([WARN_EARLY, WARN_LONG_LIVED]);
    h.watched.push(owner);
    expect((await ok(client, "wallet_intents"))["intents"]).toEqual([]);
    const sent = await ok(client, "wallet_recurring", await approved(client, "wallet_recurring", { ...plan, start_receive: "6.25", falls_over: 300 }));
    expect(sent["orders"]).toHaveLength(3);
    expect(sent).toMatchObject({ sent: true, orders: opens.map((at, i) => ({ opens_at: String(at), nonce: String(i), signature: expect.any(String) })) });
    const listed = ((await ok(client, "wallet_intents"))["intents"] as Json[]).sort((a, b) => Number(a["nonce"]) - Number(b["nonce"]));
    expect(listed.map((intent) => intent["order"])).toEqual(
      opens.map((at) => expect.objectContaining({ kind: "dutch", start_out: String(625n * LAMPORTS_PER_SOL / 100n), end_out: String(5n * LAMPORTS_PER_SOL), start_time: String(at), end_time: String(at + 300n) })),
    );
    expect(listed.map((intent) => intent["expires_at"])).toEqual(opens.map((at) => String(at + 600n)));
    expect((await call(client, "wallet_recurring", { ...plan, min_receive: "7", start_receive: "7" })).value).toMatchObject({
      code: "InvalidInput",
      issues: [{ path: "start_receive" }],
    });
    expect((await call(client, "wallet_recurring", { ...plan, min_receive: "0" })).value).toMatchObject({
      code: "InvalidInput",
      issues: [{ path: "min_receive", message: NO_FALL }],
    });
  });

  it("refuses a schedule past the hourly limit before sending any of it, and reports how far a failed one got", async () => {
    client = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools", "--wallet-per-hour", "SOL=0.12"]);
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    h.engineLog = [];
    h.watched.push(owner);
    const plan = { sell: "SOL", buy: "TEST", amount: "0.05", min_receive: "5", every: 600, times: 3, send: true };
    expect((await call(client, "wallet_recurring", plan)).value).toMatchObject({ code: "WalletHourLimit" });
    expect((await ok(client, "wallet_intents"))["intents"]).toEqual([]);
    h.sendFails = { error: new BlockhashExpired("expired"), landed: false, after: 1 };
    const partly = await ok(client, "wallet_recurring", await approved(client, "wallet_recurring", { ...plan, times: 2 }));
    expect(partly).toMatchObject({ sent: true, next: partlySent(1, 2, "Failed: expired") });
    expect(partly["orders"][0]).toHaveProperty("intent");
    expect(partly["orders"][1]).not.toHaveProperty("intent");
    expect((await ok(client, "wallet_intents"))["intents"]).toHaveLength(1);
    h.sendFails = { error: new Error("timed out"), landed: true, after: 1 };
    const unsure = await ok(client, "wallet_recurring", await approved(client, "wallet_recurring", { ...plan, amount: "0.01", times: 2 }));
    expect(unsure["next"]).toBe(mayHaveLanded(1, 2, "Failed: timed out"));
    expect((await ok(client, "wallet_intents"))["intents"]).toHaveLength(3);
    h.sendFails = { error: new AgentRefusal("WalletEmpty", "empty"), landed: false, after: 1 };
    const refused = await ok(client, "wallet_recurring", await approved(client, "wallet_recurring", { ...plan, amount: "0.01", times: 2 }));
    expect(refused["next"]).toBe(partlySent(1, 2, "WalletEmpty: empty"));
    h.sendFails = { error: new InvalidInput([{ path: "x", message: "bad" }]), landed: false, after: 1 };
    const invalid = await ok(client, "wallet_recurring", await approved(client, "wallet_recurring", { ...plan, amount: "0.01", times: 2 }));
    expect(invalid["next"]).toBe(partlySent(1, 2, "InvalidInput: fix the listed fields and call again"));
  });


  it("unwraps this wallet's wrapped SOL into plain SOL, and refuses when it holds none", async () => {
    const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
    expect((await call(client, "wallet_unwrap")).value).toMatchObject({ code: "NotFound", hint: NOTHING_WRAPPED });
    const wrapped = await findAssociatedTokenAddress({ owner: wallet, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const space = BigInt(getTokenSize());
    const rent = h.svm.minimumBalanceForRentExemption(space);
    const held = 48_500_000n;
    h.svm.setAccount({
      address: wrapped,
      data: Uint8Array.from(
        getTokenEncoder().encode({
          mint: NATIVE_MINT,
          owner: wallet,
          amount: held,
          delegate: none(),
          state: AccountState.Initialized,
          isNative: some(rent),
          delegatedAmount: 0n,
          closeAuthority: none(),
        }),
      ),
      executable: false,
      lamports: lamports(rent + held),
      programAddress: TOKEN_PROGRAM_ADDRESS,
      space,
    });
    expect(await ok(client, "wallet_unwrap")).toMatchObject({ account: wrapped, wrapped: "0.0485", sent: false, next: PREVIEW_ONLY });
    const before = h.svm.getBalance(wallet) ?? 0n;
    expect(await ok(client, "wallet_unwrap", { send: true })).toMatchObject({ sent: true, next: unwrapped("0.0485", formatAmount(rent, 9), formatAmount(rent + held, 9)) });
    expect(h.svm.getAccount(wrapped).exists).toBe(false);
    expect((h.svm.getBalance(wallet) ?? 0n) - before).toBeGreaterThan(held);
  });
});
