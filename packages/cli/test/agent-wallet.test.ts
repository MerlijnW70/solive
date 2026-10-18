import { createHash } from "node:crypto";
import {
  type Address,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase16Decoder,
  getBase16Encoder,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type KeyPairSigner,
  lamports,
  none,
  partiallySignTransaction,
  signBytes,
  SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE,
  SOLANA_ERROR__RPC__TRANSPORT_HTTP_ERROR,
  SolanaError,
} from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const bytesOf = (hex: string) => Uint8Array.from(getBase16Encoder().encode(hex));
import { AccountState, getMintEncoder, getMintSize, getTokenEncoder, getTokenSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
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
  decodeParams,
  deliveryMemo,
  RELEASE_MEMO_PREFIX,
  Kind,
  specMemo,
  getFillBegunEventEncoder,
  getFillEndedEventEncoder,
  getIntentFilledEventEncoder,
  getIntentAttestedEventEncoder,
  getIntentSplitEventEncoder,
  getFillAttestedSplitInstructionDataEncoder,
  getCreateIntentInstructionDataEncoder,
  attestedSplitMessage,
  buildEd25519BatchInstruction,
  buildFillAttestedSplit,
  computeUnitLimit,
  computeUnitPrice,
  MAX_COMPUTE_UNITS,
  releaseMemo,
  splitCommit,
  IntentStatus,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  formatAmount,
  splitFee,
  splitN,
  WARN_ATTESTOR,
  WARN_LONG_LIVED,
  WARN_PROOF,
  WARN_RECEIVER,
  formatTime,
} from "@intent-engine/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  BlockhashExpired,
  Charged,
  DELIVERY_PAGES,
  DELIVERY_SCAN,
  type EngineTransaction,
  FailedOnChain,
  type ListedSignature,
  SIGNATURE_PAGE,
  followUpMemo,
  loadConfig,
  MEMO_PROGRAM_ADDRESS,
  memoInstruction,
  signersAmong,
  type Transport,
} from "@intent-engine/client";
import { LOOKUP_TABLE_HEADER } from "@intent-engine/solver";
import { transactionSize } from "../src/agent/prepare.js";
import { RELEASE_NEEDED, WALLET_NOT_MAINNET } from "../src/args.js";
import { WRAPPED } from "../src/agent/create.js";
import { AgentRefusal } from "../src/agent/problems.js";
import { InvalidInput } from "../src/agent/schema.js";
import { notAWallet, TOKEN_ACCOUNT_RECIPIENT } from "../src/agent/owner.js";
import { START_PROMPT, WALLET_INSTRUCTIONS } from "../src/agent/mcp.js";
import {
  DEFAULT_EXPIRES_IN,
  DELIVERED_NEEDED,
  ESTIMATE_NEXT,
  ESTIMATE_SCAN,
  ATTEST_PAGES,
  creationUnread,
  escrowGone,
  historyLagging,
  LIFECYCLE_FETCHES,
  MAX_ATTEST_PAGES,
  FILL_UNKNOWN,
  followUpsUnknown,
  otherLifecycle,
  RECEIPT_PARTIAL,
  RELEASE_PAGES,
  HISTORY_PAGES,
  HISTORY_TOO_LONG,
  LANDING_SECONDS,
  neverAnnounced,
  paidOther,
  recipientsUnread,
  RELEASE_UNKNOWN,
  splitPaidOthers,
  MAINNET_GENESIS,
  NO_FILLS,
  mayHaveLanded,
  notAttestor,
  notEarliest,
  notInSplit,
  NO_FALL,
  NOT_RELEASED,
  PACKET_DATA_SIZE,
  RECORDS_SPLIT,
  SPLIT_FITS,
  SPLIT_FITS_WITH_TABLE,
  partlySent,
  piecesMayHaveLanded,
  piecesPartlySent,
  RELEASE_CHANGED,
  UNREAD,
  WAIT_SCAN,
  WARN_EARLY,
  alreadyRecorded,
  notReleasedYet,
  releasedBy,
  releaseNotOf,
  releaseUnread,
  RECORD_MINT_NEEDED,
  NO_WALLET,
  PREVIEW_ONLY,
  PREVIEW_APPROVAL_NEXT,
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
import { DEVNET_TEST_MINT as TEST_TOKEN, NATIVE_MINT } from "@intent-engine/core";
import { AIRDROP, airdropRefused, defaultWallet, faucetLink, FUNDED, keptDefault, LAMPORTS_PER_SOL, savedDefault, settingsPath } from "../src/wallet.js";
import { ata, balance, cli, creation, FEE_BPS, funded, h, HOME, setNow, transport, world } from "./harness.js";
import { salesPath } from "../src/agent/sales.js";

type Json = Record<string, unknown> & { [key: string]: any };

const ADDRESS_LOOKUP_TABLE_PROGRAM = "AddressLookupTab1e1111111111111111111111111" as Address;

function landedAs(wire: string): EngineTransaction {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
  const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const keys = message.staticAccounts;
  const memos = ("instructions" in message ? message.instructions : []).filter((ix) => keys[ix.programAddressIndex] === MEMO_PROGRAM_ADDRESS);
  return {
    signature: getSignatureFromTransaction(tx),
    slot: 9n,
    blockTime: null,
    failed: false,
    emitted: [],
    memos: memos.map((ix) => new TextDecoder().decode(Uint8Array.from(ix.data ?? []))),
    memoSigners: memos.map((ix) => signersAmong(keys, ix.accountIndices ?? [], message.header.numSignerAccounts)),
    ...(keys[0] === undefined ? {} : { feePayer: keys[0] }),
  };
}

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
    client = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
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
    const sent = await ok(client, "wallet_swap", { ...swap, start_receive: preview["start_receive"], falls_over: 90, send: true });
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
    expect(preview).toMatchObject({ orders: opens.map((at) => ({ opens_at: String(at) })), start_receive: "6.25", sent: false, next: PREVIEW_ONLY });
    expect(preview["orders"][0]).not.toHaveProperty("intent");
    expect(preview["summary"].slice(0, 2)).toEqual([
      "Plan: 3 orders of 0.05 of SOL, 0.15 of SOL in all, escrowed now",
      `Schedule: the orders open from ${formatTime(opens[0] as bigint)} to ${formatTime(opens[2] as bigint)}; the last expires ${formatTime((opens[2] as bigint) + 600n)}`,
    ]);
    expect(preview["warnings"]).toEqual([WARN_EARLY]);
    const yearly = await ok(client, "wallet_recurring", { ...plan, every: 30 * 24 * 60 * 60, times: 2 });
    expect(yearly["warnings"]).toEqual([WARN_LONG_LIVED, WARN_EARLY]);
    const later = await ok(client, "wallet_recurring", { ...plan, every: 15 * 24 * 60 * 60, times: 3 });
    expect(later["warnings"]).toEqual([WARN_EARLY, WARN_LONG_LIVED]);
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
    const partly = await ok(client, "wallet_recurring", { ...plan, times: 2 });
    expect(partly).toMatchObject({ sent: true, next: partlySent(1, 2, "Failed: expired") });
    expect(partly["orders"][0]).toHaveProperty("intent");
    expect(partly["orders"][1]).not.toHaveProperty("intent");
    expect((await ok(client, "wallet_intents"))["intents"]).toHaveLength(1);
    h.sendFails = { error: new Error("timed out"), landed: true, after: 1 };
    const unsure = await ok(client, "wallet_recurring", { ...plan, amount: "0.01", times: 2 });
    expect(unsure["next"]).toBe(mayHaveLanded(1, 2, "Failed: timed out"));
    expect((await ok(client, "wallet_intents"))["intents"]).toHaveLength(3);
    h.sendFails = { error: new AgentRefusal("WalletEmpty", "empty"), landed: false, after: 1 };
    const refused = await ok(client, "wallet_recurring", { ...plan, amount: "0.01", times: 2 });
    expect(refused["next"]).toBe(partlySent(1, 2, "WalletEmpty: empty"));
    h.sendFails = { error: new InvalidInput([{ path: "x", message: "bad" }]), landed: false, after: 1 };
    const invalid = await ok(client, "wallet_recurring", { ...plan, amount: "0.01", times: 2 });
    expect(invalid["next"]).toBe(partlySent(1, 2, "InvalidInput: fix the listed fields and call again"));
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
    expect((await call(client, "wallet_attest", { ...release, result: "4" })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "result" }] });
    h.simulated.length = 0;
    const shown = await ok(client, "wallet_attest", release);
    expect(shown).toMatchObject({ sent: false, next: PREVIEW_APPROVAL_NEXT });
    expect(h.simulated).toEqual([]);
    expect(shown["summary"][0]).toContain(WRAPPED);
    const wrapped = await findAssociatedTokenAddress({ owner, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect((await call(client, "wallet_attest", { ...release, pay_to: wrapped })).value).toMatchObject({
      code: "InvalidInput",
      issues: [{ path: "pay_to", message: TOKEN_ACCOUNT_RECIPIENT }],
    });
    const payee = await findAssociatedTokenAddress({ owner: worker, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const { fee, net } = splitFee(LAMPORTS_PER_SOL / 20n, FEE_BPS);
    expect(shown).toMatchObject({ intent, pay_to: worker, payee, result: "1", paid: formatAmount(net, 9), fee: formatAmount(fee, 9), sent: false });
    expect(shown["summary"][0]).toBe(`Pays: ${formatAmount(net, 9)} of SOL to ${worker} from ${owner}'s escrow${WRAPPED}`);
    expect(shown["summary"]).toContain(`Setup: creates ${worker}'s SOL account, paid by this wallet`);
    expect(shown["summary"]).toContain("Setup: creates the engine treasury's SOL account for the fee, paid by this wallet");
    expect(JSON.stringify(shown)).not.toMatch(/transaction/);
    expect(h.svm.getAccount(payee).exists).toBe(false);
    expect((await call(client, "wallet_attest", { ...release, pay_to: intent })).value).toMatchObject({
      code: "InvalidInput",
      issues: [{ path: "pay_to", message: notAWallet(INTENT_ENGINE_PROGRAM_ADDRESS) }],
    });
    const changed = { code: "ReleaseChanged", hint: RELEASE_CHANGED };
    expect((await call(client, "wallet_attest", { ...release, result: "2", send: true })).value).toMatchObject(changed);
    expect((await call(client, "wallet_attest", { ...release, result: "2", approval: shown["approval"], send: true })).value).toMatchObject(changed);
    const second = await ok(client, "wallet_attest", { ...release, result: "2" });
    expect(second["approval"]).toMatch(/^[0-9a-f]{16}$/);
    expect(second["approval"]).not.toBe(shown["approval"]);
    expect(second).not.toHaveProperty("delivered_sha256");
    const work = "a".repeat(64);
    const hashed = await ok(client, "wallet_attest", { ...release, result: "2", delivered_sha256: work.toUpperCase() });
    expect(hashed).toMatchObject({ delivered_sha256: work });
    expect(hashed["summary"]).toContain(`Records: the delivered work's sha256 ${work}, in a memo this wallet signs with the release`);
    expect(hashed["approval"]).not.toBe(second["approval"]);
    expect((await call(client, "wallet_attest", { ...release, delivered_sha256: "abc" })).value).toMatchObject({
      code: "InvalidInput",
      issues: [{ path: "delivered_sha256" }],
    });
    expect((await call(client, "wallet_attest", { ...release, result: "2", delivered_sha256: work, approval: second["approval"], send: true })).value).toMatchObject(changed);
    expect(h.svm.getAccount(payee).exists).toBe(false);
    h.wires.length = 0;
    expect(await ok(client, "wallet_attest", { ...release, result: "2", delivered_sha256: work, approval: hashed["approval"], send: true })).toMatchObject({
      sent: true,
      signature: expect.any(String),
    });
    expect(Buffer.from(h.wires[0] as string, "base64").toString("latin1")).toContain(`${RELEASE_MEMO_PREFIX}${work}`);
    expect(balance(payee)).toBe(net);
    expect((await call(client, "wallet_attest", release)).value).toMatchObject({ code: "InvalidTransition" });
    const other = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.01", attestor: stranger, send: true });
    expect((await call(client, "wallet_attest", { owner, nonce: other["nonce"], pay_to: worker, send: true })).value).toMatchObject({
      code: "Unauthorized",
      hint: notAttestor(stranger),
    });
    expect((await call(client, "wallet_attest", { owner, nonce: "99", pay_to: worker })).value).toMatchObject({ code: "NotFound" });
    expect(await ok(client, "wallet_cancel", { nonce: other["nonce"], send: true })).toMatchObject({ sent: true });
    expect(h.svm.getAccount(other["intent"] as Address).exists).toBe(false);
    const brief = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.01", attestor: owner, expires_in: 60, send: true });
    setNow(h.svm.getClock().unixTimestamp + 3_600n);
    expect((await call(client, "wallet_attest", { owner, nonce: brief["nonce"], pay_to: worker })).value).toMatchObject({ code: "IntentExpired" });
  });

  it("escrows a proof intent that binds a spec and pays the judge out of the escrow", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    const worker = (await generateKeyPairSigner()).address;
    const specHash = "6a".repeat(32);
    expect((await call(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: owner, judge_fee: "0.001" })).value).toMatchObject({
      code: "InvalidInput",
      issues: [{ path: "judge_fee" }],
    });
    const escrow = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: owner, min_result: "1", max_result: "1", spec_hash: specHash, judge_fee: "0.001", send: true });
    expect(escrow["warnings"]).toContain(WARN_PROOF);
    expect(escrow["warnings"]).not.toContain(WARN_ATTESTOR);
    const intent = escrow["intent"] as Address;
    const nonce = escrow["nonce"] as string;
    const account = h.svm.getAccount(intent);
    if (!account.exists) {
      throw new Error("the proof intent was not created");
    }
    const held = getIntentDecoder().decode(account.data);
    const params = decodeParams(held.kind, Uint8Array.from(held.params));
    expect(params.kind).toBe(Kind.AttestedResult);
    if (params.kind === Kind.AttestedResult) {
      expect(getBase16Decoder().decode(params.specHash)).toBe(specHash);
      expect(params.judgeFee).toBe(LAMPORTS_PER_SOL / 1_000n);
    }
    h.engineLog = [creation(intent)];
    const release = { owner, nonce, pay_to: worker, delivered_sha256: "ab".repeat(32) };
    const shown = await ok(client, "wallet_attest", release);
    expect(shown["warnings"]).toEqual([WARN_PROOF]);
    expect(shown["summary"]).toEqual(expect.arrayContaining([expect.stringContaining("Pays the judge"), expect.stringContaining(`Binds: the result to the committed spec ${specHash}`)]));
    const settled = await ok(client, "wallet_attest", { ...release, approval: shown["approval"], send: true });
    const judgeFee = LAMPORTS_PER_SOL / 1_000n;
    const { fee } = splitFee(LAMPORTS_PER_SOL / 20n - judgeFee, FEE_BPS);
    expect(settled["paid"]).toBe(formatAmount(LAMPORTS_PER_SOL / 20n - judgeFee - fee, 9));
    const workerAta = await findAssociatedTokenAddress({ owner: worker, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const judgeAta = await findAssociatedTokenAddress({ owner, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(balance(workerAta)).toBe(LAMPORTS_PER_SOL / 20n - judgeFee - fee);
    expect(balance(judgeAta)).toBe(judgeFee);
  });

  it("releases a proof escrow split among co-authors only when every one of them signs the exact split", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    const coauthors = [await generateKeyPairSigner()];
    const weights = [10000];
    const specHash = "a".repeat(64);
    const escrow = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: owner, min_result: "1", max_result: "1", spec_hash: specHash, send: true });
    const nonce = escrow["nonce"] as string;
    const delivered_sha256 = "ab".repeat(32);
    h.engineLog = [creation(escrow["intent"] as Address)];
    const recipients = coauthors.map((c, i) => ({ wallet: c.address, weight: weights[i] }));
    const { net } = splitFee(LAMPORTS_PER_SOL / 20n, FEE_BPS);
    const payout = splitN(net, weights);
    expect((await call(client, "wallet_attest_split", { owner, nonce, delivered_sha256, recipients: recipients.map((r, i) => ({ ...r, weight: i === 0 ? 5000 : r.weight })) })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "recipients" }] });
    const shown = await ok(client, "wallet_attest_split", { owner, nonce, delivered_sha256, recipients });
    expect(shown).toMatchObject({ intent: escrow["intent"], result: "1", net: formatAmount(net, 9), sent: false });
    expect((shown["paid"] as Json[]).map((p) => p["amount"])).toEqual(payout.map((a) => formatAmount(a, 9)));
    expect(shown["digest"]).toMatch(/^[0-9a-f]{64}$/);
    const lookupAccounts = shown["lookup_accounts"] as string[];
    expect(Array.isArray(lookupAccounts) && lookupAccounts.length > 0).toBe(true);
    expect(lookupAccounts).not.toContain(INTENT_ENGINE_PROGRAM_ADDRESS);
    expect(lookupAccounts).toContain(escrow["intent"]);
    const envelope = bytesOf(shown["envelope"] as string);
    const signed = await Promise.all(
      recipients.map(async (r, i) => ({
        ...r,
        signature: getBase16Decoder().decode(new Uint8Array(await signBytes(coauthors[i]!.keyPair.privateKey, envelope))),
      })),
    );
    expect((await call(client, "wallet_attest_split", { owner, nonce, delivered_sha256, recipients: signed, send: true })).value).toMatchObject({ code: "ReleaseChanged", hint: RELEASE_CHANGED });
    const missing = signed.map((s) => ({ wallet: s.wallet, weight: s.weight }));
    expect((await call(client, "wallet_attest_split", { owner, nonce, delivered_sha256, recipients: missing, approval: shown["approval"], send: true })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "recipients.0.signature" }] });
    const reshown = await ok(client, "wallet_attest_split", { owner, nonce, delivered_sha256, recipients: signed });
    const absentTable = (await generateKeyPairSigner()).address;
    expect((await call(client, "wallet_attest_split", { owner, nonce, delivered_sha256, recipients: signed, lookup_table: absentTable, approval: reshown["approval"], send: true })).value).toMatchObject({ code: "NotFound" });
    h.wires.length = 0;
    const done = await ok(client, "wallet_attest_split", { owner, nonce, delivered_sha256, recipients: signed, approval: shown["approval"], send: true });
    expect(h.wires.some((wire) => Buffer.from(wire, "base64").toString("latin1").includes(`${RELEASE_MEMO_PREFIX}${delivered_sha256}`))).toBe(true);
    expect(done).toMatchObject({ sent: true, signature: expect.any(String) });
    for (const [i, c] of coauthors.entries()) {
      const ata = await findAssociatedTokenAddress({ owner: c.address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
      expect(balance(ata)).toBe(payout[i]!);
    }
    expect((await call(client, "wallet_attest_split", { owner, nonce, delivered_sha256, recipients: signed, approval: shown["approval"], send: true })).value).toMatchObject({ code: "InvalidTransition" });
    const plain = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.02", attestor: owner, min_result: "1", max_result: "1", send: true });
    expect((await call(client, "wallet_attest_split", { owner, nonce: plain["nonce"], recipients })).value).toMatchObject({ code: "NotAProof" });
    const crowd = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: owner, min_result: "1", max_result: "1", spec_hash: specHash, send: true });
    h.engineLog = [creation(crowd["intent"] as Address)];
    const many = [await generateKeyPairSigner(), await generateKeyPairSigner(), await generateKeyPairSigner()];
    const manyRecipients = many.map((c, i) => ({ wallet: c.address, weight: [4000, 4000, 2000][i] }));
    const crowdShown = await ok(client, "wallet_attest_split", { owner, nonce: crowd["nonce"], delivered_sha256, recipients: manyRecipients });
    const crowdEnvelope = bytesOf(crowdShown["envelope"] as string);
    const crowdSigned = await Promise.all(
      manyRecipients.map(async (r, i) => ({ ...r, signature: getBase16Decoder().decode(new Uint8Array(await signBytes(many[i]!.keyPair.privateKey, crowdEnvelope))) })),
    );
    const tooLarge = (await call(client, "wallet_attest_split", { owner, nonce: crowd["nonce"], delivered_sha256, recipients: crowdSigned, approval: crowdShown["approval"], send: true })).value;
    expect(tooLarge).toMatchObject({ code: "ReleaseTooLarge" });
    expect(tooLarge["hint"]).toContain(`a release fits ${SPLIT_FITS} co-authors without a lookup table and ${SPLIT_FITS_WITH_TABLE} with one`);
  });

  async function releaseSize(recipients: number, withMemo: boolean, withTable: boolean): Promise<number> {
    const judge = await generateKeyPairSigner();
    const signers = await Promise.all(Array.from({ length: recipients }, () => generateKeyPairSigner()));
    const wallets = signers.map((s) => s.address);
    const weights = wallets.map((_, i) => (i === 0 ? 10_000 - Math.floor(10_000 / recipients) * (recipients - 1) : Math.floor(10_000 / recipients)));
    const owner = (await generateKeyPairSigner()).address;
    const feeRecipient = (await generateKeyPairSigner()).address;
    const [intent] = await findIntentPda({ owner, nonce: 1n });
    const settle = await buildFillAttestedSplit({
      solver: judge,
      owner,
      nonce: 1n,
      inputMint: NATIVE_MINT,
      inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      recipients: wallets,
      weights,
      feeRecipient,
      judge: judge.address,
      amountIn: LAMPORTS_PER_SOL,
      result: 1n,
      maxFeeBps: FEE_BPS,
    });
    const message = await attestedSplitMessage({
      domain: new Uint8Array(32),
      intent,
      amountIn: LAMPORTS_PER_SOL,
      result: 1n,
      filled: 0n,
      revision: 0,
      maxFeeBps: FEE_BPS,
      specHash: new Uint8Array(32).fill(1),
      splitHash: await splitCommit(wallets, weights),
    });
    const batch = buildEd25519BatchInstruction({ entries: [...wallets, judge.address].map((publicKey) => ({ publicKey, signature: new Uint8Array(64) })), message });
    const memo = memoInstruction(judge, releaseMemo("ab".repeat(32)));
    const instructions = [batch, settle, ...(withMemo ? [memo] : []), computeUnitLimit(MAX_COMPUTE_UNITS), computeUnitPrice(1n)];
    const invoked = new Set<Address>([INTENT_ENGINE_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS, judge.address]);
    const table = withTable ? { [(await generateKeyPairSigner()).address]: [...new Set((settle.accounts ?? []).map((a) => a.address))].filter((a) => !invoked.has(a)) } : undefined;
    return transactionSize(transport, instructions, judge.address, table);
  }

  it("a two co-author split release fits without a lookup table", async () => {
    expect(SPLIT_FITS).toBe(2);
    expect(await releaseSize(SPLIT_FITS, false, false)).toBeLessThanOrEqual(PACKET_DATA_SIZE);
    expect(await releaseSize(SPLIT_FITS + 1, false, false)).toBeGreaterThan(PACKET_DATA_SIZE);
    expect(await releaseSize(SPLIT_FITS, true, false)).toBeGreaterThan(PACKET_DATA_SIZE);
    expect(await releaseSize(SPLIT_FITS_WITH_TABLE, false, true)).toBeLessThanOrEqual(PACKET_DATA_SIZE);
    expect(await releaseSize(SPLIT_FITS_WITH_TABLE + 1, false, true)).toBeGreaterThan(PACKET_DATA_SIZE);

    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    h.watched.push(owner);
    const payer = await funded();
    const { config } = await loadConfig(transport);
    await ata(payer, config.feeRecipient, NATIVE_MINT);
    const coauthors = [await generateKeyPairSigner(), await generateKeyPairSigner()];
    for (const c of coauthors) {
      await ata(payer, c.address, NATIVE_MINT);
    }
    const escrow = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: owner, min_result: "1", max_result: "1", spec_hash: "5d".repeat(32), send: true });
    const nonce = escrow["nonce"] as string;
    const intent = escrow["intent"] as Address;
    const work = "d1".repeat(32);
    h.engineLog = [creation(intent)];
    const recipients = coauthors.map((c) => ({ wallet: c.address, weight: 5000 }));
    const shown = await ok(client, "wallet_attest_split", { owner, nonce, recipients, delivered_sha256: work });
    expect(shown["summary"]).toContain(RECORDS_SPLIT(work));
    expect(shown).not.toHaveProperty("recorded");
    const envelope = bytesOf(shown["envelope"] as string);
    const signed = await Promise.all(
      recipients.map(async (r, i) => ({ ...r, signature: getBase16Decoder().decode(new Uint8Array(await signBytes(coauthors[i]!.keyPair.privateKey, envelope))) })),
    );
    h.wires.length = 0;
    const done = await ok(client, "wallet_attest_split", { owner, nonce, recipients: signed, delivered_sha256: work, approval: shown["approval"], send: true });
    expect(done).toMatchObject({ sent: true, recorded: "follow-up", delivered_sha256: work, signature: expect.any(String), follow_up_signature: expect.any(String) });
    expect(h.wires).toHaveLength(2);
    const [release, followUp] = h.wires.map((wire) => Buffer.from(wire, "base64").toString("latin1"));
    expect(release).not.toContain(RELEASE_MEMO_PREFIX);
    expect(followUp).toContain(followUpMemo(work, done["signature"] as string));
    for (const c of coauthors) {
      expect(balance(await findAssociatedTokenAddress({ owner: c.address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS }))).toBeGreaterThan(0n);
    }
  });

  it("a split too large for the memo records the hash in a follow-up", async () => {
    const work = "d2".repeat(32);
    const { owner, intent, nonce, coauthors, recipients, announce } = await splitEscrow(work);
    const [first] = coauthors;
    if (first === undefined) {
      throw new Error("no co-authors");
    }
    const payer = await funded();
    const { config } = await loadConfig(transport);
    for (const wallet of [config.feeRecipient, ...coauthors.map((c) => c.address)]) {
      await ata(payer, wallet, NATIVE_MINT);
    }
    h.engineLog = [announce("early", 5n, first.address), creation(intent)];
    const shown = await ok(client, "wallet_attest_split", { owner, nonce, recipients, delivered_sha256: work });
    const other = await ok(client, "wallet_attest_split", { owner, nonce, recipients, delivered_sha256: "d3".repeat(32) });
    expect(other["approval"]).not.toBe(shown["approval"]);
    const envelope = bytesOf(shown["envelope"] as string);
    const signed = await Promise.all(
      recipients.map(async (r, i) => ({ ...r, signature: getBase16Decoder().decode(new Uint8Array(await signBytes(coauthors[i]!.keyPair.privateKey, envelope))) })),
    );
    expect((await call(client, "wallet_attest_split", { owner, nonce, recipients: signed, delivered_sha256: "d3".repeat(32), approval: shown["approval"], send: true })).value).toMatchObject({ code: "ReleaseChanged" });
    h.wires.length = 0;
    const done = await ok(client, "wallet_attest_split", { owner, nonce, recipients: signed, delivered_sha256: work, approval: shown["approval"], send: true });
    expect(done).toMatchObject({ sent: true, recorded: "follow-up", follow_up_signature: expect.any(String) });
    const [release, followUp] = h.wires.map((wire) => Buffer.from(wire, "base64").toString("latin1"));
    expect(release).not.toContain(RELEASE_MEMO_PREFIX);
    expect(followUp).toContain(followUpMemo(work, done["signature"] as string));
    const held = h.svm.getAccount(intent);
    expect(held.exists && getIntentDecoder().decode(held.data).status).toBe(IntentStatus.Filled);
  });

  async function cosignedSplit(work: string, payer: KeyPairSigner, weights?: readonly number[]) {
    const made = await splitEscrow(work, weights);
    for (const c of made.coauthors) {
      await ata(payer, c.address, NATIVE_MINT);
    }
    h.engineLog = [creation(made.intent)];
    const preview = await ok(client, "wallet_attest_split", { owner: made.owner, nonce: made.nonce, recipients: made.recipients, delivered_sha256: work });
    const sealed = bytesOf(preview["envelope"] as string);
    const cosigned = await Promise.all(
      made.recipients.map(async (r, i) => ({ ...r, signature: getBase16Decoder().decode(new Uint8Array(await signBytes(made.coauthors[i]!.keyPair.privateKey, sealed))) })),
    );
    return {
      ...made,
      lookupAccounts: preview["lookup_accounts"] as Address[],
      release: { owner: made.owner, nonce: made.nonce, recipients: cosigned, delivered_sha256: work, approval: preview["approval"], send: true },
    };
  }

  const lookupsOf = (wire: string): Address[] => {
    const message = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(getBase64Encoder().encode(wire)).messageBytes);
    return "addressTableLookups" in message ? (message.addressTableLookups ?? []).map((lookup) => lookup.lookupTableAddress) : [];
  };

  it("a split over the packet limit reaches the follow-up against an rpc that rejects oversized simulations", async () => {
    const work = "d5".repeat(32);
    const payer = await funded();
    const { config } = await loadConfig(transport);
    await ata(payer, config.feeRecipient, NATIVE_MINT);
    const split = await cosignedSplit(work, payer);
    h.packetLimit = true;
    h.simulated.length = 0;
    h.wires.length = 0;
    const done = await ok(client, "wallet_attest_split", split.release);
    expect(done).toMatchObject({ sent: true, recorded: "follow-up", delivered_sha256: work, follow_up_signature: expect.any(String) });
    expect(h.simulated.length).toBeGreaterThan(0);
    expect(h.simulated.every((wire) => getBase64Encoder().encode(wire).length <= PACKET_DATA_SIZE)).toBe(true);
    expect(h.wires).toHaveLength(2);
    const held = h.svm.getAccount(split.intent);
    expect(held.exists && getIntentDecoder().decode(held.data).status).toBe(IntentStatus.Filled);
  });

  it("a split sent with a lookup table is simulated with the table", async () => {
    const work = "d6".repeat(32);
    const payer = await funded();
    const { config } = await loadConfig(transport);
    await ata(payer, config.feeRecipient, NATIVE_MINT);
    const split = await cosignedSplit(work, payer, [4000, 3000, 3000]);
    const table = (await generateKeyPairSigner()).address;
    const header = new Uint8Array(LOOKUP_TABLE_HEADER);
    const view = new DataView(header.buffer);
    view.setUint32(0, 1, true);
    view.setBigUint64(4, 0xffff_ffff_ffff_ffffn, true);
    header[20] = split.lookupAccounts.length;
    const data = Uint8Array.from([...header, ...split.lookupAccounts.flatMap((address) => [...getAddressEncoder().encode(address)])]);
    h.svm.setAccount({
      address: table,
      data,
      executable: false,
      lamports: lamports(h.svm.minimumBalanceForRentExemption(BigInt(data.length))),
      programAddress: ADDRESS_LOOKUP_TABLE_PROGRAM,
      space: BigInt(data.length),
    });
    expect((await call(client, "wallet_attest_split", split.release)).value).toMatchObject({ code: "ReleaseTooLarge" });
    h.packetLimit = true;
    h.simulated.length = 0;
    const done = await ok(client, "wallet_attest_split", { ...split.release, lookup_table: table });
    expect(done).toMatchObject({ sent: true, delivered_sha256: work, recorded: expect.any(String) });
    const releases = h.simulated.filter((wire) => lookupsOf(wire).length > 0);
    expect(releases.length).toBeGreaterThanOrEqual(2);
    expect(releases.every((wire) => lookupsOf(wire).every((address) => address === table))).toBe(true);
    expect(h.simulated.every((wire) => getBase64Encoder().encode(wire).length <= PACKET_DATA_SIZE)).toBe(true);
    for (const c of split.coauthors) {
      expect(balance(await findAssociatedTokenAddress({ owner: c.address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS }))).toBeGreaterThan(0n);
    }
  });

  it("a failed follow-up says the hash is not recorded", async () => {
    const work = "d4".repeat(32);
    const payer = await funded();
    const { config } = await loadConfig(transport);
    await ata(payer, config.feeRecipient, NATIVE_MINT);
    const lost = await cosignedSplit(work, payer);
    h.wires.length = 0;
    h.sendFails = { error: new Error("blockhash not found"), landed: false, after: 1 };
    const failed = await ok(client, "wallet_attest_split", lost.release);
    expect(failed).toMatchObject({ sent: true, signature: expect.any(String), delivered_sha256: work, recorded: false });
    expect(failed).not.toHaveProperty("follow_up_signature");
    expect(failed["record_memo"]).toBe(followUpMemo(work, failed["signature"] as string));
    expect(failed["next"]).toMatch(/^the release landed, but the follow-up transaction that records the delivered work's sha256 failed, so the hash is not recorded on chain: /);
    expect(failed["next"]).toContain("to record it, call solive_wallet_record_delivery with the same owner and nonce, the delivered_sha256 as sha256 and this signature as release");
    expect(h.wires).toHaveLength(1);

    const tried: string[] = [];
    h.through = {
      ...transport,
      sendWire: async (wire, latest) => {
        tried.push(wire);
        return transport.sendWire(wire, latest);
      },
      engineTransactions: async () => [...tried.map(landedAs), ...h.engineLog],
    };
    client = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    const timedOut = await cosignedSplit(work, payer);
    h.sendFails = { error: new Error("timed out"), landed: true, after: 1 };
    const late = await ok(client, "wallet_attest_split", timedOut.release);
    const followUp = tried.map(landedAs).find((tx) => (tx.memos ?? []).includes(followUpMemo(work, late["signature"] as string)));
    expect(late).toMatchObject({ sent: true, recorded: "follow-up", follow_up_signature: followUp?.signature });
    expect(late["next"]).toContain("solive_wallet_feedback");
  });

  async function splitEscrow(work: string, weights: readonly number[] = [5000, 5000]) {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    h.watched.push(owner);
    const escrow = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: owner, min_result: "1", max_result: "1", spec_hash: "4b".repeat(32), send: true });
    const intent = escrow["intent"] as Address;
    const coauthors = await Promise.all(weights.map(() => generateKeyPairSigner()));
    const recipients = coauthors.map((c, i) => ({ wallet: c.address, weight: weights[i] }));
    const outsider = (await generateKeyPairSigner()).address;
    const announce = (signature: string, slot: bigint, by: Address) => ({
      signature,
      slot,
      blockTime: null,
      failed: false,
      emitted: [],
      memos: [deliveryMemo({ intent, sha256: work, url: "https://example.org/work" })],
      feePayer: by,
    });
    return { owner, intent, nonce: escrow["nonce"] as string, coauthors, recipients, outsider, announce };
  }

  it("attest split refuses a proof escrow without delivered_sha256", async () => {
    const work = "c1".repeat(32);
    const { owner, intent, nonce, recipients } = await splitEscrow(work);
    h.engineLog = [creation(intent)];
    expect((await call(client, "wallet_attest_split", { owner, nonce, recipients })).value).toMatchObject({
      code: "InvalidInput",
      issues: [{ path: "delivered_sha256", message: DELIVERED_NEEDED }],
    });
    expect((await call(client, "wallet_attest_split", { owner, nonce, recipients, delivered_sha256: "xyz" })).value).toMatchObject({
      code: "InvalidInput",
      issues: [{ path: "delivered_sha256" }],
    });
    expect(await ok(client, "wallet_attest_split", { owner, nonce, recipients, delivered_sha256: work.toUpperCase() })).toMatchObject({ delivered_sha256: work, sent: false });
    const junk = Array.from({ length: DELIVERY_SCAN }, (_, i) => ({ signature: `junk${i}`, slot: 20n, blockTime: null, failed: false, emitted: [] }));
    h.engineLog = [...junk, creation(intent)];
    expect((await call(client, "wallet_attest_split", { owner, nonce, recipients, delivered_sha256: work })).value).toMatchObject({ code: "HistoryTooLong", hint: HISTORY_TOO_LONG });
    h.engineLog = [];
    expect((await call(client, "wallet_attest_split", { owner, nonce, recipients, delivered_sha256: work })).value).toMatchObject({ code: "HistoryTooLong" });
  });

  it("attest split refuses when the earliest announcer is not a recipient", async () => {
    const work = "c2".repeat(32);
    const { owner, intent, nonce, recipients, coauthors, outsider, announce } = await splitEscrow(work);
    const [first, second] = coauthors;
    if (first === undefined || second === undefined) {
      throw new Error("no co-authors");
    }
    h.engineLog = [announce("late", 9n, first.address), announce("early", 5n, outsider), creation(intent)];
    expect((await call(client, "wallet_attest_split", { owner, nonce, recipients, delivered_sha256: work })).value).toMatchObject({
      code: "NotEarliestAnnouncer",
      hint: notInSplit(outsider, work),
    });
    expect(await ok(client, "wallet_attest_split", { owner, nonce, recipients: [...recipients.slice(0, 1).map((r) => ({ ...r, weight: 4000 })), { wallet: outsider, weight: 6000 }], delivered_sha256: work })).toMatchObject({ sent: false });
    h.engineLog = [announce("late", 9n, outsider), announce("early", 5n, second.address), creation(intent)];
    expect(await ok(client, "wallet_attest_split", { owner, nonce, recipients, delivered_sha256: work })).toMatchObject({ delivered_sha256: work, sent: false });
    expect(await ok(client, "wallet_attest_split", { owner, nonce, recipients, delivered_sha256: "c3".repeat(32) })).toMatchObject({ sent: false });
  });

  it("attest split records the delivered sha256", async () => {
    const work = "c4".repeat(32);
    const { owner, intent, nonce, coauthors: [first], announce } = await splitEscrow(work);
    if (first === undefined) {
      throw new Error("no co-authors");
    }
    const coauthors = [first];
    const recipients = [{ wallet: first.address, weight: 10_000 }];
    h.engineLog = [announce("early", 5n, first.address), creation(intent)];
    const shown = await ok(client, "wallet_attest_split", { owner, nonce, recipients, delivered_sha256: work });
    expect(shown).toMatchObject({ delivered_sha256: work, sent: false });
    expect(shown["summary"]).toContain(RECORDS_SPLIT(work));
    const other = await ok(client, "wallet_attest_split", { owner, nonce, recipients, delivered_sha256: "c5".repeat(32) });
    expect(other["approval"]).not.toBe(shown["approval"]);
    expect(other["digest"]).toBe(shown["digest"]);
    const envelope = bytesOf(shown["envelope"] as string);
    const signed = await Promise.all(
      recipients.map(async (r, i) => ({ ...r, signature: getBase16Decoder().decode(new Uint8Array(await signBytes(coauthors[i]!.keyPair.privateKey, envelope))) })),
    );
    expect((await call(client, "wallet_attest_split", { owner, nonce, recipients: signed, delivered_sha256: "c5".repeat(32), approval: shown["approval"], send: true })).value).toMatchObject({ code: "ReleaseChanged" });
    h.wires.length = 0;
    expect(await ok(client, "wallet_attest_split", { owner, nonce, recipients: signed, delivered_sha256: work, approval: shown["approval"], send: true })).toMatchObject({
      delivered_sha256: work,
      recorded: "release",
      sent: true,
      signature: expect.any(String),
    });
    expect(h.wires.some((wire) => Buffer.from(wire, "base64").toString("latin1").includes(`${RELEASE_MEMO_PREFIX}${work}`))).toBe(true);
    for (const c of coauthors) {
      expect(balance(await findAssociatedTokenAddress({ owner: c.address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS }))).toBeGreaterThan(0n);
    }
  });

  it("escrows a task's pieces in one plan: one preview with the total, one send, each piece released on its own", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    const other = (await generateKeyPairSigner()).address;
    const worker = (await generateKeyPairSigner()).address;
    const plan = {
      sell: "SOL",
      attestor: owner,
      pieces: [
        { name: "parser", amount: "0.01" },
        { name: "api client", amount: "0.02", attestor: other },
        { name: "page", amount: "0.01" },
      ],
    };
    h.watched.push(owner);
    const preview = await ok(client, "wallet_escrow_plan", plan);
    expect(preview).toMatchObject({
      total: "0.04",
      sent: false,
      next: PREVIEW_ONLY,
      pieces: [
        { name: "parser", amount: "0.01", attestor: owner },
        { name: "api client", amount: "0.02", attestor: other },
        { name: "page", amount: "0.01", attestor: owner },
      ],
      warnings: [WARN_ATTESTOR],
    });
    expect(preview["pieces"][0]).not.toHaveProperty("intent");
    expect(preview["summary"].slice(0, 4)).toEqual([
      "Plan: 3 pieces, 0.04 of SOL in all, each escrowed now and released on its own",
      `Piece 1: parser, 0.01 of SOL, released by ${owner}`,
      `Piece 2: api client, 0.02 of SOL, released by ${other}`,
      `Piece 3: page, 0.01 of SOL, released by ${owner}`,
    ]);
    expect((await ok(client, "wallet_intents"))["intents"]).toEqual([]);
    const sent = await ok(client, "wallet_escrow_plan", { ...plan, send: true });
    expect(sent).toMatchObject({ sent: true, total: "0.04", pieces: [0, 1, 2].map((i) => ({ nonce: String(i), signature: expect.any(String) })) });
    expect(sent["next"]).toContain("pieces are escrowed");
    const listed = ((await ok(client, "wallet_intents"))["intents"] as Json[]).sort((a, b) => Number(a["nonce"]) - Number(b["nonce"]));
    expect(listed.map((intent) => intent["order"])).toEqual([
      expect.objectContaining({ kind: "attested", amount_in: String(LAMPORTS_PER_SOL / 100n), attestor: owner }),
      expect.objectContaining({ kind: "attested", amount_in: String(LAMPORTS_PER_SOL / 50n), attestor: other }),
      expect.objectContaining({ kind: "attested", amount_in: String(LAMPORTS_PER_SOL / 100n), attestor: owner }),
    ]);
    const release = { owner, nonce: "0", pay_to: worker };
    const shown = await ok(client, "wallet_attest", release);
    expect(await ok(client, "wallet_attest", { ...release, approval: shown["approval"], send: true })).toMatchObject({ sent: true });
    expect((await call(client, "wallet_attest", { owner, nonce: "1", pay_to: worker })).value).toMatchObject({ code: "Unauthorized" });
    expect(await ok(client, "wallet_cancel", { nonce: "2", send: true })).toMatchObject({ sent: true });
    const left = ((await ok(client, "wallet_intents"))["intents"] as Json[]).sort((a, b) => Number(a["nonce"]) - Number(b["nonce"]));
    expect(left.map((intent) => [intent["nonce"], intent["status"]])).toEqual([
      ["0", "filled"],
      ["1", "open"],
    ]);
    expect((await call(client, "wallet_escrow_plan", { ...plan, pieces: [plan.pieces[0]] })).value).toMatchObject({ code: "InvalidInput" });
    expect((await call(client, "wallet_escrow_plan", { ...plan, pieces: [plan.pieces[0], { name: "bad", amount: "0.0000000001" }] })).value).toMatchObject({
      code: "InvalidInput",
      issues: [{ path: "pieces.1.amount" }],
    });
  });

  it("refuses a plan past the hourly limit before escrowing any of it, and reports how far a failed one got", async () => {
    client = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools", "--wallet-per-hour", "SOL=0.05"]);
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    h.watched.push(owner);
    const plan = { sell: "SOL", attestor: owner, pieces: [{ name: "a", amount: "0.02" }, { name: "b", amount: "0.02" }, { name: "c", amount: "0.02" }], send: true };
    expect((await call(client, "wallet_escrow_plan", plan)).value).toMatchObject({ code: "WalletHourLimit" });
    expect((await ok(client, "wallet_intents"))["intents"]).toEqual([]);
    const two = { ...plan, pieces: plan.pieces.slice(0, 2).map((piece) => ({ ...piece, amount: "0.01" })) };
    h.sendFails = { error: new BlockhashExpired("expired"), landed: false, after: 1 };
    const partly = await ok(client, "wallet_escrow_plan", two);
    expect(partly).toMatchObject({ sent: true, total: "0.02", next: piecesPartlySent(1, 2, "Failed: expired") });
    expect(partly["pieces"][0]).toHaveProperty("intent");
    expect(partly["pieces"][1]).not.toHaveProperty("intent");
    h.sendFails = { error: new Error("timed out"), landed: true, after: 1 };
    const unsure = await ok(client, "wallet_escrow_plan", two);
    expect(unsure).toMatchObject({ sent: true, next: piecesMayHaveLanded(1, 2, "Failed: timed out") });
    expect((await ok(client, "wallet_intents"))["intents"]).toHaveLength(3);
  });

  it("publishes a spec url with a proof escrow, lists it as a job and announces delivered work to its judge", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    h.watched.push(owner);
    h.engineLog = [];
    const judge = (await generateKeyPairSigner()).address;
    const specHash = "5c".repeat(32);
    const specUrl = "https://example.org/jobs/spec.md";
    const terms = { sell: "SOL", amount: "0.05", attestor: judge, min_result: "1", max_result: "1" };
    expect((await call(client, "wallet_escrow", { ...terms, spec_url: specUrl })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "spec_url" }] });
    expect((await call(client, "wallet_escrow", { ...terms, spec_hash: specHash, spec_url: "http://example.org/spec" })).value).toMatchObject({
      code: "InvalidInput",
      issues: [{ path: "spec_url" }],
    });
    h.wires.length = 0;
    const escrow = await ok(client, "wallet_escrow", { ...terms, spec_hash: specHash, spec_url: specUrl, send: true });
    expect(escrow["summary"]).toContain(`Publishes: the acceptance spec's url ${specUrl}, in a memo the owner signs`);
    expect(Buffer.from(h.wires[0] as string, "base64").toString("latin1")).toContain(specMemo(specUrl));
    const intent = escrow["intent"] as Address;
    const plain = await ok(client, "wallet_escrow", { ...terms, send: true });

    const job = { intent, owner, nonce: escrow["nonce"], attestor: judge, spec_hash: specHash, spec_url: null, sells: (LAMPORTS_PER_SOL / 20n).toString(), judge_fee: "0", input_mint: NATIVE_MINT };
    expect(await ok(client, "find_jobs", { attestor: judge })).toEqual({ jobs: [{ ...job, expires_at: expect.any(String) }] });
    const tag = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);
    const created = getIntentCreatedEventEncoder().encode({
      intent,
      owner,
      nonce: BigInt(escrow["nonce"] as string),
      kind: 4,
      inputMint: NATIVE_MINT,
      outputMint: TEST_TOKEN,
      receiver: owner,
      escrowed: LAMPORTS_PER_SOL / 20n,
      expiresAt: 0n,
      rentPayer: owner,
      flags: 0,
      bounty: 0,
      createFee: 0,
    });
    h.engineLog = [
      { signature: "noise", slot: 2n, blockTime: null, failed: false, emitted: [], memos: [specMemo("https://evil.example/spec")] },
      { signature: "create", slot: 1n, blockTime: null, failed: false, emitted: [tag(created)], memos: [specMemo(specUrl)] },
    ];
    expect((await ok(client, "find_jobs", { attestor: judge }))["jobs"]).toMatchObject([{ ...job, spec_url: specUrl }]);
    expect(await ok(client, "find_jobs", { attestor: owner })).toEqual({ jobs: [] });

    const work = "e7".repeat(32);
    const delivery = { intent, sha256: work.toUpperCase(), url: "https://example.org/work.tar" };
    const preview = await ok(client, "wallet_deliver", delivery);
    expect(preview).toEqual({
      intent,
      attestor: judge,
      sha256: work,
      url: delivery.url,
      summary: [
        `Announces: the work with sha256 ${work} at ${delivery.url}, for the proof escrow ${intent}`,
        `Notifies: its attestor ${judge}, with a transfer of 0 lamports from this wallet`,
        "Costs: the transaction fee; no tokens move",
      ],
      warnings: [],
      sent: false,
      next: PREVIEW_ONLY,
    });
    h.wires.length = 0;
    const sent = await ok(client, "wallet_deliver", { ...delivery, send: true });
    expect(sent).toMatchObject({ sent: true, signature: expect.any(String) });
    expect(Buffer.from(h.wires[0] as string, "base64").toString("latin1")).toContain(deliveryMemo({ intent, sha256: work, url: delivery.url }));
    expect((await call(client, "wallet_deliver", { ...delivery, url: "ftp://example.org/x" })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "url" }] });
    expect((await call(client, "wallet_deliver", { ...delivery, sha256: "xyz" })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "sha256" }] });
    expect((await call(client, "wallet_deliver", { ...delivery, intent: plain["intent"] })).value).toMatchObject({ code: "NotDeliverable" });
    expect((await call(client, "wallet_deliver", { ...delivery, intent: judge })).value).toMatchObject({ code: "NotDeliverable" });
  });

  it("lists the work announced to an escrow it judges with each hash's earliest announcer, and releases a hash only to that announcer", async () => {
    const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
    h.watched.push(wallet);
    h.engineLog = [];
    const specHash = "5c".repeat(32);
    const escrow = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: wallet, spec_hash: specHash, send: true });
    const intent = escrow["intent"] as Address;
    const nonce = escrow["nonce"] as string;
    const worker = (await generateKeyPairSigner()).address;
    const copier = (await generateKeyPairSigner()).address;
    const work = "e7".repeat(32);
    const own = "aa".repeat(32);
    const memo = (sha256: string, url: string) => [deliveryMemo({ intent, sha256, url })];
    const at = (signature: string, slot: bigint, memos: string[], feePayer: Address) => ({ signature, slot, blockTime: null, failed: false, emitted: [], memos, feePayer });
    h.engineLog = [
      at("copy", 9n, memo(work, "https://example.org/stolen"), copier),
      at("own", 7n, memo(own, "https://example.org/own"), copier),
      at("first", 5n, memo(work, "https://example.org/work"), worker),
      creation(intent),
    ];
    expect(await ok(client, "wallet_check_delivery", { intent })).toEqual({
      intent,
      owner: wallet,
      nonce,
      spec_hash: specHash,
      open: true,
      complete: true,
      deliveries: [
        { sha256: work, worker, url: "https://example.org/work", signature: "first", copies: 1 },
        { sha256: own, worker: copier, url: "https://example.org/own", signature: "own", copies: 0 },
      ],
    });
    const release = { owner: wallet, nonce, delivered_sha256: work };
    expect((await call(client, "wallet_attest", { ...release, pay_to: copier })).value).toMatchObject({ code: "NotEarliestAnnouncer", hint: notEarliest(worker, work) });
    expect(await ok(client, "wallet_attest", { ...release, pay_to: worker })).toMatchObject({ delivered_sha256: work, sent: false });
    expect(await ok(client, "wallet_attest", { ...release, pay_to: copier, delivered_sha256: "bb".repeat(32) })).toMatchObject({ sent: false });
    const foreign = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.01", attestor: worker, spec_hash: specHash, send: true });
    expect((await call(client, "wallet_check_delivery", { intent: foreign["intent"] })).value).toMatchObject({ code: "Unauthorized", hint: notAttestor(worker) });
    const plain = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.01", attestor: wallet, send: true });
    expect((await call(client, "wallet_check_delivery", { intent: plain["intent"] })).value).toMatchObject({ code: "NotAProof" });
    expect((await call(client, "wallet_check_delivery", { intent: worker })).value).toMatchObject({ code: "NotFound" });
  });

  it("attest refuses a proof escrow without delivered_sha256", async () => {
    const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
    h.watched.push(wallet);
    h.engineLog = [];
    const escrow = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: wallet, spec_hash: "5d".repeat(32), send: true });
    const intent = escrow["intent"] as Address;
    const worker = (await generateKeyPairSigner()).address;
    const work = "e8".repeat(32);
    h.engineLog = [creation(intent)];
    const release = { owner: wallet, nonce: escrow["nonce"] as string, pay_to: worker };
    expect((await call(client, "wallet_attest", release)).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "delivered_sha256", message: DELIVERED_NEEDED }] });
    expect(await ok(client, "wallet_attest", { ...release, delivered_sha256: work })).toMatchObject({ delivered_sha256: work, sent: false });

    const junk = Array.from({ length: DELIVERY_SCAN }, (_, i) => ({ signature: `junk${i}`, slot: 20n, blockTime: null, failed: false, emitted: [] }));
    h.engineLog = [...junk, { signature: "first", slot: 5n, blockTime: null, failed: false, emitted: [], memos: [deliveryMemo({ intent, sha256: work, url: "https://example.org/work" })], feePayer: worker }];
    expect((await call(client, "wallet_attest", { ...release, delivered_sha256: work })).value).toMatchObject({ code: "HistoryTooLong", hint: HISTORY_TOO_LONG });
    expect(await ok(client, "wallet_check_delivery", { intent })).toMatchObject({ complete: false });
    const plain = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.01", attestor: wallet, send: true });
    expect(await ok(client, "wallet_attest", { owner: wallet, nonce: plain["nonce"] as string, pay_to: worker })).toMatchObject({ sent: false });
  });

  it("shows an escrow's release and checks received work against the hash the release recorded", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    const [intent] = await findIntentPda({ owner, nonce: 7n });
    const payee = await findAssociatedTokenAddress({ owner: (await generateKeyPairSigner()).address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    h.engineLog = [];
    expect(await ok(client, "wallet_receipt", { nonce: "7" })).toEqual({ intent, released: false, complete: false, next: RELEASE_UNKNOWN });
    h.engineLog = [creation(intent)];
    expect(await ok(client, "wallet_receipt", { nonce: "7" })).toEqual({ intent, released: false, next: NOT_RELEASED });
    const tag = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);
    const { fee, net } = splitFee(LAMPORTS_PER_SOL / 20n, FEE_BPS);
    const attested = getIntentAttestedEventEncoder().encode({
      intent,
      owner,
      solver: owner,
      payee,
      attestor: owner,
      amountIn: LAMPORTS_PER_SOL / 20n,
      result: 2n,
      fee,
      net,
      filled: LAMPORTS_PER_SOL / 20n,
      remaining: 0n,
      partnerFee: 0n,
    });
    const work = "b".repeat(64);
    const released = { signature: "release", slot: 3n, blockTime: null, failed: false, emitted: [tag(attested)], memos: ["other note", `${RELEASE_MEMO_PREFIX}${work}`], memoSigners: [[], [owner]] };
    h.engineLog = [{ ...released, signature: "failed", failed: true }, released];
    expect(await ok(client, "wallet_receipt", { owner, nonce: "7", sha256: work.toUpperCase() })).toEqual({
      intent,
      released: true,
      payee,
      paid: `${net} raw units`,
      attestor: owner,
      result: "2",
      signature: "release",
      delivered_sha256: work,
      matches: true,
    });
    const created = getIntentCreatedEventEncoder().encode({
      intent,
      owner,
      nonce: 7n,
      kind: 4,
      inputMint: NATIVE_MINT,
      outputMint: TEST_TOKEN,
      receiver: owner,
      escrowed: LAMPORTS_PER_SOL / 20n,
      expiresAt: 0n,
      rentPayer: owner,
      flags: 0,
      bounty: 0,
      createFee: 0,
    });
    h.engineLog = [{ ...released, memos: [] }, { signature: "create", slot: 1n, blockTime: null, failed: false, emitted: [tag(created)] }];
    const plain = await ok(client, "wallet_receipt", { nonce: "7", sha256: work });
    expect(plain).toMatchObject({ paid: formatAmount(net, 9), matches: false });
    expect(plain).not.toHaveProperty("delivered_sha256");
    expect((await call(client, "wallet_receipt", { nonce: "7", sha256: "xyz" })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "sha256" }] });
  });

  it("receipt reads a follow-up delivery memo", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    const [intent] = await findIntentPda({ owner, nonce: 8n });
    const attestor = (await generateKeyPairSigner()).address;
    const impostor = (await generateKeyPairSigner()).address;
    const tag = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);
    const { fee, net } = splitFee(LAMPORTS_PER_SOL / 20n, FEE_BPS);
    const split = getIntentSplitEventEncoder().encode({
      intent,
      owner,
      solver: attestor,
      attestor,
      amountIn: LAMPORTS_PER_SOL / 20n,
      result: 1n,
      fee,
      net,
      partnerFee: 0n,
      recipients: 3,
      splitHash: new Uint8Array(32),
    });
    const work = "e1".repeat(32);
    const releaseSignature = "5".repeat(88);
    const otherRelease = "6".repeat(88);
    const release = { signature: releaseSignature, slot: 3n, blockTime: null, failed: false, emitted: [tag(split)], feePayer: attestor };
    const recording = (by: Address, sha256: string, of: string, signature: string) => ({
      signature,
      slot: 4n,
      blockTime: null,
      failed: false,
      emitted: [],
      memos: [followUpMemo(sha256, of)],
      feePayer: by,
    });
    h.engineLog = [recording(impostor, "e2".repeat(32), releaseSignature, "forged"), recording(attestor, "e3".repeat(32), otherRelease, "elsewhere"), release];
    const unrecorded = await ok(client, "wallet_receipt", { owner, nonce: "8", sha256: work });
    expect(unrecorded).toMatchObject({ released: true, signature: releaseSignature, recipients: "3", matches: false });
    expect(unrecorded).not.toHaveProperty("delivered_sha256");
    h.engineLog = [recording(attestor, work, releaseSignature, "follow-up"), ...h.engineLog];
    expect(await ok(client, "wallet_receipt", { owner, nonce: "8", sha256: work })).toEqual({
      intent,
      released: true,
      paid: `${net} raw units`,
      attestor,
      result: "1",
      recipients: "3",
      signature: releaseSignature,
      delivered_sha256: work,
      matches: true,
    });
    h.engineLog = [{ ...release, memos: [`${RELEASE_MEMO_PREFIX}${work}`], memoSigners: [[attestor]] }];
    expect(await ok(client, "wallet_receipt", { owner, nonce: "8" })).toMatchObject({ signature: releaseSignature, delivered_sha256: work });
    h.engineLog = [{ ...release, memos: [`${RELEASE_MEMO_PREFIX}${work}`], memoSigners: [[impostor]] }];
    expect(await ok(client, "wallet_receipt", { owner, nonce: "8" })).not.toHaveProperty("delivered_sha256");
  });

  it("a receipt is found after many later transactions", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    const [intent] = await findIntentPda({ owner, nonce: 9n });
    const payee = await findAssociatedTokenAddress({ owner: (await generateKeyPairSigner()).address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const tag = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);
    const { fee, net } = splitFee(LAMPORTS_PER_SOL / 20n, FEE_BPS);
    const attested = getIntentAttestedEventEncoder().encode({
      intent,
      owner,
      solver: owner,
      payee,
      attestor: owner,
      amountIn: LAMPORTS_PER_SOL / 20n,
      result: 1n,
      fee,
      net,
      filled: LAMPORTS_PER_SOL / 20n,
      remaining: 0n,
      partnerFee: 0n,
    });
    const work = "d7".repeat(32);
    const release = { signature: "release", slot: 3n, blockTime: null, failed: false, emitted: [tag(attested)], memos: [`${RELEASE_MEMO_PREFIX}${work}`], memoSigners: [[owner]] };
    const dust = (count: number) => Array.from({ length: count }, (_, i) => ({ signature: `dust${i}`, slot: 9n, blockTime: null, failed: false, emitted: [] }));
    const receipt = { intent, released: true, signature: "release", delivered_sha256: work, matches: true };
    h.engineLog = [...dust(WAIT_SCAN * 2), release];
    h.through = { ...transport, engineTransactions: async (limit) => h.engineLog.slice(0, limit) };
    const windowed = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    expect(await ok(windowed, "wallet_receipt", { nonce: "9", sha256: work })).toMatchObject(receipt);
    h.engineLog = [...dust(SIGNATURE_PAGE + 10), release];
    const listed = (tx: EngineTransaction): ListedSignature => ({ signature: tx.signature, slot: tx.slot, blockTime: tx.blockTime, failed: tx.failed, memo: null });
    h.through = {
      ...transport,
      engineTransactions: async (limit) => h.engineLog.slice(0, limit),
      signaturesOf: async (_, limit, before) => {
        const start = before === undefined ? 0 : h.engineLog.findIndex((tx) => tx.signature === before) + 1;
        return h.engineLog.slice(start, start + limit).map(listed);
      },
      transactionsOf: async (wanted) => wanted.flatMap((entry) => h.engineLog.filter((tx) => tx.signature === entry.signature)),
    };
    const paged = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    expect(await ok(paged, "wallet_receipt", { nonce: "9", sha256: work })).toMatchObject(receipt);
    const plain = await connect(["mcp", "--url", "devnet"]);
    expect(await ok(plain, "get_receipt", { owner, nonce: "9", sha256: work })).toMatchObject(receipt);
    h.through = null;
    h.engineLog = [];
  });

  type LogIndex = { all: EngineTransaction[]; positions: Map<string, number>; known: Map<string, EngineTransaction> };

  let indexBuilds = 0;

  const PAGED_ADDRESS = "11111111111111111111111111111111" as Address;

  const logIndex = (all: EngineTransaction[]): LogIndex => {
    indexBuilds++;
    return { all, positions: new Map(all.map((tx, i) => [tx.signature, i])), known: new Map(all.map((tx) => [tx.signature, tx])) };
  };

  function pagedThrough(log: () => EngineTransaction[], fetched: string[]) {
    const listed = (tx: EngineTransaction): ListedSignature => ({
      signature: tx.signature,
      slot: tx.slot,
      blockTime: tx.blockTime,
      failed: tx.failed,
      memo: tx.memos === undefined ? null : tx.memos.map((text) => `[${text.length}] ${text}`).join("; "),
    });
    const indexed = new WeakMap<EngineTransaction[], LogIndex>();
    const indexOf = () => {
      const all = log();
      const seen = indexed.get(all);
      if (seen !== undefined) {
        return seen;
      }
      const made = logIndex(all);
      indexed.set(all, made);
      return made;
    };
    return {
      ...transport,
      engineTransactions: async (limit: number) => log().slice(0, limit),
      signaturesOf: async (_: Address, limit: number, before?: string) => {
        const { all, positions } = indexOf();
        const start = before === undefined ? 0 : (positions.get(before) ?? -1) + 1;
        return all.slice(start, start + limit).map(listed);
      },
      transactionsOf: async (wanted: readonly ListedSignature[]) => {
        const { known } = indexOf();
        fetched.push(...wanted.map((entry) => entry.signature));
        return wanted.flatMap((entry) => known.get(entry.signature) ?? []);
      },
      transactionOf: async (signature: string) => {
        fetched.push(signature);
        return indexOf().known.get(signature) ?? null;
      },
    } satisfies Transport;
  }

  it("the fake rpc pages ten thousand entries quickly", async () => {
    let log = zeroTransfers(10_000);
    const fetched: string[] = [];
    const paged = pagedThrough(() => log, fetched);
    const builds = indexBuilds;
    const listed: string[] = [];
    let before: string | undefined;
    for (let page = 0; page < 10; page++) {
      const entries = await paged.signaturesOf(PAGED_ADDRESS, SIGNATURE_PAGE, before);
      expect(entries).toHaveLength(SIGNATURE_PAGE);
      listed.push(...entries.map((entry) => entry.signature));
      expect((await paged.transactionsOf(entries)).map((tx) => tx.signature)).toEqual(entries.map((entry) => entry.signature));
      before = entries.at(-1)?.signature;
    }
    expect(listed).toEqual(log.map((tx) => tx.signature));
    expect(fetched).toEqual(listed);
    expect(await paged.signaturesOf(PAGED_ADDRESS, SIGNATURE_PAGE, before)).toEqual([]);
    expect(await paged.transactionOf("transfer9999")).toBe(log[9_999]);
    expect(await paged.transactionOf("missing")).toBeNull();
    expect(indexBuilds - builds).toBe(1);
    log = zeroTransfers(12_000);
    expect((await paged.signaturesOf(PAGED_ADDRESS, SIGNATURE_PAGE, "transfer10999")).map((entry) => entry.signature)).toEqual(
      Array.from({ length: SIGNATURE_PAGE }, (_, i) => `transfer${11_000 + i}`),
    );
    expect(await paged.transactionOf("transfer11999")).toBe(log[11_999]);
    expect(indexBuilds - builds).toBe(2);
  });

  const zeroTransfers = (count: number, from = 0) =>
    Array.from({ length: count }, (_, i) => ({ signature: `transfer${from + i}`, slot: 9n, blockTime: null, failed: false, emitted: [] }) as EngineTransaction);

  it("a receipt is found quickly after many zero lamport transfers to the escrow", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    const [intent] = await findIntentPda({ owner, nonce: 11n });
    const payee = await findAssociatedTokenAddress({ owner: (await generateKeyPairSigner()).address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const tag = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);
    const { fee, net } = splitFee(LAMPORTS_PER_SOL / 20n, FEE_BPS);
    const attested = getIntentAttestedEventEncoder().encode({
      intent,
      owner,
      solver: owner,
      payee,
      attestor: owner,
      amountIn: LAMPORTS_PER_SOL / 20n,
      result: 1n,
      fee,
      net,
      filled: LAMPORTS_PER_SOL / 20n,
      remaining: 0n,
      partnerFee: 0n,
    });
    const work = "d8".repeat(32);
    const flood = HISTORY_PAGES * SIGNATURE_PAGE + 2_000;
    const release = { signature: "7".repeat(88), slot: 3n, blockTime: null, failed: false, emitted: [tag(attested)], memos: [releaseMemo(work)], memoSigners: [[owner]], feePayer: owner };
    const fetched: string[] = [];
    let log: EngineTransaction[] = [...zeroTransfers(flood), release];
    h.through = pagedThrough(() => log, fetched);
    const paged = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    const receipt = { intent, released: true, signature: release.signature, delivered_sha256: work, matches: true };
    expect(await ok(paged, "wallet_receipt", { nonce: "11", sha256: work })).toMatchObject(receipt);
    expect(fetched).toEqual([release.signature]);

    const followUp = { signature: "follow", slot: 4n, blockTime: null, failed: false, emitted: [], memos: [followUpMemo(work, release.signature)], feePayer: owner };
    const forged = { ...followUp, signature: "forged", memos: [followUpMemo("d9".repeat(32), release.signature)], feePayer: payee };
    log = [...zeroTransfers(flood), forged, followUp, ...zeroTransfers(flood, flood), { ...release, memos: [], memoSigners: [] }];
    fetched.length = 0;
    expect(await ok(paged, "get_receipt", { owner, nonce: "11", sha256: work })).toMatchObject(receipt);
    expect(fetched.sort()).toEqual(["follow", "forged", release.signature].sort());
    h.through = null;
    h.engineLog = [];
  });

  it("a receipt that hits the page cap says it is incomplete", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    const [intent] = await findIntentPda({ owner, nonce: 12n });
    const tag = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);
    const { fee, net } = splitFee(LAMPORTS_PER_SOL / 20n, FEE_BPS);
    const attested = getIntentAttestedEventEncoder().encode({
      intent,
      owner,
      solver: owner,
      payee: owner,
      attestor: owner,
      amountIn: LAMPORTS_PER_SOL / 20n,
      result: 1n,
      fee,
      net,
      filled: LAMPORTS_PER_SOL / 20n,
      remaining: 0n,
      partnerFee: 0n,
    });
    const plain = { signature: "8".repeat(88), slot: 3n, blockTime: null, failed: false, emitted: [tag(attested)], feePayer: owner };
    const fetched: string[] = [];
    let log: EngineTransaction[] = [...zeroTransfers(HISTORY_PAGES * SIGNATURE_PAGE), plain];
    h.through = pagedThrough(() => log, fetched);
    const paged = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    expect(await ok(paged, "wallet_receipt", { nonce: "12" })).toEqual({ intent, released: false, complete: false, next: RELEASE_UNKNOWN });
    expect(fetched).toHaveLength(HISTORY_PAGES * SIGNATURE_PAGE);
    expect((await call(paged, "wallet_record_delivery", { owner, nonce: "12", sha256: "da".repeat(32) })).value).toMatchObject({ code: "HistoryTooLong", hint: RELEASE_UNKNOWN });
    log = [...zeroTransfers(HISTORY_PAGES * SIGNATURE_PAGE - 1), plain];
    expect(await ok(paged, "wallet_receipt", { nonce: "12" })).toMatchObject({ intent, released: true, signature: plain.signature });
    log = zeroTransfers(10);
    expect(await ok(paged, "wallet_receipt", { nonce: "12" })).toEqual({ intent, released: false, complete: false, next: RELEASE_UNKNOWN });
    log = [...zeroTransfers(10), creation(intent)];
    expect(await ok(paged, "wallet_receipt", { nonce: "12" })).toEqual({ intent, released: false, next: NOT_RELEASED });
    h.through = null;
    h.engineLog = [];
  });

  function markFilled(intent: Address, status: number = IntentStatus.Filled) {
    const held = h.svm.getAccount(intent);
    if (!held.exists) {
      throw new Error("the escrow was not created");
    }
    h.svm.setAccount({ ...held, data: Uint8Array.from(getIntentEncoder().encode({ ...getIntentDecoder().decode(held.data), status })) });
  }

  async function releasedEscrow(nonceHint: string) {
    const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
    h.engineLog = [];
    const escrow = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: wallet, min_result: "1", max_result: "1", spec_hash: nonceHint.repeat(32), send: true });
    const intent = escrow["intent"] as Address;
    markFilled(intent);
    const owner = wallet;
    const tag = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);
    const { fee, net } = splitFee(LAMPORTS_PER_SOL / 20n, FEE_BPS);
    const splitBy = (attestor: Address, recipients: number) =>
      tag(
        getIntentSplitEventEncoder().encode({
          intent,
          owner,
          solver: attestor,
          attestor,
          amountIn: LAMPORTS_PER_SOL / 20n,
          result: 1n,
          fee,
          net,
          partnerFee: 0n,
          recipients,
          splitHash: new Uint8Array(32),
        }),
      );
    const attestedTo = (payee: Address) =>
      tag(
        getIntentAttestedEventEncoder().encode({
          intent,
          owner,
          solver: wallet,
          payee,
          attestor: wallet,
          amountIn: LAMPORTS_PER_SOL / 20n,
          result: 1n,
          fee,
          net,
          filled: LAMPORTS_PER_SOL / 20n,
          remaining: 0n,
          partnerFee: 0n,
        }),
      );
    const splitCall = (recipients: Address[]) =>
      Uint8Array.from(
        getFillAttestedSplitInstructionDataEncoder().encode({
          amountIn: LAMPORTS_PER_SOL / 20n,
          result: 1n,
          maxFeeBps: FEE_BPS,
          claim: { recipients, weights: recipients.map(() => 10_000 / recipients.length) },
          ext: new Uint8Array(),
        }),
      );
    const announce = (signature: string, slot: bigint, by: Address, sha256: string) => ({
      signature,
      slot,
      blockTime: null,
      failed: false,
      emitted: [],
      memos: [deliveryMemo({ intent, sha256, url: "https://example.org/work" })],
      feePayer: by,
    });
    const splitTo = (recipients: Address[], target: Address = intent) => ({ called: [splitCall(recipients)], calledAccounts: [[wallet, wallet, target]] });
    return { wallet, owner, intent, nonce: escrow["nonce"] as string, splitBy, attestedTo, splitCall, splitTo, announce };
  }

  it("record delivery sends the follow up memo for an existing release", async () => {
    const { wallet, owner, intent, nonce, splitBy, splitTo, announce } = await releasedEscrow("4c");
    const worker = (await generateKeyPairSigner()).address;
    const other = (await generateKeyPairSigner()).address;
    const work = "a9".repeat(32);
    const releaseSignature = "4".repeat(88);
    const release = { signature: releaseSignature, slot: 3n, blockTime: null, failed: false, emitted: [splitBy(wallet, 2)], ...splitTo([other, worker]), feePayer: wallet };
    const announced = [announce("announced", 2n, worker, work), creation(intent)];
    const args = { owner, nonce, sha256: work.toUpperCase() };
    h.engineLog = [creation(intent)];
    expect((await call(client, "wallet_record_delivery", args)).value).toMatchObject({ code: "NotReleased", hint: notReleasedYet(intent) });
    const stranger = (await generateKeyPairSigner()).address;
    h.engineLog = [{ ...release, emitted: [splitBy(stranger, 2)] }];
    expect((await call(client, "wallet_record_delivery", args)).value).toMatchObject({ code: "Unauthorized", hint: releasedBy(stranger, wallet) });
    h.engineLog = [{ ...release, memos: [`${RELEASE_MEMO_PREFIX}${work}`], memoSigners: [[wallet]] }];
    expect((await call(client, "wallet_record_delivery", args)).value).toMatchObject({ code: "AlreadyRecorded", hint: alreadyRecorded(work) });
    h.engineLog = [release];
    expect((await call(client, "wallet_record_delivery", args)).value).toMatchObject({ code: "HistoryTooLong", hint: HISTORY_TOO_LONG });
    h.engineLog = [release, ...announced];
    const memo = followUpMemo(work, releaseSignature);
    const preview = await ok(client, "wallet_record_delivery", args);
    expect(preview).toMatchObject({ intent, release: releaseSignature, sha256: work, memo, sent: false, next: PREVIEW_ONLY });
    expect(preview).not.toHaveProperty("signature");
    h.wires.length = 0;
    const recorded = await ok(client, "wallet_record_delivery", { ...args, send: true });
    expect(recorded).toMatchObject({ intent, memo, sent: true, signature: expect.any(String) });
    expect(h.wires).toHaveLength(1);
    const landed = landedAs(h.wires[0] as string);
    expect(landed).toMatchObject({ signature: recorded["signature"], memos: [memo], feePayer: wallet });
    h.engineLog = [landed, release];
    expect(await ok(client, "wallet_receipt", { owner, nonce, sha256: work })).toMatchObject({ released: true, signature: releaseSignature, delivered_sha256: work, matches: true });
    expect((await call(client, "wallet_record_delivery", args)).value).toMatchObject({ code: "AlreadyRecorded" });

    const keypair = defaultWallet(HOME);
    const line = ["record-delivery", "--url", "devnet", "--keypair", keypair, "--owner", owner, "--nonce", nonce, "--sha256", work];
    h.engineLog = [release, ...announced];
    const shown = await cli(line, {});
    expect(shown.code).toBe(EXIT_OK);
    expect(shown.json()).toMatchObject({ intent, release: releaseSignature, sha256: work, memo, sent: false });
    h.wires.length = 0;
    const sentByCli = await cli([...line, "--yes"], {});
    expect(sentByCli.code).toBe(EXIT_OK);
    expect(sentByCli.json()).toMatchObject({ intent, memo, sent: true, signature: expect.any(String) });
    h.engineLog = [landed, release];
    const again = await cli(line, {});
    expect([again.code, again.err]).toEqual([1, alreadyRecorded(work)]);
    h.engineLog = [];
  });

  it("record delivery refuses a hash that was never announced", async () => {
    const { wallet, owner, intent, nonce, splitBy, splitTo, announce } = await releasedEscrow("4d");
    const worker = (await generateKeyPairSigner()).address;
    const work = "b1".repeat(32);
    const copied = "b2".repeat(32);
    const release = { signature: "3".repeat(88), slot: 3n, blockTime: null, failed: false, emitted: [splitBy(wallet, 1)], ...splitTo([worker]), feePayer: wallet };
    h.engineLog = [release, announce("announced", 2n, worker, work), creation(intent)];
    expect((await call(client, "wallet_record_delivery", { owner, nonce, sha256: copied })).value).toMatchObject({ code: "NotAnnounced", hint: neverAnnounced(copied, intent) });
    const line = ["record-delivery", "--url", "devnet", "--keypair", defaultWallet(HOME), "--owner", owner, "--nonce", nonce, "--sha256", copied];
    const refused = await cli(line, {});
    expect([refused.code, refused.err]).toEqual([1, neverAnnounced(copied, intent)]);
    expect(await ok(client, "wallet_record_delivery", { owner, nonce, sha256: work })).toMatchObject({ sha256: work, sent: false });
    h.svm.setAccount({ address: intent, data: new Uint8Array(), executable: false, lamports: lamports(0n), programAddress: "11111111111111111111111111111111" as Address, space: 0n });
    expect((await call(client, "wallet_record_delivery", { owner, nonce, sha256: work })).value).toMatchObject({ code: "HistoryTooLong", hint: creationUnread(intent, `create-${intent}`) });
    h.engineLog = [release, announce("announced", 2n, worker, work)];
    expect((await call(client, "wallet_record_delivery", { owner, nonce, sha256: work })).value).toMatchObject({ code: "HistoryTooLong", hint: escrowGone(intent) });
    h.engineLog = [];
  });

  it("record delivery refuses a hash whose earliest announcer is not the payee", async () => {
    const { wallet, owner, intent, nonce, splitBy, splitTo, attestedTo, announce } = await releasedEscrow("4e");
    const worker = (await generateKeyPairSigner()).address;
    const copier = (await generateKeyPairSigner()).address;
    const work = "b3".repeat(32);
    const payee = await findAssociatedTokenAddress({ owner: worker, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const attested = { signature: "2".repeat(88), slot: 3n, blockTime: null, failed: false, emitted: [attestedTo(payee)], feePayer: wallet };
    const copiedFirst = [announce("late", 2n, worker, work), announce("early", 1n, copier, work), creation(intent)];
    const workerFirst = [announce("late", 2n, copier, work), announce("early", 1n, worker, work), creation(intent)];
    h.engineLog = [attested, ...copiedFirst];
    expect((await call(client, "wallet_record_delivery", { owner, nonce, sha256: work })).value).toMatchObject({
      code: "NotEarliestAnnouncer",
      hint: paidOther(copier, work, payee),
    });
    h.engineLog = [attested, ...workerFirst];
    expect(await ok(client, "wallet_record_delivery", { owner, nonce, sha256: work })).toMatchObject({ sha256: work, sent: false });
    const split = { ...attested, emitted: [splitBy(wallet, 2)], ...splitTo([worker, wallet]) };
    h.engineLog = [split, ...copiedFirst];
    expect((await call(client, "wallet_record_delivery", { owner, nonce, sha256: work })).value).toMatchObject({
      code: "NotEarliestAnnouncer",
      hint: splitPaidOthers(copier, work),
    });
    h.engineLog = [split, ...workerFirst];
    expect(await ok(client, "wallet_record_delivery", { owner, nonce, sha256: work })).toMatchObject({ sha256: work, sent: false });
    h.engineLog = [{ ...split, called: [] }, ...workerFirst];
    expect((await call(client, "wallet_record_delivery", { owner, nonce, sha256: work })).value).toMatchObject({ code: "HistoryTooLong", hint: recipientsUnread(split.signature) });
    h.engineLog = [];
  });

  function createdFrom(intent: Address) {
    const held = h.svm.getAccount(intent);
    if (!held.exists) {
      throw new Error("the escrow was not created");
    }
    const escrow = getIntentDecoder().decode(held.data);
    const event = getIntentCreatedEventEncoder().encode({
      intent,
      owner: escrow.owner,
      nonce: escrow.nonce,
      kind: escrow.kind,
      inputMint: escrow.inputMint,
      outputMint: escrow.outputMint,
      receiver: escrow.owner,
      escrowed: escrow.escrowed,
      expiresAt: escrow.expiresAt,
      rentPayer: escrow.owner,
      flags: 0,
      bounty: 0,
      createFee: 0,
    });
    const args = { nonce: escrow.nonce, kind: escrow.kind, flags: 0, params: escrow.params, expiresAt: escrow.expiresAt, ext: new Uint8Array(), maxCreateFee: 0, maxBounty: 0 };
    return {
      signature: `made-${intent}`,
      slot: 1n,
      blockTime: null,
      failed: false,
      emitted: [new Uint8Array([...EVENT_IX_TAG, ...event])],
      called: [Uint8Array.from(getCreateIntentInstructionDataEncoder().encode({ args }))],
      calledAccounts: [[escrow.owner, escrow.owner, escrow.owner, intent]],
      feePayer: escrow.owner,
    } satisfies EngineTransaction;
  }

  const closeAccount = (address: Address) =>
    h.svm.setAccount({ address, data: new Uint8Array(), executable: false, lamports: lamports(0n), programAddress: "11111111111111111111111111111111" as Address, space: 0n });

  it("record delivery works after the escrow is closed", async () => {
    const { wallet, owner, intent, nonce, attestedTo, splitBy, splitTo, announce } = await releasedEscrow("4f");
    const worker = (await generateKeyPairSigner()).address;
    const work = "c4".repeat(32);
    const payee = await findAssociatedTokenAddress({ owner: worker, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const vault = (await generateKeyPairSigner()).address;
    const made = createdFrom(intent);
    closeAccount(intent);
    const release = {
      signature: "4".repeat(87) + "f",
      slot: 3n,
      blockTime: null,
      failed: false,
      emitted: [attestedTo(payee)],
      feePayer: wallet,
      tokens: [{ account: vault, mint: NATIVE_MINT, owner: intent }],
    } satisfies EngineTransaction;
    const announced = announce("announced", 2n, worker, work);
    h.engineLog = [release, announced, made];
    const memo = followUpMemo(work, release.signature);
    const args = { owner, nonce, sha256: work, release: release.signature };
    expect(await ok(client, "wallet_record_delivery", args)).toMatchObject({ intent, release: release.signature, sha256: work, memo, sent: false });
    expect(await ok(client, "wallet_record_delivery", { owner, nonce, sha256: work })).toMatchObject({ intent, release: release.signature, memo, sent: false });
    h.wires.length = 0;
    expect(await ok(client, "wallet_record_delivery", { ...args, send: true })).toMatchObject({ intent, memo, sent: true, signature: expect.any(String) });
    expect(landedAs(h.wires[0] as string)).toMatchObject({ memos: [memo], feePayer: wallet });
    const copier = (await generateKeyPairSigner()).address;
    h.engineLog = [release, announced, announce("early", 1n, copier, work), made];
    expect((await call(client, "wallet_record_delivery", args)).value).toMatchObject({ code: "NotEarliestAnnouncer", hint: paidOther(copier, work, payee) });
    h.engineLog = [release, made];
    expect((await call(client, "wallet_record_delivery", args)).value).toMatchObject({ code: "NotAnnounced", hint: neverAnnounced(work, intent) });
    h.engineLog = [release, announced];
    expect((await call(client, "wallet_record_delivery", args)).value).toMatchObject({ code: "HistoryTooLong", hint: escrowGone(intent) });
    h.engineLog = [release, announced, made];
    h.firstSlot = 2n;
    expect((await call(client, "wallet_record_delivery", args)).value).toMatchObject({ code: "HistoryTooLong", hint: HISTORY_TOO_LONG });
    h.firstSlot = 0n;
    const split = { ...release, emitted: [splitBy(wallet, 1)], ...splitTo([worker]) };
    h.engineLog = [split, announced, made];
    expect(await ok(client, "wallet_record_delivery", { ...args, release: split.signature })).toMatchObject({ release: split.signature, sha256: work, sent: false });
    const keypair = defaultWallet(HOME);
    const line = ["record-delivery", "--url", "devnet", "--keypair", keypair, "--owner", owner, "--nonce", nonce, "--sha256", work, "--release", split.signature];
    const shown = await cli(line, {});
    expect(shown.code).toBe(EXIT_OK);
    expect(shown.json()).toMatchObject({ intent, release: split.signature, memo: followUpMemo(work, split.signature), sent: false });
    const malformed = await cli([...line.slice(0, -1), "not-a-signature"], {});
    expect([malformed.code, malformed.err]).toEqual([EXIT_USAGE, RELEASE_NEEDED]);
    h.engineLog = [];
  });

  it("a receipt by release signature ignores any flood", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    const [intent] = await findIntentPda({ owner, nonce: 13n });
    const payee = await findAssociatedTokenAddress({ owner: (await generateKeyPairSigner()).address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const tag = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);
    const { fee, net } = splitFee(LAMPORTS_PER_SOL / 20n, FEE_BPS);
    const attested = getIntentAttestedEventEncoder().encode({
      intent,
      owner,
      solver: owner,
      payee,
      attestor: owner,
      amountIn: LAMPORTS_PER_SOL / 20n,
      result: 1n,
      fee,
      net,
      filled: LAMPORTS_PER_SOL / 20n,
      remaining: 0n,
      partnerFee: 0n,
    });
    const work = "d1".repeat(32);
    const release = { signature: "9".repeat(88), slot: 3n, blockTime: null, failed: false, emitted: [tag(attested)], feePayer: owner } satisfies EngineTransaction;
    const followUp = { signature: "8".repeat(87) + "f", slot: 4n, blockTime: null, failed: false, emitted: [], memos: [followUpMemo(work, release.signature)], feePayer: owner };
    const stray = { signature: "7".repeat(87) + "f", slot: 5n, blockTime: null, failed: false, emitted: [] };
    const flood = HISTORY_PAGES * SIGNATURE_PAGE + 2_000;
    const fetched: string[] = [];
    let log: EngineTransaction[] = [...zeroTransfers(flood), stray, release];
    h.through = pagedThrough(() => log, fetched);
    const paged = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    expect(await ok(paged, "wallet_receipt", { nonce: "13" })).toEqual({ intent, released: false, complete: false, next: RELEASE_UNKNOWN });
    fetched.length = 0;
    const receipt = { intent, released: true, attestor: owner, payee, signature: release.signature };
    expect(await ok(paged, "wallet_receipt", { nonce: "13", release: release.signature })).toMatchObject(receipt);
    expect(fetched).toEqual([release.signature]);
    log = [...zeroTransfers(flood), followUp, stray, ...zeroTransfers(flood, flood), release];
    fetched.length = 0;
    const plain = await connect(["mcp", "--url", "devnet"]);
    expect(await ok(plain, "get_receipt", { owner, nonce: "13", sha256: work, release: release.signature })).toMatchObject({ ...receipt, delivered_sha256: work, matches: true });
    expect(fetched.sort()).toEqual([followUp.signature, release.signature].sort());
    const shown = await cli(["receipt", "--url", "devnet", "--owner", owner, "--nonce", "13", "--sha256", work, "--release", release.signature], {});
    expect([shown.code, shown.err]).toEqual([EXIT_OK, ""]);
    expect(shown.json()).toMatchObject({ ...receipt, delivered_sha256: work, matches: true });
    expect((await call(paged, "wallet_receipt", { nonce: "13", release: stray.signature })).value).toMatchObject({ code: "NotARelease", hint: releaseNotOf(stray.signature, intent) });
    expect((await call(paged, "wallet_receipt", { nonce: "13", release: "6".repeat(88) })).value).toMatchObject({ code: "ReleaseUnread", hint: releaseUnread("6".repeat(88)) });
    expect((await call(paged, "wallet_receipt", { nonce: "13", release: "l0" })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "release" }] });
    h.through = null;
    h.engineLog = [];
  });

  it("an unread transaction makes the receipt incomplete", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    const [intent] = await findIntentPda({ owner, nonce: 14n });
    const lagging = { signature: "5".repeat(87) + "f", slot: 2n, blockTime: null, failed: false, emitted: [], unread: true as const };
    h.engineLog = [creation(intent)];
    expect(await ok(client, "wallet_receipt", { nonce: "14" })).toEqual({ intent, released: false, next: NOT_RELEASED });
    h.engineLog = [lagging, creation(intent)];
    expect(await ok(client, "wallet_receipt", { nonce: "14" })).toEqual({ intent, released: false, complete: false, next: RELEASE_UNKNOWN });
    expect((await call(client, "wallet_record_delivery", { owner, nonce: "14", sha256: "e2".repeat(32) })).value).toMatchObject({ code: "HistoryTooLong", hint: RELEASE_UNKNOWN });
    const fetched: string[] = [];
    h.through = pagedThrough(() => [lagging, creation(intent)], fetched);
    const paged = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    expect(await ok(paged, "wallet_receipt", { nonce: "14" })).toEqual({ intent, released: false, complete: false, next: RELEASE_UNKNOWN });
    expect((await call(paged, "wallet_receipt", { nonce: "14", release: lagging.signature })).value).toMatchObject({ code: "ReleaseUnread" });
    h.through = pagedThrough(() => [creation(intent)], fetched);
    const kept = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    expect(await ok(kept, "wallet_receipt", { nonce: "14" })).toEqual({ intent, released: false, next: NOT_RELEASED });
    h.through = pagedThrough(() => [], fetched);
    const empty = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    expect(await ok(empty, "wallet_receipt", { nonce: "14" })).toEqual({ intent, released: false, complete: false, next: RELEASE_UNKNOWN });
    h.through = null;
    h.engineLog = [];
  });

  it("split recipients come from the instruction for this escrow", async () => {
    const { wallet, owner, intent, nonce, splitBy, splitCall, announce } = await releasedEscrow("51");
    const worker = (await generateKeyPairSigner()).address;
    const copier = (await generateKeyPairSigner()).address;
    const elsewhere = (await generateKeyPairSigner()).address;
    const work = "f3".repeat(32);
    const keys = (target: Address) => [wallet, wallet, target];
    const base = { signature: "3".repeat(87) + "f", slot: 3n, blockTime: null, failed: false, feePayer: wallet };
    const both = { ...base, emitted: [splitBy(wallet, 1)], called: [splitCall([copier]), splitCall([worker])], calledAccounts: [keys(elsewhere), keys(intent)] };
    const args = { owner, nonce, sha256: work };
    h.engineLog = [both, announce("announced", 2n, worker, work), creation(intent)];
    expect(await ok(client, "wallet_record_delivery", args)).toMatchObject({ sha256: work, release: both.signature, sent: false });
    const swapped = { ...both, called: [splitCall([worker]), splitCall([copier])] };
    h.engineLog = [swapped, announce("announced", 2n, worker, work), creation(intent)];
    expect((await call(client, "wallet_record_delivery", args)).value).toMatchObject({ code: "NotEarliestAnnouncer", hint: splitPaidOthers(worker, work) });
    const throughProgram = { ...base, emitted: [splitCall([worker]), splitBy(wallet, 1)], emittedAccounts: [keys(intent), []], called: [new Uint8Array([9, 9])], calledAccounts: [[wallet]] };
    h.engineLog = [throughProgram, announce("announced", 2n, worker, work), creation(intent)];
    expect(await ok(client, "wallet_record_delivery", { ...args, release: throughProgram.signature })).toMatchObject({ sha256: work, sent: false });
    const foreign = { ...throughProgram, emittedAccounts: [keys(elsewhere), []] };
    h.engineLog = [foreign, announce("announced", 2n, worker, work), creation(intent)];
    expect((await call(client, "wallet_record_delivery", args)).value).toMatchObject({ code: "HistoryTooLong", hint: recipientsUnread(foreign.signature) });
    expect(recipientsUnread(foreign.signature)).toContain("ask its attestor which wallets the split paid");
    h.engineLog = [];
  });

  it("a receipt for a closed escrow shows whole tokens", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    const [intent] = await findIntentPda({ owner, nonce: 15n });
    const mint = (await generateKeyPairSigner()).address;
    preset(mint, 6);
    const attestor = (await generateKeyPairSigner()).address;
    const tag = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);
    const { fee, net } = splitFee(3_000_000n, FEE_BPS);
    const split = getIntentSplitEventEncoder().encode({
      intent,
      owner,
      solver: attestor,
      attestor,
      amountIn: 3_000_000n,
      result: 1n,
      fee,
      net,
      partnerFee: 0n,
      recipients: 2,
      splitHash: new Uint8Array(32),
    });
    const vault = (await generateKeyPairSigner()).address;
    const elsewhere = (await generateKeyPairSigner()).address;
    const work = "a7".repeat(32);
    const release = {
      signature: "2".repeat(87) + "f",
      slot: 3n,
      blockTime: null,
      failed: false,
      emitted: [tag(split)],
      memos: [releaseMemo(work)],
      memoSigners: [[attestor]],
      feePayer: attestor,
      tokens: [
        { account: elsewhere, mint: NATIVE_MINT, owner: elsewhere },
        { account: vault, mint, owner: intent },
      ],
    } satisfies EngineTransaction;
    h.engineLog = [{ ...release, tokens: [] }];
    expect(await ok(client, "wallet_receipt", { nonce: "15" })).toMatchObject({ released: true, paid: `${net} raw units` });
    h.engineLog = [release];
    expect(await ok(client, "wallet_receipt", { nonce: "15", sha256: work })).toEqual({
      intent,
      released: true,
      paid: formatAmount(net, 6),
      attestor,
      result: "1",
      recipients: "2",
      signature: release.signature,
      delivered_sha256: work,
      matches: true,
    });
    expect(await ok(client, "wallet_receipt", { nonce: "15", release: release.signature })).toMatchObject({ paid: formatAmount(net, 6) });
    const payee = (await generateKeyPairSigner()).address;
    const attested = getIntentAttestedEventEncoder().encode({
      intent,
      owner,
      solver: attestor,
      payee,
      attestor,
      amountIn: 3_000_000n,
      result: 1n,
      fee,
      net,
      filled: 3_000_000n,
      remaining: 0n,
      partnerFee: 0n,
    });
    h.engineLog = [{ ...release, emitted: [tag(attested)], tokens: [{ account: payee, mint, owner: owner }] }];
    expect(await ok(client, "wallet_receipt", { nonce: "15" })).toMatchObject({ payee, paid: formatAmount(net, 6) });
    h.engineLog = [];
  });

  function createdAtOfEscrow(intent: Address): bigint {
    const held = h.svm.getAccount(intent);
    if (!held.exists) {
      throw new Error("the escrow was not created");
    }
    return getIntentDecoder().decode(held.data).createdAt;
  }

  it("a release from an earlier lifecycle of the same address is refused", async () => {
    const { wallet, owner, intent, nonce, attestedTo } = await releasedEscrow("53");
    const payee = await findAssociatedTokenAddress({ owner: (await generateKeyPairSigner()).address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const first = createdFrom(intent);
    const earlier = { signature: "3".repeat(87) + "e", slot: 3n, blockTime: null, failed: false, emitted: [attestedTo(payee)], feePayer: wallet } satisfies EngineTransaction;
    const remade = { ...first, signature: "remade", slot: 5n };
    const args = { owner, nonce, release: earlier.signature };
    const refused = { code: "OtherLifecycle", hint: otherLifecycle(earlier.signature, intent) };
    h.engineLog = [earlier, first];
    expect(await ok(client, "wallet_receipt", args)).toMatchObject({ intent, released: true, payee, signature: earlier.signature });
    h.engineLog = [remade, earlier, first];
    expect((await call(client, "wallet_receipt", args)).value).toMatchObject(refused);
    expect(await ok(client, "wallet_receipt", { owner, nonce })).toEqual({ intent, released: false, next: NOT_RELEASED });
    const dated = { ...earlier, blockTime: createdAtOfEscrow(intent) - 1n };
    h.through = pagedThrough(() => [remade, dated, first], []);
    const paged = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    expect((await call(paged, "wallet_receipt", args)).value).toMatchObject(refused);
    markFilled(intent, IntentStatus.Open);
    h.through = pagedThrough(() => [remade, earlier, first], []);
    const reopened = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    expect((await call(reopened, "wallet_receipt", args)).value).toMatchObject(refused);
    h.through = null;
    closeAccount(intent);
    expect((await call(client, "wallet_receipt", args)).value).toMatchObject(refused);
    expect(await ok(client, "wallet_receipt", { owner, nonce })).toEqual({ intent, released: false, next: NOT_RELEASED });
    h.engineLog = [earlier, first];
    expect(await ok(client, "wallet_receipt", args)).toMatchObject({ intent, released: true, signature: earlier.signature });
    h.engineLog = [];
  });

  it("record delivery reads deliveries of the release lifecycle only", async () => {
    const { wallet, owner, intent, nonce, attestedTo, announce } = await releasedEscrow("54");
    markFilled(intent, IntentStatus.Open);
    const worker = (await generateKeyPairSigner()).address;
    const successor = (await generateKeyPairSigner()).address;
    const payee = await findAssociatedTokenAddress({ owner: worker, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const vault = (await generateKeyPairSigner()).address;
    const first = createdFrom(intent);
    const release = {
      signature: "4".repeat(87) + "e",
      slot: 3n,
      blockTime: null,
      failed: false,
      emitted: [attestedTo(payee)],
      feePayer: wallet,
      tokens: [{ account: vault, mint: NATIVE_MINT, owner: intent }],
    } satisfies EngineTransaction;
    const remade = { ...first, signature: "remade", slot: 5n };
    const own = "c7".repeat(32);
    const late = "c8".repeat(32);
    const current = "c9".repeat(32);
    h.engineLog = [announce("current", 6n, successor, current), remade, announce("late", 4n, worker, late), release, announce("own", 2n, worker, own), first];
    const args = { owner, nonce, release: release.signature };
    expect(await ok(client, "wallet_record_delivery", { ...args, sha256: own })).toMatchObject({ intent, release: release.signature, sha256: own, sent: false });
    expect((await call(client, "wallet_record_delivery", { ...args, sha256: late })).value).toMatchObject({ code: "NotAnnounced", hint: neverAnnounced(late, intent) });
    expect((await call(client, "wallet_record_delivery", { ...args, sha256: current })).value).toMatchObject({ code: "NotAnnounced", hint: neverAnnounced(current, intent) });
    expect((await call(client, "wallet_record_delivery", { owner, nonce, sha256: own })).value).toMatchObject({ code: "NotReleased", hint: notReleasedYet(intent) });
    closeAccount(intent);
    expect(await ok(client, "wallet_record_delivery", { ...args, sha256: own })).toMatchObject({ intent, release: release.signature, sha256: own, sent: false });
    expect((await call(client, "wallet_record_delivery", { ...args, sha256: current })).value).toMatchObject({ code: "NotAnnounced", hint: neverAnnounced(current, intent) });
    h.engineLog = [];
  });

  function attestedRelease(intent: Address, owner: Address, signature: string) {
    const { fee, net } = splitFee(LAMPORTS_PER_SOL / 20n, FEE_BPS);
    const attested = getIntentAttestedEventEncoder().encode({
      intent,
      owner,
      solver: owner,
      payee: owner,
      attestor: owner,
      amountIn: LAMPORTS_PER_SOL / 20n,
      result: 1n,
      fee,
      net,
      filled: LAMPORTS_PER_SOL / 20n,
      remaining: 0n,
      partnerFee: 0n,
    });
    return { signature, slot: 3n, blockTime: null, failed: false, emitted: [new Uint8Array([...EVENT_IX_TAG, ...attested])], feePayer: owner } satisfies EngineTransaction;
  }

  it("a follow up hidden past the page cap makes the receipt incomplete", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    const [intent] = await findIntentPda({ owner, nonce: 16n });
    const work = "e4".repeat(32);
    const other = "e5".repeat(32);
    const release = attestedRelease(intent, owner, "2".repeat(87) + "e");
    const followUp = { signature: "follow-up", slot: 4n, blockTime: null, failed: false, emitted: [], memos: [followUpMemo(work, release.signature)], feePayer: owner } satisfies EngineTransaction;
    let log: EngineTransaction[] = [...zeroTransfers(RELEASE_PAGES * SIGNATURE_PAGE), followUp, release];
    h.through = pagedThrough(() => log, []);
    const paged = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    const args = { nonce: "16", release: release.signature };
    const partial = await ok(paged, "wallet_receipt", { ...args, sha256: work });
    expect(partial).toMatchObject({ intent, released: true, complete: false, next: RECEIPT_PARTIAL, signature: release.signature, matches: false });
    expect(partial).not.toHaveProperty("delivered_sha256");
    const recording = { owner, nonce: "16", sha256: other, release: release.signature };
    expect((await call(paged, "wallet_record_delivery", recording)).value).toMatchObject({ code: "HistoryTooLong", hint: followUpsUnknown(release.signature) });
    log = [...zeroTransfers(RELEASE_PAGES * SIGNATURE_PAGE - 10), followUp, release];
    const whole = await ok(paged, "wallet_receipt", { ...args, sha256: work });
    expect(whole).toMatchObject({ intent, released: true, delivered_sha256: work, matches: true });
    expect(whole).not.toHaveProperty("complete");
    expect((await call(paged, "wallet_record_delivery", recording)).value).toMatchObject({ code: "AlreadyRecorded", hint: alreadyRecorded(work) });
    h.through = null;
    h.engineLog = [];
  });

  it("an unread follow up is not taken as nothing recorded", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    const [intent] = await findIntentPda({ owner, nonce: 17n });
    const work = "e6".repeat(32);
    const release = attestedRelease(intent, owner, "1".repeat(87) + "e");
    const memos = [followUpMemo(work, release.signature)];
    const lagging = { signature: "lagging-follow-up", slot: 4n, blockTime: null, failed: false, emitted: [], memos, unread: true as const } satisfies EngineTransaction;
    const answered = { signature: lagging.signature, slot: 4n, blockTime: null, failed: false, emitted: [], memos, feePayer: owner } satisfies EngineTransaction;
    const partial = { intent, released: true, complete: false, next: RECEIPT_PARTIAL, signature: release.signature };
    h.through = pagedThrough(() => [lagging, release], []);
    const paged = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    const named = await ok(paged, "wallet_receipt", { nonce: "17", release: release.signature });
    expect(named).toMatchObject(partial);
    expect(named).not.toHaveProperty("delivered_sha256");
    expect(await ok(paged, "wallet_receipt", { nonce: "17" })).toMatchObject(partial);
    const recording = { owner, nonce: "17", sha256: "e7".repeat(32), release: release.signature };
    expect((await call(paged, "wallet_record_delivery", recording)).value).toMatchObject({ code: "HistoryTooLong", hint: followUpsUnknown(release.signature) });
    h.through = pagedThrough(() => [answered, release], []);
    const read = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    const whole = await ok(read, "wallet_receipt", { nonce: "17", release: release.signature });
    expect(whole).toMatchObject({ intent, released: true, delivered_sha256: work });
    expect(whole).not.toHaveProperty("complete");
    h.through = null;
    h.engineLog = [lagging, release];
    expect(await ok(client, "wallet_receipt", { nonce: "17" })).toMatchObject(partial);
    expect((await call(client, "wallet_record_delivery", recording)).value).toMatchObject({ code: "HistoryTooLong", hint: followUpsUnknown(release.signature) });
    h.engineLog = [answered, release];
    expect(await ok(client, "wallet_receipt", { nonce: "17" })).toMatchObject({ released: true, delivered_sha256: work });
    h.engineLog = [];
  });

  function routedThrough(logs: ReadonlyMap<Address, EngineTransaction[]>, other: EngineTransaction[], fetched: string[]) {
    const listed = (tx: EngineTransaction): ListedSignature => ({
      signature: tx.signature,
      slot: tx.slot,
      blockTime: tx.blockTime,
      failed: tx.failed,
      memo: tx.memos === undefined ? null : tx.memos.map((text) => `[${text.length}] ${text}`).join("; "),
    });
    const known = new Map<string, EngineTransaction>();
    const positions = new Map<EngineTransaction[], Map<string, number>>();
    for (const log of [...logs.values(), other]) {
      positions.set(log, new Map(log.map((tx, i) => [tx.signature, i])));
      for (const tx of log) {
        known.set(tx.signature, tx);
      }
    }
    const logOf = (of?: Address) => (of === undefined ? other : (logs.get(of) ?? other));
    return {
      ...transport,
      engineTransactions: async (limit: number, of?: Address) => logOf(of).slice(0, limit),
      signaturesOf: async (of: Address, limit: number, before?: string) => {
        const log = logOf(of);
        const start = before === undefined ? 0 : (positions.get(log)?.get(before) ?? -1) + 1;
        return log.slice(start, start + limit).map(listed);
      },
      transactionsOf: async (wanted: readonly ListedSignature[]) => {
        fetched.push(...wanted.map((entry) => entry.signature));
        return wanted.flatMap((entry) => known.get(entry.signature) ?? []);
      },
      transactionOf: async (signature: string) => {
        fetched.push(signature);
        return known.get(signature) ?? null;
      },
    } satisfies Transport;
  }

  async function connectThrough(routed: Transport) {
    h.through = routed;
    return connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
  }

  const earlierTransfers = (count: number, from = 0) => zeroTransfers(count, from).map((tx) => ({ ...tx, slot: 2n }));

  const floodFetches = (fetched: readonly string[]) => fetched.filter((signature) => signature.startsWith("transfer")).length;

  it("a flood before the release does not make a named receipt fetch it", async () => {
    const { wallet, owner, intent, nonce, attestedTo } = await releasedEscrow("56");
    const payee = await findAssociatedTokenAddress({ owner: (await generateKeyPairSigner()).address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const work = "f6".repeat(32);
    const createdAt = createdAtOfEscrow(intent);
    const made = { ...createdFrom(intent), blockTime: createdAt };
    const release = {
      signature: "5".repeat(87) + "d",
      slot: 3n,
      blockTime: createdAt + 5n,
      failed: false,
      emitted: [attestedTo(payee)],
      memos: [releaseMemo(work)],
      memoSigners: [[wallet]],
      feePayer: wallet,
    } satisfies EngineTransaction;
    const flood = 4 * LIFECYCLE_FETCHES;
    const args = { owner, nonce, sha256: work, release: release.signature };
    const receipt = { intent, released: true, signature: release.signature, delivered_sha256: work, matches: true };
    const fetched: string[] = [];
    const before = [release, ...earlierTransfers(flood), made];
    const around = [...zeroTransfers(flood, flood), ...before];
    for (const log of [before, around]) {
      fetched.length = 0;
      const routed = await connectThrough(routedThrough(new Map(), log, fetched));
      const read = await ok(routed, "wallet_receipt", args);
      expect(read).toMatchObject(receipt);
      expect(read).not.toHaveProperty("complete");
      expect(floodFetches(fetched)).toBe(0);
      expect(fetched.length).toBeLessThanOrEqual(2);
    }
    closeAccount(intent);
    fetched.length = 0;
    const closed = await connectThrough(routedThrough(new Map(), around, fetched));
    expect(await ok(closed, "wallet_receipt", args)).toMatchObject(receipt);
    expect(fetched.length).toBeLessThanOrEqual(LIFECYCLE_FETCHES + 1);
    h.through = null;
    h.engineLog = [];
  });

  it("record delivery stays cheap with a flood before the release", async () => {
    const { wallet, owner, intent, nonce, attestedTo, announce } = await releasedEscrow("57");
    const worker = (await generateKeyPairSigner()).address;
    const payee = await findAssociatedTokenAddress({ owner: worker, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const vault = (await generateKeyPairSigner()).address;
    const work = "f7".repeat(32);
    const createdAt = createdAtOfEscrow(intent);
    const made = { ...createdFrom(intent), blockTime: createdAt };
    const release = {
      signature: "5".repeat(87) + "c",
      slot: 3n,
      blockTime: createdAt + 5n,
      failed: false,
      emitted: [attestedTo(payee)],
      feePayer: wallet,
      tokens: [{ account: vault, mint: NATIVE_MINT, owner: intent }],
    } satisfies EngineTransaction;
    const judged = [announce("announced", 2n, worker, work)];
    const args = { owner, nonce, sha256: work, release: release.signature };
    const recorded = { intent, release: release.signature, sha256: work, memo: followUpMemo(work, release.signature), sent: false };
    const flood = 4 * LIFECYCLE_FETCHES;
    const fetched: string[] = [];
    const routed = async (log: EngineTransaction[]) => {
      fetched.length = 0;
      return connectThrough(routedThrough(new Map([[wallet, judged]]), log, fetched));
    };
    const before = [release, ...earlierTransfers(flood), made];
    const around = [...zeroTransfers(flood, flood), ...before];
    for (const log of [before, around]) {
      expect(await ok(await routed(log), "wallet_record_delivery", args)).toMatchObject(recorded);
      expect(floodFetches(fetched)).toBe(0);
      expect(fetched.length).toBeLessThanOrEqual(3);
    }
    closeAccount(intent);
    const capped = await routed(around);
    expect((await call(capped, "wallet_record_delivery", args)).value).toMatchObject({ code: "HistoryTooLong", hint: followUpsUnknown(release.signature) });
    expect(fetched.length).toBeLessThanOrEqual(LIFECYCLE_FETCHES + 1);
    const short = [...zeroTransfers(flood, flood), release, ...earlierTransfers(LIFECYCLE_FETCHES - 10), made];
    expect(await ok(await routed(short), "wallet_record_delivery", args)).toMatchObject(recorded);
    expect(fetched.length).toBeLessThanOrEqual(LIFECYCLE_FETCHES + 2);
    h.through = null;
    h.engineLog = [];
  });

  it("attest takes max pages and passes a flooded judge", async () => {
    const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
    h.watched.push(wallet);
    h.engineLog = [];
    const escrow = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: wallet, spec_hash: "5b".repeat(32), send: true });
    const intent = escrow["intent"] as Address;
    const nonce = escrow["nonce"] as string;
    const worker = (await generateKeyPairSigner()).address;
    const other = (await generateKeyPairSigner()).address;
    const work = "f8".repeat(32);
    const announced = { signature: "first", slot: 5n, blockTime: null, failed: false, emitted: [], memos: [deliveryMemo({ intent, sha256: work, url: "https://example.org/work" })], feePayer: worker };
    const judged = [...zeroTransfers(DELIVERY_PAGES * SIGNATURE_PAGE + 10), announced];
    const fetched: string[] = [];
    const flooded = await connectThrough(routedThrough(new Map([[wallet, judged]]), [creation(intent)], fetched));
    const release = { owner: wallet, nonce, pay_to: worker, delivered_sha256: work };
    expect(await ok(flooded, "wallet_attest", release)).toMatchObject({ delivered_sha256: work, sent: false });
    expect(floodFetches(fetched)).toBe(0);
    expect(HISTORY_TOO_LONG).toContain("max_pages");
    const refused = { code: "HistoryTooLong", hint: HISTORY_TOO_LONG };
    expect((await call(flooded, "wallet_attest", { ...release, max_pages: 1 })).value).toMatchObject(refused);
    expect(await ok(flooded, "wallet_attest", { ...release, max_pages: DELIVERY_PAGES + 1 })).toMatchObject({ delivered_sha256: work, sent: false });
    expect((await call(flooded, "wallet_attest", { ...release, max_pages: 0 })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "max_pages" }] });
    expect((await call(flooded, "wallet_attest", { ...release, max_pages: MAX_ATTEST_PAGES + 1 })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "max_pages" }] });
    const split = { owner: wallet, nonce, recipients: [{ wallet: worker, weight: 5000 }, { wallet: other, weight: 5000 }], delivered_sha256: work };
    expect(await ok(flooded, "wallet_attest_split", split)).toMatchObject({ delivered_sha256: work, sent: false });
    expect((await call(flooded, "wallet_attest_split", { ...split, max_pages: 1 })).value).toMatchObject(refused);
    expect(await ok(flooded, "wallet_attest_split", { ...split, max_pages: DELIVERY_PAGES + 1 })).toMatchObject({ delivered_sha256: work, sent: false });
    expect(ATTEST_PAGES).toBeGreaterThanOrEqual(1_000);
    h.through = null;
    h.engineLog = [];
  });

  it("an unread transaction near the release asks to call again", async () => {
    const { wallet, owner, intent, nonce, attestedTo, announce } = await releasedEscrow("58");
    const worker = (await generateKeyPairSigner()).address;
    const payee = await findAssociatedTokenAddress({ owner: worker, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const vault = (await generateKeyPairSigner()).address;
    const work = "f9".repeat(32);
    const made = createdFrom(intent);
    closeAccount(intent);
    const release = {
      signature: "5".repeat(87) + "b",
      slot: 3n,
      blockTime: null,
      failed: false,
      emitted: [attestedTo(payee)],
      feePayer: wallet,
      tokens: [{ account: vault, mint: NATIVE_MINT, owner: intent }],
    } satisfies EngineTransaction;
    const lagging = { signature: "lagging-near-release", slot: 2n, blockTime: null, failed: false, emitted: [], unread: true as const } satisfies EngineTransaction;
    const answered = { signature: lagging.signature, slot: 2n, blockTime: null, failed: false, emitted: [] } satisfies EngineTransaction;
    const announced = announce("announced", 2n, worker, work);
    const args = { owner, nonce, sha256: work, release: release.signature };
    h.through = pagedThrough(() => [release, lagging, announced, made], []);
    const lagged = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    const refused = (await call(lagged, "wallet_record_delivery", args)).value;
    expect(refused).toMatchObject({ code: "HistoryLagging", retryable: true, hint: historyLagging(release.signature, intent) });
    expect(historyLagging(release.signature, intent)).toContain("the node has not returned every transaction yet; call again");
    expect(refused).not.toMatchObject({ hint: escrowGone(intent) });
    expect(await ok(lagged, "wallet_receipt", { owner, nonce, release: release.signature })).toMatchObject({ released: true, complete: false });
    h.through = pagedThrough(() => [release, answered, announced, made], []);
    const read = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    expect(await ok(read, "wallet_record_delivery", args)).toMatchObject({ intent, release: release.signature, sha256: work, sent: false });
    h.through = pagedThrough(() => [release, answered, announced], []);
    const gone = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    expect((await call(gone, "wallet_record_delivery", args)).value).toMatchObject({ code: "HistoryTooLong", hint: escrowGone(intent) });
    h.through = null;
    h.engineLog = [];
  });

  function tokenAccountAt(address: Address, holder: Address) {
    const space = BigInt(getTokenSize());
    h.svm.setAccount({
      address,
      data: Uint8Array.from(
        getTokenEncoder().encode({
          mint: NATIVE_MINT,
          owner: holder,
          amount: 0n,
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
  }

  it("the earliest announcer check uses the owner at release time", async () => {
    const { wallet, owner, intent, nonce, attestedTo, announce } = await releasedEscrow("55");
    const worker = (await generateKeyPairSigner()).address;
    const buyer = (await generateKeyPairSigner()).address;
    const payee = (await generateKeyPairSigner()).address;
    const work = "d4".repeat(32);
    tokenAccountAt(payee, buyer);
    const release = (tokens: NonNullable<EngineTransaction["tokens"]>) =>
      ({ signature: "6".repeat(87) + "e", slot: 3n, blockTime: null, failed: false, emitted: [attestedTo(payee)], feePayer: wallet, tokens }) satisfies EngineTransaction;
    const announced = [announce("announced", 2n, worker, work), createdFrom(intent)];
    const args = { owner, nonce, sha256: work };
    h.engineLog = [release([{ account: payee, mint: NATIVE_MINT, owner: worker }]), ...announced];
    expect(await ok(client, "wallet_record_delivery", args)).toMatchObject({ intent, sha256: work, sent: false });
    expect(await ok(client, "wallet_receipt", { owner, nonce })).toMatchObject({ payee, paid_to: worker });
    const refused = { code: "NotEarliestAnnouncer", hint: paidOther(worker, work, payee) };
    h.engineLog = [release([{ account: payee, mint: NATIVE_MINT, owner: buyer }]), ...announced];
    expect((await call(client, "wallet_record_delivery", args)).value).toMatchObject(refused);
    h.engineLog = [release([]), ...announced];
    expect((await call(client, "wallet_record_delivery", args)).value).toMatchObject(refused);
    tokenAccountAt(payee, worker);
    expect(await ok(client, "wallet_record_delivery", args)).toMatchObject({ intent, sha256: work, sent: false });
    h.engineLog = [];
  });

  it("wait finds the fill after a flood", async () => {
    const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
    h.engineLog = [];
    const escrow = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: wallet, min_result: "1", max_result: "1", spec_hash: "5d".repeat(32), send: true });
    const intent = escrow["intent"] as Address;
    markFilled(intent);
    const tag = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);
    const { fee, net } = splitFee(LAMPORTS_PER_SOL / 20n, FEE_BPS);
    const payee = await findAssociatedTokenAddress({ owner: (await generateKeyPairSigner()).address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const attested = getIntentAttestedEventEncoder().encode({
      intent,
      owner: wallet,
      solver: wallet,
      payee,
      attestor: wallet,
      amountIn: LAMPORTS_PER_SOL / 20n,
      result: 1n,
      fee,
      net,
      filled: LAMPORTS_PER_SOL / 20n,
      remaining: 0n,
      partnerFee: 0n,
    });
    const work = "b6".repeat(32);
    const vault = (await generateKeyPairSigner()).address;
    const release = {
      signature: "6".repeat(87) + "f",
      slot: 3n,
      blockTime: null,
      failed: false,
      emitted: [tag(attested)],
      memos: [releaseMemo(work)],
      memoSigners: [[wallet]],
      feePayer: wallet,
      tokens: [{ account: vault, mint: NATIVE_MINT, owner: intent }],
    } satisfies EngineTransaction;
    const flood = HISTORY_PAGES * SIGNATURE_PAGE + 2_000;
    const fetched: string[] = [];
    let log: EngineTransaction[] = [...zeroTransfers(flood), release, creation(intent)];
    h.through = pagedThrough(() => log, fetched);
    const paged = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    expect(await ok(paged, "wallet_wait", { nonce: escrow["nonce"] })).toEqual({
      intent,
      status: "filled",
      waited: 0,
      paid_out: formatAmount(net, 9),
      token: "SOL",
      signature: release.signature,
    });
    expect(fetched).toEqual([release.signature]);
    closeAccount(intent);
    fetched.length = 0;
    expect(await ok(paged, "wallet_wait", { nonce: escrow["nonce"] })).toEqual({ intent, status: "closed", waited: 0, next: FILL_UNKNOWN });
    expect(fetched).toEqual([release.signature]);
    log = [...zeroTransfers(flood), { ...release, memos: [], memoSigners: [] }, creation(intent)];
    expect(await ok(paged, "wallet_wait", { nonce: escrow["nonce"] })).toEqual({ intent, status: "closed", waited: 0, next: FILL_UNKNOWN });
    h.through = null;
    h.engineLog = [];
  });

  it("wait reports the payout of an owned escrow as paid out", async () => {
    const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
    h.engineLog = [];
    const escrow = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: wallet, min_result: "1", max_result: "1", spec_hash: "5e".repeat(32), send: true });
    const intent = escrow["intent"] as Address;
    const tag = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);
    const { fee, net } = splitFee(LAMPORTS_PER_SOL / 20n, FEE_BPS);
    const worker = (await generateKeyPairSigner()).address;
    const payee = await findAssociatedTokenAddress({ owner: worker, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const attested = getIntentAttestedEventEncoder().encode({
      intent,
      owner: wallet,
      solver: wallet,
      payee,
      attestor: wallet,
      amountIn: LAMPORTS_PER_SOL / 20n,
      result: 1n,
      fee,
      net,
      filled: LAMPORTS_PER_SOL / 20n,
      remaining: 0n,
      partnerFee: 0n,
    });
    const vault = (await generateKeyPairSigner()).address;
    const release = {
      signature: "5".repeat(87) + "e",
      slot: 3n,
      blockTime: null,
      failed: false,
      emitted: [tag(attested)],
      feePayer: wallet,
      tokens: [{ account: vault, mint: NATIVE_MINT, owner: intent }],
    } satisfies EngineTransaction;
    const made = createdFrom(intent);
    markFilled(intent);
    h.engineLog = [release, made];
    const paid = { intent, status: "filled", waited: 0, paid_out: formatAmount(net, 9), token: "SOL", signature: release.signature };
    const shown = await ok(client, "wallet_wait", { nonce: escrow["nonce"] });
    expect(shown).toEqual(paid);
    expect(shown).not.toHaveProperty("received");
    closeAccount(intent);
    expect(await ok(client, "wallet_wait", { nonce: escrow["nonce"] })).toEqual({ ...paid, status: "filled" });
    const later = { ...made, signature: "remade", slot: 5n };
    h.engineLog = [later, release, made];
    expect(await ok(client, "wallet_wait", { nonce: escrow["nonce"] })).toEqual({ intent, status: "closed", waited: 0 });
    const marked = { ...release, memos: [releaseMemo("5f".repeat(32))], memoSigners: [[wallet]] };
    let log: EngineTransaction[] = [marked, made];
    h.through = pagedThrough(() => log, []);
    const paged = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    expect(await ok(paged, "wallet_wait", { nonce: escrow["nonce"] })).toEqual({ ...paid, signature: marked.signature });
    log = [later, marked, made];
    expect(await ok(paged, "wallet_wait", { nonce: escrow["nonce"] })).toEqual({ intent, status: "closed", waited: 0 });
    h.through = null;
    h.engineLog = [];
  });

  it("plain mode checks a delivery", async () => {
    const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
    h.watched.push(wallet);
    h.engineLog = [];
    const judge = (await generateKeyPairSigner()).address;
    const specHash = "5c".repeat(32);
    const escrow = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: judge, spec_hash: specHash, send: true });
    const unproven = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.01", attestor: judge, send: true });
    const intent = escrow["intent"] as Address;
    const plain = await connect(["mcp", "--url", "devnet"]);
    const { tools } = await plain.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(["solive_check_delivery", "solive_get_receipt", "solive_prepare_deliver"]));
    expect(tools.map((t) => t.name)).not.toContain("solive_wallet_check_delivery");
    const worker = (await generateKeyPairSigner()).address;
    const copier = (await generateKeyPairSigner()).address;
    const work = "e7".repeat(32);
    const at = (signature: string, slot: bigint, url: string, feePayer: Address) => ({
      signature,
      slot,
      blockTime: null,
      failed: false,
      emitted: [],
      memos: [deliveryMemo({ intent, sha256: work, url })],
      feePayer,
    });
    h.engineLog = [at("copy", 9n, "https://example.org/stolen", copier), at("first", 5n, "https://example.org/work", worker), creation(intent)];
    const listed = {
      intent,
      owner: wallet,
      nonce: escrow["nonce"],
      spec_hash: specHash,
      open: true,
      complete: true,
      deliveries: [{ sha256: work, worker, url: "https://example.org/work", signature: "first", copies: 1 }],
    };
    expect(await ok(plain, "check_delivery", { intent })).toEqual(listed);
    expect((await call(plain, "check_delivery", { intent: unproven["intent"] })).value).toMatchObject({ code: "NotAProof" });
    expect((await call(plain, "check_delivery", { intent: worker })).value).toMatchObject({ code: "NotFound" });
    expect((await call(client, "wallet_check_delivery", { intent })).value).toMatchObject({ code: "Unauthorized", hint: notAttestor(judge) });
    h.engineLog = [];
  });

  it("plain mode reads a receipt", async () => {
    const plain = await connect(["mcp", "--url", "devnet"]);
    const owner = (await generateKeyPairSigner()).address;
    const [intent] = await findIntentPda({ owner, nonce: 7n });
    const payee = await findAssociatedTokenAddress({ owner: (await generateKeyPairSigner()).address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    h.engineLog = [creation(intent)];
    expect(await ok(plain, "get_receipt", { owner, nonce: "7" })).toEqual({ intent, released: false, next: NOT_RELEASED });
    expect((await call(plain, "get_receipt", { nonce: "7" })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "owner" }] });
    const tag = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);
    const { fee, net } = splitFee(LAMPORTS_PER_SOL / 20n, FEE_BPS);
    const attested = getIntentAttestedEventEncoder().encode({
      intent,
      owner,
      solver: owner,
      payee,
      attestor: owner,
      amountIn: LAMPORTS_PER_SOL / 20n,
      result: 1n,
      fee,
      net,
      filled: LAMPORTS_PER_SOL / 20n,
      remaining: 0n,
      partnerFee: 0n,
    });
    const work = "c".repeat(64);
    h.engineLog = [{ signature: "release", slot: 3n, blockTime: null, failed: false, emitted: [tag(attested)], memos: [`${RELEASE_MEMO_PREFIX}${work}`], memoSigners: [[owner]] }];
    const receipt = { intent, released: true, payee, paid: `${net} raw units`, attestor: owner, result: "1", signature: "release", delivered_sha256: work, matches: true };
    expect(await ok(plain, "get_receipt", { owner, nonce: "7", sha256: work })).toEqual(receipt);
    await ok(client, "wallet_setup");
    expect(await ok(client, "wallet_receipt", { owner, nonce: "7", sha256: work })).toEqual(receipt);
    h.engineLog = [];
  });

  it("prepare deliver returns an unsigned delivery", async () => {
    const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
    h.watched.push(wallet);
    h.engineLog = [];
    const judge = (await generateKeyPairSigner()).address;
    const escrow = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: judge, spec_hash: "5c".repeat(32), send: true });
    const unproven = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.01", attestor: judge, send: true });
    const intent = escrow["intent"] as Address;
    const plain = await connect(["mcp", "--url", "devnet"]);
    const worker = await funded();
    const work = "e7".repeat(32);
    const delivery = { worker: worker.address, intent, sha256: work.toUpperCase(), url: "https://example.org/work.tar" };
    const prepared = await ok(plain, "prepare_deliver", delivery);
    expect(prepared).toMatchObject({
      intent,
      attestor: judge,
      sha256: work,
      url: delivery.url,
      summary: [
        `Announces: the work with sha256 ${work} at ${delivery.url}, for the proof escrow ${intent}`,
        `Notifies: its attestor ${judge}, with a transfer of 0 lamports from ${worker.address}`,
        "Costs: the transaction fee; no tokens move",
      ],
      warnings: [],
    });
    const view = prepared["prepared"] as { transaction: string; signers: string[] };
    expect(view.signers).toEqual([worker.address]);
    const wire = getTransactionDecoder().decode(getBase64Encoder().encode(view.transaction));
    expect(Object.values(wire.signatures).every((signature) => signature === null)).toBe(true);
    expect(Buffer.from(view.transaction, "base64").toString("latin1")).toContain(deliveryMemo({ intent, sha256: work, url: delivery.url }));
    expect(h.svm.sendTransaction(await partiallySignTransaction([worker.keyPair], wire))).not.toBeInstanceOf(FailedTransactionMetadata);
    expect((await call(plain, "prepare_deliver", { ...delivery, url: "ftp://example.org/x" })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "url" }] });
    expect((await call(plain, "prepare_deliver", { ...delivery, sha256: "xyz" })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "sha256" }] });
    expect((await call(plain, "prepare_deliver", { ...delivery, intent: unproven["intent"] })).value).toMatchObject({ code: "NotDeliverable" });
    expect((await call(plain, "prepare_deliver", { intent, sha256: work, url: delivery.url })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "worker" }] });
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
    expect(walletEmpty(address)).toContain(` ${faucetLink(address)} `);
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
    client = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools", "--wallet-per-trade", "SOL=0.1", "--wallet-per-hour", "SOL=0.15"]);
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
    const limited = ["mcp", "--url", "devnet", "--wallet", "--all-tools", "--wallet-per-hour", "SOL=0.15"];
    const swap = { sell: "SOL", buy: "TEST", amount: "0.1", min_receive: "5" };
    client = await connect(limited);
    await ok(client, "wallet_setup");
    h.sendFails = { error: new Error("fetch failed"), landed: true };
    expect((await call(client, "wallet_swap", { ...swap, send: true })).error).toBe(true);
    expect((await call(client, "wallet_swap", swap)).value).toMatchObject({ code: "WalletHourLimit" });
    setNow(h.svm.getClock().unixTimestamp + 3_601n);
    for (const error of [new BlockhashExpired("expired"), new FailedOnChain("failed")]) {
      client = await connect(limited);
      h.sendFails = { error, landed: false };
      expect((await call(client, "wallet_swap", { ...swap, send: true })).error).toBe(true);
      expect(await ok(client, "wallet_swap", swap)).toMatchObject({ sent: false });
    }
  });

  it("two wallet servers share one hourly allowance", async () => {
    const limited = ["mcp", "--url", "devnet", "--wallet", "--all-tools", "--wallet-per-hour", "SOL=0.15"];
    const first = await connect(limited);
    await ok(first, "wallet_setup");
    const second = await connect(limited);
    const swap = { sell: "SOL", buy: "TEST", amount: "0.1", min_receive: "5", exact: true };
    expect(await ok(first, "wallet_swap", { ...swap, send: true })).toMatchObject({ sent: true });
    const left = { code: "WalletHourLimit", retryable: true, hint: "this server sells at most 0.15 SOL per hour and has 0.05 left; this sells 0.1" };
    expect((await call(second, "wallet_swap", swap)).value).toMatchObject(left);
    expect((await call(second, "wallet_swap", { ...swap, send: true })).value).toMatchObject(left);
    const book = join(h.saleRoot, salesPath(defaultWallet(HOME)));
    expect(statSync(book).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(book, "utf8"))).toMatchObject([{ mint: NATIVE_MINT, amount: String(LAMPORTS_PER_SOL / 10n) }]);
    const third = await connect(limited);
    const raced = await Promise.all([second, third].map((server) => call(server, "wallet_swap", { ...swap, amount: "0.05", send: true })));
    expect(raced.map((r) => (r.error ? r.value["code"] : "sent")).sort()).toEqual(["WalletHourLimit", "sent"]);
    expect(JSON.parse(readFileSync(book, "utf8"))).toHaveLength(2);
    setNow(h.svm.getClock().unixTimestamp + 3_601n);
    expect(await ok(second, "wallet_swap", { ...swap, send: true })).toMatchObject({ sent: true });
    expect((await call(third, "wallet_swap", { ...swap, amount: "0.06" })).value).toMatchObject({ code: "WalletHourLimit" });
  });

  it("a tilde keypair path and its absolute form share one sales book", async () => {
    const limited = ["mcp", "--url", "devnet", "--wallet", "--all-tools", "--wallet-per-hour", "SOL=0.15"];
    const first = await connect(limited);
    await ok(first, "wallet_setup");
    const swap = { sell: "SOL", buy: "TEST", amount: "0.1", min_receive: "5", exact: true };
    expect(await ok(first, "wallet_swap", { ...swap, send: true })).toMatchObject({ sent: true });
    const tilde = "~/.config/intent-engine/wallet.json";
    h.files.set(tilde, h.files.get(defaultWallet(HOME)) ?? "");
    h.env["INTENT_ENGINE_KEYPAIR"] = tilde;
    const second = await connect(limited);
    expect((await call(second, "wallet_swap", { ...swap, send: true })).value).toMatchObject({ code: "WalletHourLimit" });
    expect(await ok(second, "wallet_swap", { ...swap, amount: "0.05", send: true })).toMatchObject({ sent: true });
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
      expect((await call(client, "wallet_swap", { ...swap, send: true })).error).toBe(true);
      expect(await ok(client, "wallet_swap", swap)).toMatchObject({ sent: false });
    }
    expect(JSON.parse(readFileSync(join(h.saleRoot, salesPath(defaultWallet(HOME))), "utf8"))).toEqual([]);
    h.sendFails = { error: new Charged("transaction was sent but its confirmation could not be read"), landed: true };
    expect((await call(client, "wallet_swap", { ...swap, send: true })).error).toBe(true);
    expect((await call(client, "wallet_swap", swap)).value).toMatchObject({ code: "WalletHourLimit" });
  });

  it("a nonce collision on create is retried with the next free nonce", async () => {
    const first = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    const owner = (await ok(first, "wallet_setup"))["address"] as Address;
    const swap = { sell: "SOL", buy: "TEST", amount: "0.01", min_receive: "1", exact: true };
    expect(await ok(first, "wallet_swap", { ...swap, send: true })).toMatchObject({ nonce: "0" });
    let raced = false;
    h.through = {
      ...transport,
      sendWire: async (wire, latest) => {
        if (!raced) {
          raced = true;
          expect(await ok(first, "wallet_swap", { ...swap, amount: "0.02", send: true })).toMatchObject({ nonce: "1" });
        }
        return transport.sendWire(wire, latest);
      },
    };
    const second = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    h.through = null;
    const [taken] = await findIntentPda({ owner, nonce: 1n });
    const [next] = await findIntentPda({ owner, nonce: 2n });
    expect(await ok(second, "wallet_swap", { ...swap, send: true })).toMatchObject({ intent: next, nonce: "2", sent: true });
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
    h.engineLog = [{ signature: "fill", slot: 1n, blockTime: null, failed: false, emitted: [tag(fill)] }, creation(intent)];
    h.requestedOf.length = 0;
    expect(await ok(client, "wallet_wait", { nonce: "0" })).toEqual({ intent, status: "filled", waited: 0, received: "5", token: "TEST", signature: "fill" });
    expect(h.requestedOf).toEqual([intent]);
    h.svm.setAccount({ ...account, data: Uint8Array.from(getIntentEncoder().encode({ ...decoded, status: IntentStatus.Open })) });
    await ok(client, "wallet_cancel", { nonce: "0", send: true });
    const cancelled = getIntentCancelledEventEncoder().encode({ intent, owner, refunded: LAMPORTS_PER_SOL / 20n });
    h.engineLog = [{ signature: "cancel", slot: 1n, blockTime: null, failed: false, emitted: [tag(cancelled)] }];
    expect(await ok(client, "wallet_wait", { nonce: "0" })).toEqual({ intent, status: "cancelled", waited: 0 });
    h.engineLog = [creation(intent)];
    expect(await ok(client, "wallet_wait", { nonce: "0" })).toEqual({ intent, status: "closed", waited: 0 });
    h.engineLog = [];
    expect(await ok(client, "wallet_wait", { nonce: "0" })).toEqual({ intent, status: "closed", waited: 0, next: FILL_UNKNOWN });
    h.engineLog = [{ signature: "lagging", slot: 2n, blockTime: null, failed: false, emitted: [], unread: true }];
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
