import { claimsOf, MAX_PENDING_PER_OWNER } from "../src/agent/claims.js";
import {
  type Address,
  generateKeyPairSigner,
  getBase58Decoder,
  getBase64Decoder,
  getBase64Encoder,
  getTransactionDecoder,
  type Instruction,
  type KeyPairSigner,
  lamports,
  partiallySignTransaction,
  signBytes,
  some,
} from "@solana/kit";
import {
  getApproveInstruction,
  getCloseAccountInstruction,
  getTokenDecoder,
  getTokenEncoder,
  getTransferInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { FailedTransactionMetadata } from "litesvm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createExt,
  describeSignedIntent,
  encodeParams,
  type IntentParams,
  type SignedIntentFields,
  signedIntentMessage,
  findAssociatedTokenAddress,
  findConfigPda,
  findDelegatePda,
  findIntentPda,
  findUserStatePda,
  findVaultPda,
  getConfigDecoder,
  getConfigEncoder,
  kindBit,
  Kind,
  formatAmount,
  specMemo,
  splitFees,
  U64_MAX,
  WARN_ATTESTOR,
  WARN_LONG_LIVED,
} from "@intent-engine/core";
import {
  Charged,
  DEVNET_GENESIS_HASH,
  EXTENDED_MINT_TYPE,
  EXTENDED_TYPE_OFFSET,
  EXTENSIONS_OFFSET,
  MEMO_PROGRAM_ADDRESS,
  MINT_BASE_SIZE,
  mintOf,
  scalesDisplay,
  SCALING_EXTENSIONS,
} from "@intent-engine/client";
import { define, invoke, OutputMismatch, toJson } from "../src/agent/actions.js";
import { ANNOTATIONS, annotationsOf } from "../src/agent/mcp.js";
import { VERSION } from "../src/version.js";
import { ENGINE_PROBLEMS, type Problem } from "../src/agent/problems.js";
import { createCost, rentFor, SIGNATURE_FEE, TOKEN_ACCOUNT_RENT_BYTES } from "../src/agent/budget.js";
import { ACTIONS } from "../src/agent/registry.js";
import { WALLET_ACTIONS } from "../src/agent/wallet.js";
import { amount, InvalidInput, object } from "../src/agent/schema.js";
import { OWNER_ACCOUNT_MISSING } from "../src/agent/settle.js";
import { costlyFunding, FUNDING_RENT } from "../src/crank.js";
import { SETTLED_LINE } from "../src/agent/shapes.js";
import { DEFAULT_SUBMIT_WITHIN, publishesLine, RELAY_TOO_LARGE, SPEC_URL_TOO_LONG, SPEC_URL_UNSIGNED } from "../src/agent/signed.js";
import { WARN_REPLACES_DELEGATE } from "../src/agent/owner.js";
import { SPEC_URL_PLAIN } from "../src/agent/create.js";
import { EXIT_OK } from "../src/main.js";
import { ata, balance, cli, ESCROW, FEE_BPS, funded, h, NOW, send, setNow, transport, type World, world } from "./harness.js";

type Json = Record<string, unknown> & { [key: string]: any };

async function heldBy(intent: Address): Promise<bigint> {
  const [vault] = await findVaultPda({ intent });
  return (h.svm.getBalance(intent) ?? 0n) + (h.svm.getBalance(vault) ?? 0n);
}

async function connect(relayer?: KeyPairSigner, limits: string[] = []) {
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

async function ok(client: Client, name: string, args: object = {}): Promise<Json> {
  const result = await client.callTool({ name: `solive_${name}`, arguments: args as Record<string, unknown> });
  expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
  const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
  expect(JSON.parse(text)).toEqual(result.structuredContent);
  return result.structuredContent as Json;
}

async function fail(client: Client, name: string, args: object = {}): Promise<Problem> {
  const result = await client.callTool({ name: `solive_${name}`, arguments: args as Record<string, unknown> });
  expect(result.isError).toBe(true);
  const problem = result.structuredContent as Problem;
  expect((result.content as { text: string }[])[0]?.text).toBe(`${problem.code}: ${problem.hint}`);
  return problem;
}

async function execute(prepared: { transaction: string }, ...signers: KeyPairSigner[]): Promise<void> {
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

const exists = (address: Address) => h.svm.getAccount(address).exists;

describe("agent server against the deployed engine", () => {
  let w: World;
  const free = () => ["--relay-fee", `${w.inputMint}=0`];
  let client: Client;

  const swap = (over: object = {}) => ({
    owner: w.owner.address,
    input_mint: w.inputMint,
    output_mint: w.outputMint,
    order: { kind: "swap", amount_in: ESCROW.toString(), min_out: "300" },
    expires_in: 3_600,
    ...over,
  });

  const createIntent = async (over: object = {}, owner = w.owner) => {
    const made = await ok(client, "prepare_create", swap({ owner: owner.address, ...over }));
    await execute(made["prepared"], owner);
    return made;
  };

  beforeEach(async () => {
    w = await world();
    h.watched.length = 0;
    h.watched.push(w.owner.address);
    client = await connect();
  });

  it("starts from the cli, lists every tool with its schemas and declares what each one touches", async () => {
    expect(client.getServerVersion()).toMatchObject({ name: "solive", version: VERSION });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "solive_get_config",
      "solive_get_intent",
      "solive_list_intents",
      "solive_get_balances",
      "solive_quote",
      "solive_prepare_create",
      "solive_prepare_cancel",
      "solive_find_crank_work",
      "solive_find_jobs",
      "solive_get_spec",
      "solive_prepare_deliver",
      "solive_check_delivery",
      "solive_get_receipt",
      "solive_get_reputation",
      "solive_get_claims",
      "solive_get_profile",
      "solive_prepare_crank",
      "solive_prepare_signed_intent",
      "solive_preview_signed_intent",
      "solive_submit_signed_intent",
      "solive_prepare_mandate",
      "solive_get_mandate",
      "solive_prepare_revoke_mandate",
      "solive_prepare_agent_create",
      "solive_agent_create",
    ]);
    for (const [i, tool] of tools.entries()) {
      const action = ACTIONS[i];
      expect(tool.inputSchema).toEqual(action?.input.json);
      expect(tool.outputSchema).toEqual(action?.output.json);
      expect(tool.title).toBe(action?.title);
      expect(tool.description).toBe(action?.description);
      expect(tool.annotations).toEqual(action === undefined ? undefined : annotationsOf(action));
    }
    expect(tools.filter((t) => t.annotations?.idempotentHint === false && t.annotations.destructiveHint === true).map((t) => t.name)).toEqual([
      "solive_agent_create",
    ]);
    expect(ACTIONS.map((a) => a.effect)).toEqual([
      "read",
      "read",
      "read",
      "read",
      "read",
      "prepare",
      "prepare",
      "read",
      "read",
      "read",
      "prepare",
      "read",
      "read",
      "read",
      "read",
      "read",
      "prepare",
      "prepare",
      "read",
      "submit",
      "prepare",
      "read",
      "prepare",
      "prepare",
      "submit",
    ]);
    expect(ANNOTATIONS).toEqual({
      read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      prepare: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      submit: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    });
    expect(tools.find((t) => t.name === "solive_prepare_signed_intent")?.description).toContain(
      "solive_submit_signed_intent",
    );
  });

  it("reads the live engine settings", async () => {
    const config = await ok(client, "get_config");
    const [address] = await findConfigPda();
    expect(config).toEqual({
      address,
      admin: w.authority.address,
      guardian: w.authority.address,
      fee_recipient: w.feeRecipient.address,
      paused: { create: false, fill: false },
      kinds: ["swap", "limit", "dutch", "attested"].map((kind) => ({
        kind,
        enabled: true,
        fills_stopped: false,
        fee_bps: FEE_BPS,
      })),
      partner_cut_bps: 0,
      crank_bounty: "0",
      create_fee: "0",
      domain_matches_cluster: true,
    });
    const economics = ["set-economics", "--keypair", "a.json", "--yes", "--bounty", "7000", "--create-fee", "9000"];
    await cli([...economics, "--kind-fees", "limit=3", "--partner-cut", "2500"], { "a.json": w.authority });
    await cli(["raise-pause", "--keypair", "a.json", "--yes", "--flags", "create"], { "a.json": w.authority });
    const view = h.svm.getAccount(address);
    if (!view.exists) {
      throw new Error("config missing");
    }
    const decoded = getConfigDecoder().decode(view.data);
    const data = Uint8Array.from(
      getConfigEncoder().encode({
        ...decoded,
        enabledKinds: decoded.enabledKinds & ~kindBit(Kind.DutchAuction),
        fillDisabledKinds: kindBit(Kind.AttestedResult),
      }),
    );
    h.svm.setAccount({ ...view, data });
    h.genesis = getBase58Decoder().decode(new Uint8Array(32).fill(0x12));
    expect(await ok(client, "get_config")).toMatchObject({
      paused: { create: true, fill: false },
      kinds: [
        { kind: "swap", enabled: true, fills_stopped: false, fee_bps: FEE_BPS },
        { kind: "limit", enabled: true, fills_stopped: false, fee_bps: 3 },
        { kind: "dutch", enabled: false, fills_stopped: false, fee_bps: FEE_BPS },
        { kind: "attested", enabled: true, fills_stopped: true, fee_bps: FEE_BPS },
      ],
      partner_cut_bps: 2_500,
      crank_bounty: "7000",
      create_fee: "9000",
      domain_matches_cluster: false,
    });
    await cli(["raise-pause", "--keypair", "a.json", "--yes", "--flags", "fill"], { "a.json": w.authority });
    expect((await ok(client, "get_config"))["paused"]).toEqual({ create: true, fill: true });
    await cli(["lower-pause", "--keypair", "a.json", "--yes", "--flags", "create"], { "a.json": w.authority });
    expect((await ok(client, "get_config"))["paused"]).toEqual({ create: false, fill: true });
  });

  it("prepares a create the owner signs, registering a new owner and choosing free nonces", async () => {
    const fresh = await funded();
    const inputAccount = await ata(w.authority, fresh.address, w.inputMint, 1_000n);
    const first = await ok(client, "prepare_create", swap({ owner: fresh.address }));
    const [intent0] = await findIntentPda({ owner: fresh.address, nonce: 0n });
    expect(first).toMatchObject({
      intent: intent0,
      nonce: "0",
      expires_at: (NOW + 3_600n).toString(),
      escrow: ESCROW.toString(),
      create_fee: "0",
      crank_bounty: "0",
      warnings: [],
    });
    expect(first["summary"]).toEqual([
      `Sell: exactly 0.0004 of ${w.inputMint}`,
      `Receive: at least 0.0003 of ${w.outputMint}`,
      `Expires: ${new Date(Number(NOW + 3_600n) * 1000).toISOString()}`,
      "Setup: registers you with the engine (a one-time account you pay rent for)",
      `Setup: creates your token account for ${w.outputMint} (you pay its rent)`,
    ]);
    expect(first["prepared"]).toMatchObject({ fee_payer: fresh.address, signers: [fresh.address], last_valid_block_height: "0" });
    expect(BigInt(first["prepared"]["units_consumed"])).toBeGreaterThan(0n);
    expect(first["prepared"]["logs"].length).toBeGreaterThan(0);
    expect(exists(intent0)).toBe(false);
    await execute(first["prepared"], fresh);
    expect(exists(intent0)).toBe(true);
    expect(balance(inputAccount)).toBe(1_000n - ESCROW);
    const receiver = await findAssociatedTokenAddress({ owner: fresh.address, mint: w.outputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(exists(receiver)).toBe(true);
    const second = await ok(client, "prepare_create", swap({ owner: fresh.address, order: { kind: "swap", amount_in: "100", min_out: "1" } }));
    expect(second["nonce"]).toBe("1");
    expect(second["summary"]).toHaveLength(3);
    expect((await ok(client, "prepare_create", swap({ owner: fresh.address, nonce: "9" })))["nonce"]).toBe("9");
    expect(await fail(client, "prepare_create", swap({ owner: fresh.address, nonce: "0" }))).toEqual({
      code: "NonceUsed",
      retryable: false,
      hint: ENGINE_PROBLEMS.NonceUsed.hint,
    });
  });

  it("refuses creates the program would reject, naming the cause and the fix", async () => {
    expect(await fail(client, "prepare_create", swap({ expires_at: (NOW + 10n).toString() }))).toMatchObject({
      code: "InvalidInput",
      issues: [{ path: "expires_at", message: "give exactly one of expires_at or expires_in" }],
    });
    expect((await fail(client, "prepare_create", swap({ expires_in: undefined })))["code"]).toBe("InvalidInput");
    expect(await fail(client, "prepare_create", { ...swap(), extra: 1 })).toMatchObject({
      code: "InvalidInput",
      issues: [{ path: "extra", message: "is not a known field" }],
    });
    expect(await fail(client, "prepare_create", swap({ order: { kind: "swap", amount_in: "5000", min_out: "1" } }))).toMatchObject({
      code: "InsufficientFunds",
      retryable: false,
      programError: 1,
      program: TOKEN_PROGRAM_ADDRESS,
    });
    expect(await fail(client, "prepare_create", swap({ expires_in: undefined, expires_at: NOW.toString() }))).toMatchObject({
      code: "ExpiryNotInFuture",
      hint: ENGINE_PROBLEMS.ExpiryNotInFuture.hint,
    });
    expect((await fail(client, "prepare_create", swap({ order: { kind: "swap", amount_in: "5", min_out: "0" } })))["code"]).toBe(
      "InvalidParams",
    );
    expect((await fail(client, "prepare_create", swap({ output_mint: w.inputMint })))["code"]).toBe("SameMint");
    expect(await fail(client, "prepare_create", swap({ input_mint: w.owner.address }))).toEqual({
      code: "NotAMint",
      retryable: false,
      hint: `${w.owner.address} is not a token mint; pass the mint of the token itself, not a wallet or a token account`,
    });
    const nowhere = (await generateKeyPairSigner()).address;
    expect(await fail(client, "prepare_create", swap({ output_mint: nowhere }))).toEqual({
      code: "NotFound",
      retryable: false,
      hint: `mint ${nowhere} does not exist`,
    });
    await cli(["raise-pause", "--keypair", "a.json", "--yes", "--flags", "create"], { "a.json": w.authority });
    expect(await fail(client, "prepare_create", swap())).toMatchObject({ code: "CreatePaused", retryable: true });
  });

  it("warns about attestor-settled and long-lived intents and names the partner", async () => {
    const attested = await ok(
      client,
      "prepare_create",
      swap({
        order: { kind: "attested", amount_in: "10", min_result: "1", max_result: "2", attestor: w.feeRecipient.address },
        expires_in: 31 * 24 * 60 * 60,
        partner: { account: w.feeRecipient.address, bps: 40 },
      }),
    );
    expect(attested["warnings"]).toEqual([WARN_ATTESTOR, WARN_LONG_LIVED]);
    expect(attested["summary"]).toContain(`Partner fee: 40 bps of the sold amount, rounded up, to ${w.feeRecipient.address}, less the protocol's partner cut fixed when the intent is created`);
    const thirty = await ok(client, "prepare_create", swap({ expires_in: 30 * 24 * 60 * 60 }));
    expect(thirty["warnings"]).toEqual([]);
    const limit = await ok(client, "prepare_create", swap({ order: { kind: "limit", make_amount: "10", take_amount: "20" } }));
    expect(limit["summary"][0]).toBe(`Sell: exactly 0.00001 of ${w.inputMint}`);
    const dutch = await ok(
      client,
      "prepare_create",
      swap({
        order: { kind: "dutch", amount_in: "10", start_out: "9", end_out: "5", start_time: NOW.toString(), end_time: (NOW + 60n).toString() },
      }),
    );
    expect(dutch["escrow"]).toBe("10");
  });

  it("reads, lists and quotes intents, including partner and per-kind fees", async () => {
    await cli(["set-economics", "--keypair", "a.json", "--yes", "--bounty", "0", "--create-fee", "0", "--kind-fees", "swap=7", "--partner-cut", "2000"], {
      "a.json": w.authority,
    });
    const made = await createIntent({ partner: { account: w.feeRecipient.address, bps: 50 } });
    await createIntent({ order: { kind: "limit", make_amount: "100", take_amount: "50" } });
    const view = await ok(client, "get_intent", { owner: w.owner.address, nonce: "0" });
    expect(view).toEqual({
      address: made["intent"],
      owner: w.owner.address,
      input_mint: w.inputMint,
      output_mint: w.outputMint,
      receiver: await findAssociatedTokenAddress({ owner: w.owner.address, mint: w.outputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
      nonce: "0",
      status: "open",
      escrowed: ESCROW.toString(),
      filled: "0",
      remaining: ESCROW.toString(),
      created_at: NOW.toString(),
      expires_at: (NOW + 3_600n).toString(),
      order: { kind: "swap", amount_in: ESCROW.toString(), min_out: "300" },
      partner: { account: w.feeRecipient.address, bps: 50 },
      bounty: "0",
      mandate: null,
      agent_fee: "0",
      summary: [`Sell: exactly 0.0004 of ${w.inputMint}`, `Receive: at least 0.0003 of ${w.outputMint}`],
    });
    const fees = splitFees(ESCROW, 7, 50, 2_000);
    expect(await ok(client, "quote", { owner: w.owner.address, nonce: "0" })).toEqual({
      address: made["intent"],
      at: NOW.toString(),
      amount_in: ESCROW.toString(),
      required_out: "300",
      fee_bps: 7,
      partner_bps: 50,
      protocol_fee: fees.protocol.toString(),
      partner_fee: fees.partner.toString(),
      net_in: fees.net.toString(),
    });
    const limitQuote = await ok(client, "quote", { owner: w.owner.address, nonce: "1", at: "5" });
    expect([limitQuote["at"], limitQuote["fee_bps"], limitQuote["partner_bps"]]).toEqual(["5", FEE_BPS, 0]);
    expect((await ok(client, "get_intent", { owner: w.owner.address, nonce: "1" }))["partner"]).toBeNull();
    const all = await ok(client, "list_intents");
    expect([all["intents"].length, all["more"]]).toEqual([2, false]);
    expect((await ok(client, "list_intents", { limit: 2 }))["more"]).toBe(false);
    expect(await ok(client, "list_intents", { limit: 1 })).toMatchObject({ more: true, intents: [{ nonce: "0" }] });
    expect((await ok(client, "list_intents", { status: "cancelled" }))["intents"]).toEqual([]);
    expect((await ok(client, "list_intents", { status: "open", owner: w.owner.address }))["intents"]).toHaveLength(2);
    expect((await ok(client, "list_intents", { owner: w.feeRecipient.address }))["intents"]).toEqual([]);
    expect(await fail(client, "get_intent", { owner: w.owner.address, nonce: "4" })).toMatchObject({ code: "NotFound" });
    expect((await fail(client, "quote", { owner: w.owner.address, nonce: "4" }))["code"]).toBe("NotFound");
  });

  it("shows an intent of an unknown version without inventing its terms", async () => {
    const made = await createIntent();
    const account = h.svm.getAccount(made["intent"]);
    if (!account.exists) {
      throw new Error("intent missing");
    }
    const data = new Uint8Array(account.data);
    data[8 + 164] = 2;
    data[8 + 161] = 9;
    h.svm.setAccount({ ...account, data });
    expect(await ok(client, "get_intent", { owner: w.owner.address, nonce: "0" })).toMatchObject({
      status: "unknown",
      order: null,
      summary: ["Unreadable terms: unsupported intent version 2"],
    });
  });

  it("names terms it cannot read instead of guessing them", async () => {
    const made = await createIntent();
    const account = h.svm.getAccount(made["intent"]);
    if (!account.exists) {
      throw new Error("intent missing");
    }
    const data = new Uint8Array(account.data);
    data[8 + 160] = 9;
    h.svm.setAccount({ ...account, data });
    expect(await ok(client, "get_intent", { owner: w.owner.address, nonce: "0" })).toMatchObject({
      status: "open",
      order: null,
      summary: ["Unreadable terms: UnknownKind"],
    });
  });

  it("accepts only real mints, including extended Token-2022 ones", async () => {
    const template = h.svm.getAccount(w.inputMint);
    if (!template.exists) {
      throw new Error("mint missing");
    }
    const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;
    const plant = async (data: Uint8Array, programAddress: Address = TOKEN_PROGRAM_ADDRESS) => {
      const address = (await generateKeyPairSigner()).address;
      h.svm.setAccount({ ...template, address, data, programAddress, space: BigInt(data.length) });
      return address;
    };
    const base = new Uint8Array(template.data);
    expect(await mintOf(transport, await plant(base))).toEqual({ tokenProgram: TOKEN_PROGRAM_ADDRESS, decimals: 6, scaled: false });
    const extended = new Uint8Array(170);
    extended.set(base);
    extended[165] = 1;
    expect(await mintOf(transport, await plant(extended, T22))).toEqual({ tokenProgram: T22, decimals: 6, scaled: false });
    for (const extension of [10, 25]) {
      const scaled = new Uint8Array(178);
      scaled.set(base);
      scaled[165] = 1;
      scaled.set([18, 0, 4, 0, 0, 0, 0, 0, extension, 0, 0, 0], 166);
      expect((await mintOf(transport, await plant(scaled, T22))).scaled, String(extension)).toBe(true);
    }
    expect(scalesDisplay(base)).toBe(false);
    expect(SCALING_EXTENSIONS).toEqual([10, 25]);
    expect(EXTENSIONS_OFFSET).toBe(166);
    const tokenAccount = Uint8Array.from(extended);
    tokenAccount[165] = 2;
    for (const [data, owner] of [
      [base.subarray(0, 81), TOKEN_PROGRAM_ADDRESS],
      [new Uint8Array(83), TOKEN_PROGRAM_ADDRESS],
      [new Uint8Array(165), TOKEN_PROGRAM_ADDRESS],
      [new Uint8Array(166), T22],
      [tokenAccount, T22],
      [base, "11111111111111111111111111111111" as Address],
    ] as const) {
      const address = await plant(Uint8Array.from(data), owner);
      await expect(mintOf(transport, address)).rejects.toThrow(`${address} is not a token mint`);
    }
    expect([MINT_BASE_SIZE, EXTENDED_TYPE_OFFSET, EXTENDED_MINT_TYPE]).toEqual([82, 165, 1]);
  });

  it("prepares a cancel that refunds the owner", async () => {
    await createIntent();
    const cancel = await ok(client, "prepare_cancel", { owner: w.owner.address, nonce: "0" });
    expect([cancel["refund"], cancel["prepared"]["signers"]]).toEqual([ESCROW.toString(), [w.owner.address]]);
    const [intent] = await findIntentPda({ owner: w.owner.address, nonce: 0n });
    const held = await heldBy(intent);
    expect(held).toBeGreaterThan(h.svm.getBalance(intent) ?? 0n);
    const rent = `${held} lamports (${formatAmount(held, 9)} SOL)`;
    expect(cancel["summary"]).toEqual([
      `Cancels intent ${intent} (nonce 0); nobody can fill it afterwards`,
      `Cancelled terms: Sell: exactly 0.0004 of ${w.inputMint}`,
      `Cancelled terms: Receive: at least 0.0003 of ${w.outputMint}`,
      `Returns 0.0004 of ${w.inputMint} to your token account`,
      `The intent and its escrow account stay readable as cancelled and hold ${rent} of rent and bounty that are yours; set close to get them back in this transaction, or close it later with solive_prepare_crank`,
    ]);
    expect(cancel["warnings"]).toEqual([]);
    await execute(cancel["prepared"], w.owner);
    expect(balance(w.ownerInput)).toBe(1_000n);
    expect(await heldBy(intent)).toBe(held);
    const settled = await ok(client, "get_intent", { owner: w.owner.address, nonce: "0" });
    expect(settled["status"]).toBe("cancelled");
    expect(settled["escrowed"]).toBe(ESCROW.toString());
    expect(settled["summary"].at(-1)).toBe(SETTLED_LINE);
    expect((await fail(client, "prepare_cancel", { owner: w.owner.address, nonce: "0" }))["code"]).toBe("InvalidTransition");
  });

  it("closes a cancelled intent in the same transaction when asked and returns its rent to the owner who paid it", async () => {
    const made = await createIntent();
    const open = await ok(client, "get_intent", { owner: w.owner.address, nonce: "0" });
    expect(open["summary"]).not.toContain(SETTLED_LINE);
    const held = await heldBy(made["intent"]);
    const cancel = await ok(client, "prepare_cancel", { owner: w.owner.address, nonce: "0", close: true });
    expect(cancel["summary"].at(-1)).toBe(
      `Closes the intent and its escrow account in the same transaction and returns their ${held} lamports (${formatAmount(held, 9)} SOL) of rent and bounty to you; the intent can no longer be read afterwards`,
    );
    const before = h.svm.getBalance(w.owner.address) ?? 0n;
    await execute(cancel["prepared"], w.owner);
    expect(exists(made["intent"])).toBe(false);
    expect(balance(w.ownerInput)).toBe(1_000n);
    expect((h.svm.getBalance(w.owner.address) ?? 0n) - before).toBe(held - 5_000n);
    expect((await fail(client, "get_intent", { owner: w.owner.address, nonce: "0" }))["code"]).toBe("NotFound");
  });

  it("finds crank work and prepares expires and closes that pay the bounty", async () => {
    await cli(["set-economics", "--keypair", "a.json", "--yes", "--bounty", "50000", "--create-fee", "0"], { "a.json": w.authority });
    const small = { kind: "swap", amount_in: "100", min_out: "1" };
    const expiring = await createIntent({ expires_in: 60, order: small });
    await createIntent({ expires_in: 3_600, order: small });
    const cancelled = await createIntent({ expires_in: 3_600, order: small });
    const cancel = await ok(client, "prepare_cancel", { owner: w.owner.address, nonce: "2" });
    await execute(cancel["prepared"], w.owner);
    const cranker = await funded();
    expect(await fail(client, "prepare_crank", { cranker: cranker.address, owner: w.owner.address, nonce: "1" })).toEqual({
      code: "NothingToCrank",
      retryable: true,
      hint: "this intent is still open and not yet expired, was cancelled and pays nothing to this cranker, or is not one this client can read",
    });
    expect(await ok(client, "find_crank_work")).toEqual({ now: NOW.toString(), work: [], more: false });
    expect(await ok(client, "find_crank_work", { cranker: w.owner.address })).toEqual({
      now: NOW.toString(),
      work: [{ intent: cancelled["intent"], owner: w.owner.address, nonce: "2", action: "close", bounty: "50000" }],
      more: false,
    });
    setNow(NOW + 60n);
    const work = await ok(client, "find_crank_work", { cranker: w.owner.address, limit: 1 });
    expect(work).toMatchObject({ more: true, work: [{ intent: expiring["intent"], action: "expire", bounty: "50000" }] });
    expect((await ok(client, "find_crank_work", { cranker: w.owner.address, limit: 2 }))["more"]).toBe(false);
    expect((await ok(client, "find_crank_work", { limit: 1 }))["more"]).toBe(false);
    const before = h.svm.getBalance(cranker.address) ?? 0n;
    const expire = await ok(client, "prepare_crank", { cranker: cranker.address, owner: w.owner.address, nonce: "0" });
    expect([expire["action"], expire["bounty"], expire["prepared"]["signers"]]).toEqual(["expire", "50000", [cranker.address]]);
    await execute(expire["prepared"], cranker);
    expect(exists(expiring["intent"])).toBe(false);
    expect((h.svm.getBalance(cranker.address) ?? 0n) > before).toBe(true);
    expect((await fail(client, "prepare_crank", { cranker: cranker.address, owner: w.owner.address, nonce: "2" }))["code"]).toBe(
      "NothingToCrank",
    );
    const ownerBefore = h.svm.getBalance(w.owner.address) ?? 0n;
    const close = await ok(client, "prepare_crank", { cranker: w.owner.address, owner: w.owner.address, nonce: "2" });
    expect(close["action"]).toBe("close");
    await execute(close["prepared"], w.owner);
    expect(exists(cancelled["intent"])).toBe(false);
    expect((h.svm.getBalance(w.owner.address) ?? 0n) - ownerBefore).toBeGreaterThan(50_000n);
  });

  it("asks before paying for an owner's missing refund account and pays only what the bounty covers", async () => {
    await createIntent({ expires_in: 60 });
    await cli(["set-economics", "--keypair", "a.json", "--yes", "--bounty", FUNDING_RENT.toString(), "--create-fee", "0"], { "a.json": w.authority });
    await createIntent({ expires_in: 60 });
    const sink = await ata(w.authority, (await generateKeyPairSigner()).address, w.inputMint);
    await send(w.owner, [
      getTransferInstruction({ source: w.ownerInput, destination: sink, authority: w.owner, amount: balance(w.ownerInput) }),
      getCloseAccountInstruction({ account: w.ownerInput, destination: w.owner.address, owner: w.owner }),
    ]);
    setNow(NOW + 60n);
    const cranker = await funded();
    const ref = { cranker: cranker.address, owner: w.owner.address, nonce: "0" };
    expect(await fail(client, "prepare_crank", ref)).toEqual({ code: "OwnerAccountMissing", retryable: false, hint: OWNER_ACCOUNT_MISSING });
    expect(await fail(client, "prepare_crank", { ...ref, fund_accounts: false })).toMatchObject({ code: "OwnerAccountMissing" });
    expect(await fail(client, "prepare_crank", { ...ref, fund_accounts: true })).toEqual({
      code: "FundingExceedsBounty",
      retryable: false,
      hint: costlyFunding(0n),
    });
    const funded2 = await ok(client, "prepare_crank", { ...ref, nonce: "1", fund_accounts: true });
    await execute(funded2["prepared"], cranker);
    expect(balance(w.ownerInput)).toBe(ESCROW);
  });

  it("keeps serving an owner whose engine and token account addresses a stranger funded first", async () => {
    const relayer = await funded();
    const relaying = await connect(relayer, free());
    for (const flow of ["create", "signed"] as const) {
      const owner = await funded();
      const ownerInput = await ata(w.authority, owner.address, w.inputMint, 1_000n);
      const [userState] = await findUserStatePda({ owner: owner.address });
      const receiver = await findAssociatedTokenAddress({ owner: owner.address, mint: w.outputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
      const [firstIntent] = await findIntentPda({ owner: owner.address, nonce: 0n });
      for (const address of [userState, receiver, firstIntent]) {
        h.svm.airdrop(address, lamports(h.svm.minimumBalanceForRentExemption(0n)));
        expect(h.svm.getAccount(address)).toMatchObject({ exists: true, data: new Uint8Array() });
      }
      expect((await ok(client, "get_balances", { owner: owner.address, mints: [w.outputMint] }))["tokens"]).toMatchObject([
        { account: receiver, exists: false, balance: "0" },
      ]);
      if (flow === "create") {
        const made = await ok(client, "prepare_create", swap({ owner: owner.address }));
        expect(made["summary"].slice(-2)).toEqual([
          "Setup: registers you with the engine (a one-time account you pay rent for)",
          `Setup: creates your token account for ${w.outputMint} (you pay its rent)`,
        ]);
        expect(made["intent"]).toBe(firstIntent);
        await execute(made["prepared"], owner);
        expect(exists(made["intent"])).toBe(true);
      } else {
        const terms = { ...swap({ owner: owner.address }), submit_within: 600 };
        const prepared = await ok(relaying, "prepare_signed_intent", terms);
        expect(prepared["intent"]).toBe(firstIntent);
        await execute(prepared["setup"], owner);
        const signature = getBase58Decoder().decode(
          await signBytes(owner.keyPair.privateKey, getBase64Encoder().encode(prepared["message"])),
        );
        await ok(relaying, "submit_signed_intent", { ...prepared["submit"], signature });
        expect(exists(prepared["intent"])).toBe(true);
      }
      expect(balance(ownerInput)).toBe(1_000n - ESCROW);
      expect(getTokenDecoder().decode((h.svm.getAccount(receiver) as { data: Uint8Array }).data).owner).toBe(owner.address);
    }
  });

  it("relays a gasless signed intent after a one-time setup and allows several pending at once", async () => {
    const relayer = await funded();
    const relaying = await connect(relayer, free());
    const owner = await funded();
    const ownerInput = await ata(w.authority, owner.address, w.inputMint, 1_000n);
    const terms = { ...swap({ owner: owner.address }), submit_within: 600 };
    const first = await ok(relaying, "prepare_signed_intent", terms);
    expect(first).toMatchObject({ nonce: "0", escrow: ESCROW.toString(), warnings: [] });
    expect(first["submit"]).toEqual({
      owner: owner.address,
      input_mint: w.inputMint,
      output_mint: w.outputMint,
      order: { kind: "swap", amount_in: ESCROW.toString(), min_out: "300" },
      expires_at: (NOW + 3_600n).toString(),
      nonce: "0",
      submit_by: (NOW + 600n).toString(),
      epoch: "0",
      relayer_fee: "0",
    });
    expect(first["summary"]).toContain(`Sell: exactly 0.0004 of ${w.inputMint}`);
    expect(first["summary"]).toContain(`Digest (must match your wallet): ${first["digest"]}`);
    expect(first["summary"].slice(-3)).toEqual([
      "Setup: registers you with the engine (a one-time account you pay rent for)",
      `Setup: creates your token account for ${w.outputMint} (you pay its rent)`,
      `Setup: sets the engine's spending allowance on ${ownerInput} to 0.0004 (now 0)`,
    ]);
    await execute(first["setup"], owner);
    const allowance = () => getTokenDecoder().decode((h.svm.getAccount(ownerInput) as { data: Uint8Array }).data).delegatedAmount;
    expect(allowance()).toBe(ESCROW);
    const second = await ok(relaying, "prepare_signed_intent", { ...terms, order: { kind: "swap", amount_in: "100", min_out: "50" } });
    expect(second["nonce"]).toBe("1");
    expect(second["summary"].at(-1)).toBe(`Setup: sets the engine's spending allowance on ${ownerInput} to 0.0005 (now 0.0004)`);
    expect(await fail(relaying, "prepare_signed_intent", { ...terms, nonce: "1" })).toMatchObject({ code: "NoncePromised", retryable: true });
    const third = await ok(relaying, "prepare_signed_intent", { ...terms, order: { kind: "swap", amount_in: "100", min_out: "50" } });
    expect(third["nonce"]).toBe("2");
    await execute(third["setup"], owner);
    expect(allowance()).toBe(ESCROW + 100n);
    const sign = async (message: string) =>
      getBase58Decoder().decode(await signBytes(owner.keyPair.privateKey, getBase64Encoder().encode(message)));
    const signature = await sign(first["message"]);
    const submitted = await ok(relaying, "submit_signed_intent", { ...first["submit"], signature });
    expect(submitted["intent"]).toBe(first["intent"]);
    expect(typeof submitted["signature"]).toBe("string");
    expect(balance(ownerInput)).toBe(1_000n - ESCROW);
    expect(await ok(relaying, "submit_signed_intent", { ...first["submit"], signature })).toEqual({
      intent: first["intent"],
      signature: null,
    });
    await ok(relaying, "submit_signed_intent", { ...third["submit"], signature: await sign(third["message"]) });
    expect(balance(ownerInput)).toBe(1_000n - ESCROW - 100n);
    expect(allowance()).toBe(0n);
    expect(await fail(client, "submit_signed_intent", { ...third["submit"], signature })).toMatchObject({
      code: "RelayerNotConfigured",
    });
    const fourth = await ok(relaying, "prepare_signed_intent", terms);
    await execute(fourth["setup"], owner);
    expect(await fail(relaying, "submit_signed_intent", { ...fourth["submit"], signature })).toMatchObject({
      code: "SignatureInvalid",
    });
    for (const bad of ["abc", "0".repeat(88), getBase58Decoder().decode(new Uint8Array(63).fill(9))]) {
      expect(await fail(relaying, "submit_signed_intent", { ...fourth["submit"], signature: bad })).toEqual({
        code: "SignatureMalformed",
        retryable: false,
        hint: "the signature must be 64 bytes written in base58",
      });
    }
    setNow(NOW + 601n);
    expect(
      await fail(relaying, "submit_signed_intent", { ...fourth["submit"], signature: await sign(fourth["message"]) }),
    ).toMatchObject({ code: "SignatureExpired" });
  });

  it("shows, asks to sign and creates exactly the same terms for random signed intents", async () => {
    let seed = 7;
    const next = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    const relayer = await funded();
    const relaying = await connect(relayer, [...free(), "--relay-hourly-lamports", "10000000000", "--relay-max-ttl", "604800"]);
    const [configAddress] = await findConfigPda();
    const configView = h.svm.getAccount(configAddress);
    if (!configView.exists) {
      throw new Error("config missing");
    }
    const domain = Uint8Array.from(getConfigDecoder().decode(configView.data).domain);
    const toParams = (order: Json): IntentParams => {
      switch (order["kind"]) {
        case "swap":
          return { kind: Kind.SwapExactIn, amountIn: BigInt(order["amount_in"]), minOut: BigInt(order["min_out"]) };
        case "limit":
          return { kind: Kind.LimitOrder, makeAmount: BigInt(order["make_amount"]), takeAmount: BigInt(order["take_amount"]) };
        default:
          return {
            kind: Kind.DutchAuction,
            amountIn: BigInt(order["amount_in"]),
            startOut: BigInt(order["start_out"]),
            endOut: BigInt(order["end_out"]),
            startTs: BigInt(order["start_time"]),
            endTs: BigInt(order["end_time"]),
          };
      }
    };
    for (let round = 0; round < 30; round++) {
      const owner = await funded();
      const ownerInput = await ata(w.authority, owner.address, w.inputMint, 10_000n);
      const receiver = await findAssociatedTokenAddress({ owner: owner.address, mint: w.outputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
      const amount = BigInt(1 + next(2_000));
      const expiresIn = 60 + next(86_400);
      const order = [
        { kind: "swap", amount_in: amount.toString(), min_out: String(1 + next(5_000)) },
        { kind: "limit", make_amount: amount.toString(), take_amount: String(1 + next(5_000)) },
        {
          kind: "dutch",
          amount_in: amount.toString(),
          start_out: String(500 + next(500)),
          end_out: String(1 + next(500)),
          start_time: NOW.toString(),
          end_time: (NOW + BigInt(expiresIn)).toString(),
        },
      ][next(3)] as Json;
      const partner = next(2) === 0 ? undefined : { account: (await generateKeyPairSigner()).address, bps: 1 + next(100) };
      const prepared = await ok(relaying, "prepare_signed_intent", {
        owner: owner.address,
        input_mint: w.inputMint,
        output_mint: w.outputMint,
        order,
        expires_in: expiresIn,
        submit_within: 60 + next(3_000),
        relayer_fee: String(next(40)),
        ...(partner === undefined ? {} : { partner }),
      });
      const submit = prepared["submit"] as Json;
      const fields: SignedIntentFields = {
        domain,
        owner: owner.address,
        ownerInput,
        inputMint: w.inputMint,
        outputMint: w.outputMint,
        receiver,
        nonce: BigInt(submit["nonce"]),
        expiresAt: BigInt(submit["expires_at"]),
        submitBy: BigInt(submit["submit_by"]),
        kind: toParams(submit["order"]).kind,
        params: encodeParams(toParams(submit["order"])),
        epoch: BigInt(submit["epoch"]),
        relayerFee: BigInt(submit["relayer_fee"]),
        ext: createExt(partner === undefined ? {} : { partner: { key: partner.account, bps: partner.bps } }),
      };
      expect(submit["order"], `round ${round}`).toEqual(order);
      expect(prepared["message"], `round ${round}`).toBe(getBase64Decoder().decode(await signedIntentMessage(fields)));
      const described = await describeSignedIntent(fields, {
        now: NOW,
        currentEpoch: 0n,
        expectedDomain: domain,
        outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        inputDecimals: 6,
        outputDecimals: 6,
      });
      expect(prepared["digest"], `round ${round}`).toBe(described.digest);
      expect((prepared["summary"] as string[]).slice(0, described.lines.length), `round ${round}`).toEqual(described.lines);
      await execute(prepared["setup"], owner);
      const signature = getBase58Decoder().decode(
        await signBytes(owner.keyPair.privateKey, getBase64Encoder().encode(prepared["message"])),
      );
      await ok(relaying, "submit_signed_intent", { ...submit, signature });
      expect(await ok(relaying, "get_intent", { owner: owner.address, nonce: submit["nonce"] }), `round ${round}`).toMatchObject({
        status: "open",
        receiver,
        expires_at: submit["expires_at"],
        order,
        partner: partner ?? null,
      });
    }
  });

  it("charges the relayer's fee in the input token, signed by the owner and paid as the intent is created", async () => {
    const relayer = await funded();
    const relaying = await connect(relayer, ["--relay-fee", `${w.inputMint}=25`]);
    const owner = await funded();
    const ownerInput = await ata(w.authority, owner.address, w.inputMint, 1_000n);
    const prepared = await ok(relaying, "prepare_signed_intent", swap({ owner: owner.address }));
    expect(prepared["submit"]).toMatchObject({ relayer_fee: "25" });
    expect(prepared["summary"]).toContain(
      `Relayer fee: 0.000025 of ${w.inputMint}, paid from ${ownerInput} to whoever submits it`,
    );
    expect(prepared["summary"].at(-1)).toBe(`Setup: sets the engine's spending allowance on ${ownerInput} to 0.000425 (now 0)`);
    await execute(prepared["setup"], owner);
    const signature = getBase58Decoder().decode(
      await signBytes(owner.keyPair.privateKey, getBase64Encoder().encode(prepared["message"])),
    );
    expect(await fail(relaying, "submit_signed_intent", { ...prepared["submit"], relayer_fee: "24", signature })).toEqual({
      code: "RelayFeeTooLow",
      retryable: false,
      hint: `this relayer charges 25 raw units of ${w.inputMint} per intent; prepare and sign the intent again on this server`,
    });
    expect(await fail(relaying, "submit_signed_intent", { ...prepared["submit"], relayer_fee: "26", signature })).toMatchObject({
      code: "SignatureInvalid",
    });
    await ok(relaying, "submit_signed_intent", { ...prepared["submit"], signature });
    const relayerAccount = await findAssociatedTokenAddress({ owner: relayer.address, mint: w.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(balance(relayerAccount)).toBe(25n);
    expect(balance(ownerInput)).toBe(1_000n - ESCROW - 25n);
    expect(prepared["summary"]).toContain(
      `Cost to you: 0.000025 of ${w.inputMint} to the relayer, plus 5000 lamports of SOL for the setup transaction's network fee, once`,
    );
    const holdings = (mints: string[]) => ok(relaying, "get_balances", { owner: owner.address, mints });
    const sol = h.svm.getBalance(owner.address) ?? 0n;
    expect(sol).toBeGreaterThan(0n);
    expect(await holdings([w.inputMint, w.outputMint])).toEqual({
      owner: owner.address,
      lamports: sol.toString(),
      sol: formatAmount(sol, 9),
      tokens: [
        {
          mint: w.inputMint,
          decimals: 6,
          account: ownerInput,
          exists: true,
          balance: "575",
          balance_tokens: "0.000575",
          engine_allowance: "0",
          escrowed: ESCROW.toString(),
        },
        {
          mint: w.outputMint,
          decimals: 6,
          account: await findAssociatedTokenAddress({ owner: owner.address, mint: w.outputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
          exists: true,
          balance: "0",
          balance_tokens: "0",
          engine_allowance: "0",
          escrowed: "0",
        },
      ],
      unreadable: 0,
    });
    const nonce = (prepared["submit"] as Json)["nonce"] as string;
    await execute((await ok(relaying, "prepare_cancel", { owner: owner.address, nonce }))["prepared"], owner);
    expect(await ok(relaying, "get_intent", { owner: owner.address, nonce })).toMatchObject({
      status: "cancelled",
      escrowed: ESCROW.toString(),
      remaining: "0",
    });
    expect(((await holdings([w.inputMint]))["tokens"] as Json[])[0]).toMatchObject({ balance: "975", escrowed: "0" });
    const stranger = await generateKeyPairSigner();
    expect(await ok(relaying, "get_balances", { owner: stranger.address, mints: [w.inputMint] })).toMatchObject({ lamports: "0", sol: "0" });
    expect(((await ok(relaying, "get_balances", { owner: stranger.address, mints: [w.inputMint] }))["tokens"] as Json[])[0]).toMatchObject({
      exists: false,
      balance: "0",
      engine_allowance: "0",
    });
    const other = await generateKeyPairSigner();
    await send(owner, [getApproveInstruction({ source: ownerInput, delegate: other.address, owner, amount: 9n })]);
    expect(((await holdings([w.inputMint]))["tokens"] as Json[])[0]).toMatchObject({ engine_allowance: "0" });
    expect(await fail(relaying, "get_balances", { owner: owner.address, mints: [] })).toMatchObject({ code: "InvalidInput" });
  });

  it("preview signed intent is a tool", async () => {
    const owner = await funded();
    await ata(w.authority, owner.address, w.inputMint, 1_000n);
    const { tools } = await client.listTools();
    const listed = tools.find((t) => t.name === "solive_preview_signed_intent");
    expect(listed?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    const prepared = await ok(client, "prepare_signed_intent", swap({ owner: owner.address }));
    await execute(prepared["setup"], owner);
    const signature = getBase58Decoder().decode(await signBytes(owner.keyPair.privateKey, getBase64Encoder().encode(prepared["message"])));
    const preview = await ok(client, "preview_signed_intent", { ...prepared["submit"], signature });
    expect(preview).toMatchObject({ intent: prepared["intent"], exists: 0, relayer_fee: "0", warnings: [] });
    expect(preview["summary"]).toContain(`Digest (must match your wallet): ${prepared["digest"]}`);
    expect(exists(prepared["intent"])).toBe(false);
    const other = await funded();
    const forged = getBase58Decoder().decode(await signBytes(other.keyPair.privateKey, getBase64Encoder().encode(prepared["message"])));
    expect(await fail(client, "preview_signed_intent", { ...prepared["submit"], signature: forged })).toMatchObject({ code: "SignatureInvalid" });
  });

  it("a relayed proof escrow publishes its spec url", async () => {
    const relayer = await funded();
    const sent: Instruction[][] = [];
    h.through = { ...transport, send: async (instructions, payer) => {
      sent.push([...instructions]);
      return transport.send(instructions, payer);
    } };
    const relaying = await connect(relayer, free());
    h.through = null;
    const owner = await funded();
    await ata(w.authority, owner.address, w.inputMint, 1_000n);
    const judge = (await generateKeyPairSigner()).address;
    const specUrl = "https://a.io/spec.md";
    const order = { kind: "attested", amount_in: ESCROW.toString(), min_result: "1", max_result: "1", attestor: judge, spec_hash: "5c".repeat(32) };
    const terms = { ...swap({ owner: owner.address, order }), spec_url: specUrl };
    expect(await fail(relaying, "prepare_signed_intent", { ...terms, order: swap()["order"] })).toMatchObject({ code: "InvalidInput" });
    expect(await fail(relaying, "prepare_signed_intent", { ...terms, spec_url: "ftp://example.org/spec" })).toMatchObject({ code: "InvalidInput" });
    expect(await fail(relaying, "prepare_signed_intent", { ...terms, spec_url: "https://example.org/jobs/spec.md" })).toEqual({ code: "RelayTooLarge", retryable: false, hint: SPEC_URL_TOO_LONG });
    const prepared = await ok(relaying, "prepare_signed_intent", terms);
    expect(prepared["submit"]).toMatchObject({ spec_url: specUrl });
    expect(prepared["summary"]).toContain(publishesLine(specUrl));
    expect(prepared["warnings"]).toContain(SPEC_URL_UNSIGNED);
    await execute(prepared["setup"], owner);
    const signature = getBase58Decoder().decode(await signBytes(owner.keyPair.privateKey, getBase64Encoder().encode(prepared["message"])));
    const signed = { ...prepared["submit"], signature };
    const preview = await ok(relaying, "preview_signed_intent", signed);
    expect(preview["summary"]).toContain(publishesLine(specUrl));
    expect(preview["warnings"]).toContain(SPEC_URL_UNSIGNED);
    expect(await ok(relaying, "submit_signed_intent", signed)).toMatchObject({ intent: prepared["intent"], signature: expect.any(String) });
    const memos = sent.flat().filter((ix) => ix.programAddress === MEMO_PROGRAM_ADDRESS);
    expect(memos.map((ix) => new TextDecoder().decode(Uint8Array.from(ix.data ?? [])))).toEqual([specMemo(specUrl)]);
    expect(memos[0]?.accounts?.map((a) => a.address)).toEqual([relayer.address]);
    expect(exists(prepared["intent"])).toBe(true);
    const { spec_url: _, ...unpublished } = signed;
    expect(await ok(relaying, "preview_signed_intent", unpublished)).toMatchObject({ exists: 1 });
  });

  it("mcp create refuses a plain http spec url on a public cluster", async () => {
    const relaying = await connect(await funded(), free());
    const owner = await funded();
    await ata(w.authority, owner.address, w.inputMint, 1_000n);
    const judge = (await generateKeyPairSigner()).address;
    const plainUrl = "http://localhost/spec.md";
    const order = { kind: "attested", amount_in: ESCROW.toString(), min_result: "1", max_result: "1", attestor: judge, spec_hash: "5c".repeat(32) };
    const terms = { ...swap({ owner: owner.address, order }), spec_url: plainUrl };
    expect(await ok(relaying, "prepare_create", terms)).toMatchObject({ summary: expect.arrayContaining([`Publishes: the acceptance spec's url ${plainUrl}, in a memo the owner signs`]) });
    const prepared = await ok(relaying, "prepare_signed_intent", terms);
    expect(prepared["submit"]).toMatchObject({ spec_url: plainUrl });
    await execute(prepared["setup"], owner);
    const signature = getBase58Decoder().decode(await signBytes(owner.keyPair.privateKey, getBase64Encoder().encode(prepared["message"])));
    const signed = { ...prepared["submit"], signature };
    const refused = { code: "InvalidInput", issues: [{ path: "spec_url", message: SPEC_URL_PLAIN }] };
    const local = h.genesis;
    h.genesis = DEVNET_GENESIS_HASH;
    try {
      expect(await fail(relaying, "prepare_create", terms)).toMatchObject(refused);
      expect(await fail(relaying, "prepare_signed_intent", terms)).toMatchObject(refused);
      expect(await fail(relaying, "preview_signed_intent", signed)).toMatchObject(refused);
      expect(await fail(relaying, "submit_signed_intent", signed)).toMatchObject(refused);
      expect(await ok(relaying, "prepare_create", { ...terms, spec_url: "https://a.io/spec.md" })).toMatchObject({ escrow: ESCROW.toString() });
    } finally {
      h.genesis = local;
    }
    expect(exists(prepared["intent"])).toBe(false);
  });

  it("signs with a default submit window, carries a partner and refuses an allowance that would overflow", async () => {
    const owner = await funded();
    const ownerInput = await ata(w.authority, owner.address, w.inputMint, 1_000n);
    const partner = { account: w.feeRecipient.address, bps: 25 };
    const prepared = await ok(client, "prepare_signed_intent", swap({ owner: owner.address, partner }));
    expect(prepared["submit"]).toMatchObject({ submit_by: (NOW + 3_600n).toString(), partner });
    expect(DEFAULT_SUBMIT_WITHIN).toBe(3_600);
    expect(prepared["summary"]).toContain(`Partner fee: 25 bps of the sold amount, rounded up, to ${partner.account}, less the protocol's partner cut fixed when the intent is created`);
    const [delegate] = await findDelegatePda({ owner: owner.address });
    const view = h.svm.getAccount(ownerInput);
    if (!view.exists) {
      throw new Error("token account missing");
    }
    const allow = (delegatedAmount: bigint) => {
      const token = getTokenDecoder().decode(view.data);
      const data = Uint8Array.from(getTokenEncoder().encode({ ...token, delegate: some(delegate), delegatedAmount }));
      h.svm.setAccount({ ...view, data });
    };
    allow(U64_MAX - ESCROW);
    expect((await ok(client, "prepare_signed_intent", swap({ owner: owner.address })))["escrow"]).toBe(ESCROW.toString());
    allow(U64_MAX - ESCROW + 1n);
    const capped = await ok(client, "prepare_signed_intent", swap({ owner: owner.address }));
    expect(capped["summary"].at(-1)).toBe(
      `Setup: sets the engine's spending allowance on ${ownerInput} to ${formatAmount(U64_MAX, 6)} (now ${formatAmount(U64_MAX - ESCROW + 1n, 6)})`,
    );
    const outsider = (await generateKeyPairSigner()).address;
    const foreign = getTokenDecoder().decode(view.data);
    h.svm.setAccount({
      ...view,
      data: Uint8Array.from(getTokenEncoder().encode({ ...foreign, delegate: some(outsider), delegatedAmount: 5n })),
    });
    const replacing = await ok(client, "prepare_signed_intent", swap({ owner: owner.address }));
    expect(replacing["warnings"]).toContain(WARN_REPLACES_DELEGATE);
    expect(replacing["summary"].at(-1)).toBe(`Setup: removes the approval ${outsider} holds on ${ownerInput}`);
  });

  it("never promises one nonce to two requests that arrive at the same moment", async () => {
    const owner = await funded();
    await ata(w.authority, owner.address, w.inputMint, 10_000n);
    const relaying = await connect(await funded(), free());
    const terms = swap({ owner: owner.address, order: { kind: "swap", amount_in: "100", min_out: "50" } });
    const signed = await Promise.all(Array.from({ length: 6 }, () => ok(relaying, "prepare_signed_intent", terms)));
    expect(new Set(signed.map((p) => p["nonce"])).size).toBe(6);
    const created = await Promise.all(Array.from({ length: 6 }, () => ok(client, "prepare_create", swap())));
    expect(new Set(created.map((p) => p["nonce"])).size).toBe(6);
  });

  it("refuses a nonce already handed out and takes it back when a prepare fails", async () => {
    const owner = await funded();
    await ata(w.authority, owner.address, w.inputMint, 10_000n);
    const relaying = await connect(await funded(), free());
    const terms = swap({ owner: owner.address, nonce: "7", order: { kind: "swap", amount_in: "100", min_out: "50" } });
    const both = await Promise.all([0, 1].map(() => relaying.callTool({ name: "solive_prepare_signed_intent", arguments: terms })));
    expect(both.filter((r) => r.isError !== true)).toHaveLength(1);
    expect(both.filter((r) => r.isError === true).map((r) => (r.structuredContent as Json)["code"])).toEqual(["NoncePromised"]);
    expect(await fail(relaying, "prepare_create", terms)).toMatchObject({ code: "NoncePromised", retryable: true });
    const broke = await generateKeyPairSigner();
    await ata(w.authority, broke.address, w.inputMint, 10_000n);
    const unfunded = swap({ owner: broke.address, order: { kind: "swap", amount_in: "100", min_out: "50" } });
    expect((await fail(relaying, "prepare_signed_intent", unfunded))["code"]).not.toBe("NoncePromised");
    h.svm.airdrop(broke.address, lamports(1_000_000_000n));
    expect((await ok(relaying, "prepare_signed_intent", unfunded))["nonce"]).toBe("0");
  });

  it("relays one signed intent once however many times it is submitted at the same moment", async () => {
    const relayer = await funded();
    const owner = await funded();
    await ata(w.authority, owner.address, w.inputMint, 10_000n);
    const cost = createCost({ createFee: 0, crankBounty: 0 });
    const relaying = await connect(relayer, [...free(), "--relay-hourly-lamports", (2n * cost).toString()]);
    const terms = swap({ owner: owner.address, order: { kind: "swap", amount_in: "100", min_out: "50" } });
    const sign = async (message: string) =>
      getBase58Decoder().decode(await signBytes(owner.keyPair.privateKey, getBase64Encoder().encode(message)));
    const first = await ok(relaying, "prepare_signed_intent", terms);
    await execute(first["setup"], owner);
    const second = await ok(relaying, "prepare_signed_intent", terms);
    await execute(second["setup"], owner);
    const payload = { ...first["submit"], signature: await sign(first["message"]) };
    const before = h.svm.getBalance(relayer.address) ?? 0n;
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        relaying.callTool({ name: "solive_submit_signed_intent", arguments: payload as Record<string, unknown> }),
      ),
    );
    const sent = results.filter((r) => r.isError !== true && (r.structuredContent as Json)["signature"] !== null);
    expect(sent).toHaveLength(1);
    for (const r of results.filter((x) => x.isError === true)) {
      expect((r.structuredContent as Json)["code"]).toBe("SubmitInFlight");
    }
    expect(before - (h.svm.getBalance(relayer.address) ?? 0n)).toBeLessThanOrEqual(cost);
    await ok(relaying, "submit_signed_intent", { ...second["submit"], signature: await sign(second["message"]) });
  });

  it("never claims success for a nonce another intent took, and frees the budget of a relay that never went out", async () => {
    const relayer = await funded();
    const owner = await funded();
    const ownerInput = await ata(w.authority, owner.address, w.inputMint, 1_000n);
    const cost = createCost({ createFee: 0, crankBounty: 0 });
    const relaying = await connect(relayer, [...free(), "--relay-hourly-lamports", cost.toString()]);
    const terms = swap({ owner: owner.address, order: { kind: "swap", amount_in: "100", min_out: "50" } });
    const sign = async (message: string) =>
      getBase58Decoder().decode(await signBytes(owner.keyPair.privateKey, getBase64Encoder().encode(message)));
    const first = await ok(relaying, "prepare_signed_intent", terms);
    await execute(first["setup"], owner);
    const drained = await sign(first["message"]);
    const elsewhere = await connect(await funded(), [...free(), "--relay-hourly-lamports", cost.toString()]);
    const rival = await ok(elsewhere, "prepare_signed_intent", {
      ...terms,
      nonce: first["nonce"],
      order: { kind: "swap", amount_in: "100", min_out: "1" },
    });
    await send(owner, [
      getTransferInstruction({ source: ownerInput, destination: w.ownerInput, authority: owner, amount: 1_000n }),
    ]);
    expect((await fail(relaying, "submit_signed_intent", { ...first["submit"], signature: drained }))["code"]).toBe(
      "InsufficientFunds",
    );
    await send(w.owner, [
      getTransferInstruction({ source: w.ownerInput, destination: ownerInput, authority: w.owner, amount: 1_000n }),
    ]);
    await ok(relaying, "submit_signed_intent", { ...first["submit"], signature: drained });
    expect(await fail(relaying, "submit_signed_intent", { ...rival["submit"], signature: await sign(rival["message"]) })).toEqual({
      code: "NonceTaken",
      retryable: false,
      hint: "a different intent already uses this owner's nonce; these signed terms can never be submitted",
    });
  });

  it("counts and skips intents it cannot read instead of failing the whole list", async () => {
    const made = await createIntent();
    const account = h.svm.getAccount(made["intent"]);
    if (!account.exists) {
      throw new Error("intent missing");
    }
    const data = new Uint8Array(account.data);
    data.set(new Uint8Array(8).fill(0xff), 8 + 328);
    h.svm.setAccount({ ...account, data });
    await createIntent({ nonce: "1" });
    expect(await ok(client, "list_intents", { owner: w.owner.address })).toMatchObject({ unreadable: 1, intents: [{ nonce: "1" }] });
  });

  it("balances skip an unreadable intent", async () => {
    const broken = await createIntent();
    const account = h.svm.getAccount(broken["intent"]);
    if (!account.exists) {
      throw new Error("intent missing");
    }
    h.svm.setAccount({ ...account, data: new Uint8Array(account.data).slice(0, 40), space: 40n });
    await createIntent({ nonce: "1" });
    const read = await ok(client, "get_balances", { owner: w.owner.address, mints: [w.inputMint] });
    expect(read["unreadable"]).toBe(1);
    expect((read["tokens"] as Json[])[0]).toMatchObject({ mint: w.inputMint, escrowed: ESCROW.toString() });
  });

  it("refuses before the owner signs any terms its relayer could not fit in one transaction", async () => {
    const relayer = await funded();
    const owner = await funded();
    await ata(w.authority, owner.address, w.inputMint, 1_000n);
    const partner = { account: w.feeRecipient.address, bps: 50 };
    const priced = await connect(relayer, ["--relay-fee", `${w.inputMint}=25`, "--priority-fee", "1000"]);
    expect(await fail(priced, "prepare_signed_intent", swap({ owner: owner.address, partner }))).toEqual({
      code: "RelayTooLarge",
      retryable: false,
      hint: RELAY_TOO_LARGE,
    });
    const plain = await ok(priced, "prepare_signed_intent", swap({ owner: owner.address }));
    expect(plain["submit"]).toMatchObject({ relayer_fee: "25" });
    const unpriced = await connect(relayer, ["--relay-fee", `${w.inputMint}=25`]);
    expect(await ok(unpriced, "prepare_signed_intent", swap({ owner: owner.address, partner }))).toMatchObject({ nonce: expect.any(String) });
  });

  it("opens its own fee account in a separate transaction when the relay would not fit with it", async () => {
    const relayer = await funded();
    const owner = await funded();
    await ata(w.authority, owner.address, w.inputMint, 1_000n);
    const partner = { account: w.feeRecipient.address, bps: 50 };
    const relaying = await connect(relayer, ["--relay-fee", `${w.inputMint}=25`]);
    const p = await ok(relaying, "prepare_signed_intent", swap({ owner: owner.address, partner }));
    await execute(p["setup"], owner);
    const signature = getBase58Decoder().decode(await signBytes(owner.keyPair.privateKey, getBase64Encoder().encode(p["message"])));
    const fees = await findAssociatedTokenAddress({ owner: relayer.address, mint: w.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(exists(fees)).toBe(false);
    expect(await ok(relaying, "submit_signed_intent", { ...p["submit"], signature })).toMatchObject({ intent: p["intent"] });
    expect(balance(fees)).toBe(25n);
    expect(exists(p["intent"])).toBe(true);
  });

  it("charges its budget for its own fee account, and for a second transaction only when it has to split", async () => {
    const owner = await funded();
    await ata(w.authority, owner.address, w.inputMint, 1_000n);
    const base = createCost({ createFee: 0, crankBounty: 0 }) + rentFor(TOKEN_ACCOUNT_RENT_BYTES);
    const needed = async (extra: string[], nonce: string) => {
      const relayer = await funded();
      const signer = await connect(relayer, ["--relay-fee", `${w.inputMint}=25`, ...extra]);
      const p = await ok(signer, "prepare_signed_intent", swap({ owner: owner.address, nonce }));
      await execute(p["setup"], owner);
      const signature = getBase58Decoder().decode(await signBytes(owner.keyPair.privateKey, getBase64Encoder().encode(p["message"])));
      const broke = await connect(relayer, ["--relay-fee", `${w.inputMint}=25`, "--relay-hourly-lamports", "1", ...extra]);
      const refused = await fail(broke, "submit_signed_intent", { ...p["submit"], signature });
      expect(refused["code"]).toBe("BudgetExhausted");
      return BigInt(/this needs (\d+)$/.exec(refused["hint"] as string)?.[1] ?? "0");
    };
    expect(await needed([], "40")).toBe(base);
    const split = await needed(["--priority-fee", "1000", "--relay-max-lamports", "100000"], "41");
    expect(split - base - SIGNATURE_FEE).toBeGreaterThan(0n);
    expect((split - base - SIGNATURE_FEE) % 2n).toBe(0n);
  });

  it("lets nobody hold more than a few of an owner's nonces with signed intents that are never signed", async () => {
    const relayer = await funded();
    const relaying = await connect(relayer, free());
    const owner = await funded();
    await ata(w.authority, owner.address, w.inputMint, 1_000n);
    const nonces = [];
    for (let i = 0; i < MAX_PENDING_PER_OWNER; i++) {
      nonces.push((await ok(relaying, "prepare_signed_intent", swap({ owner: owner.address })))["nonce"]);
    }
    expect(nonces).toEqual(Array.from({ length: MAX_PENDING_PER_OWNER }, (_, i) => i.toString()));
    expect(await fail(relaying, "prepare_signed_intent", swap({ owner: owner.address }))).toEqual({
      code: "TooManyPending",
      retryable: true,
      hint: `${owner.address} already has ${MAX_PENDING_PER_OWNER} prepared requests waiting; submit some or let them expire (a signed intent holds its nonce until its submit_by), then ask again`,
    });
    expect((await ok(relaying, "prepare_signed_intent", swap({ owner: w.owner.address })))["nonce"]).toBe("0");
  });

  it("gives back the budget and the owner's hourly slot when a relay it admitted is never delivered", async () => {
    const owner = await funded();
    await ata(w.authority, owner.address, w.inputMint, 1_000n);
    const relayer = await funded();
    const cost = createCost({ createFee: 0, crankBounty: 0 });
    const limits = [...free(), "--relay-per-hour", "1", "--relay-hourly-lamports", cost.toString()];
    const relaying = await connect(relayer, limits);
    const p = await ok(relaying, "prepare_signed_intent", swap({ owner: owner.address }));
    await execute(p["setup"], owner);
    const signature = getBase58Decoder().decode(await signBytes(owner.keyPair.privateKey, getBase64Encoder().encode(p["message"])));
    const delivered = transport.send;
    transport.send = async () => {
      throw new Error("the node dropped the transaction");
    };
    try {
      expect(await fail(relaying, "submit_signed_intent", { ...p["submit"], signature })).toEqual({
        code: "Failed",
        retryable: false,
        hint: "the node dropped the transaction",
      });
    } finally {
      transport.send = delivered;
    }
    expect(exists(p["intent"])).toBe(false);
    expect(await ok(relaying, "submit_signed_intent", { ...p["submit"], signature })).toMatchObject({ intent: p["intent"] });
    expect(exists(p["intent"])).toBe(true);
    const second = await ok(relaying, "prepare_signed_intent", swap({ owner: owner.address }));
    await execute(second["setup"], owner);
    const again = getBase58Decoder().decode(await signBytes(owner.keyPair.privateKey, getBase64Encoder().encode(second["message"])));
    expect((await fail(relaying, "submit_signed_intent", { ...second["submit"], signature: again }))["code"]).toBe("RelayRateLimited");
  });

  it("keeps the budget and the owner's hourly slot when a relay may already have been paid for", async () => {
    const owner = await funded();
    await ata(w.authority, owner.address, w.inputMint, 1_000n);
    const relayer = await funded();
    const relaying = await connect(relayer, [...free(), "--relay-per-hour", "1"]);
    const p = await ok(relaying, "prepare_signed_intent", swap({ owner: owner.address }));
    await execute(p["setup"], owner);
    const signature = getBase58Decoder().decode(await signBytes(owner.keyPair.privateKey, getBase64Encoder().encode(p["message"])));
    const delivered = transport.send;
    transport.send = async () => {
      throw new Charged("transaction landed and failed");
    };
    try {
      expect((await fail(relaying, "submit_signed_intent", { ...p["submit"], signature }))["code"]).toBe("Failed");
    } finally {
      transport.send = delivered;
    }
    expect((await fail(relaying, "submit_signed_intent", { ...p["submit"], signature }))["code"]).toBe("RelayRateLimited");
  });

  it("relays only the tokens its operator priced, so nobody can make it pay for intents in a throwaway token", async () => {
    const relayer = await funded();
    const owner = await funded();
    await ata(w.authority, owner.address, w.inputMint, 1_000n);
    const priced = await connect(relayer, free());
    const p = await ok(priced, "prepare_signed_intent", swap({ owner: owner.address }));
    await execute(p["setup"], owner);
    const signature = getBase58Decoder().decode(await signBytes(owner.keyPair.privateKey, getBase64Encoder().encode(p["message"])));
    const elsewhere = await connect(relayer, ["--relay-fee", `${w.outputMint}=0`]);
    const refusal = {
      code: "RelayMintNotAccepted",
      retryable: false,
      hint: `this server's relayer does not relay intents selling ${w.inputMint}; it relays only ${w.outputMint}`,
    };
    expect(await fail(elsewhere, "prepare_signed_intent", swap({ owner: owner.address }))).toEqual(refusal);
    expect(await fail(elsewhere, "submit_signed_intent", { ...p["submit"], signature })).toEqual(refusal);
    expect(await ok(priced, "submit_signed_intent", { ...p["submit"], signature })).toMatchObject({ intent: p["intent"] });
  });

  it("relays only within the relayer's cost, expiry and rate limits", async () => {
    const relayer = await funded();
    const owner = await funded();
    await ata(w.authority, owner.address, w.inputMint, 1_000n);
    const small = { kind: "swap", amount_in: "10", min_out: "1" };
    const signedBy = async (server: Client, nonce: string, over: object = {}) => {
      const p = await ok(server, "prepare_signed_intent", { ...swap({ owner: owner.address, order: small, nonce }), ...over });
      await execute(p["setup"], owner);
      const signature = getBase58Decoder().decode(await signBytes(owner.keyPair.privateKey, getBase64Encoder().encode(p["message"])));
      return { ...p["submit"], signature };
    };
    const strict = await connect(relayer, [...free(), "--relay-max-ttl", "3600", "--relay-per-hour", "1"]);
    const lax = await connect(relayer, [...free(), "--relay-max-lamports", "10000"]);
    expect(await fail(strict, "submit_signed_intent", await signedBy(lax, "0", { expires_in: 3_601 }))).toMatchObject({
      code: "RelayTooLong",
    });
    await ok(strict, "submit_signed_intent", await signedBy(strict, "1"));
    const limited = await signedBy(strict, "2");
    expect(await fail(strict, "submit_signed_intent", limited)).toMatchObject({ code: "RelayRateLimited", retryable: true });
    setNow(NOW + 3_600n);
    await ok(strict, "submit_signed_intent", await signedBy(strict, "4"));
    await cli(["set-economics", "--keypair", "a.json", "--yes", "--bounty", "6000", "--create-fee", "4000"], { "a.json": w.authority });
    const costly = await signedBy(lax, "3");
    expect(await fail(strict, "submit_signed_intent", costly)).toEqual({
      code: "RelayTooCostly",
      retryable: false,
      hint: "relaying this intent costs 10000 lamports in create fee, crank bounty and priority fee; this relayer pays at most 0",
    });
    const before = h.svm.getBalance(relayer.address) ?? 0n;
    await ok(lax, "submit_signed_intent", costly);
    expect(before - (h.svm.getBalance(relayer.address) ?? 0n)).toBeGreaterThan(10_000n);
  });

  it("prepare signed intent refuses an expiry beyond the relayer ttl", async () => {
    const relayer = await funded();
    const owner = await funded();
    await ata(w.authority, owner.address, w.inputMint, 1_000n);
    const strict = await connect(relayer, [...free(), "--relay-max-ttl", "3600"]);
    expect(await fail(strict, "prepare_signed_intent", swap({ owner: owner.address, expires_in: 3_601 }))).toEqual({
      code: "RelayTooLong",
      retryable: false,
      hint: "this relayer only relays intents that expire within 3600 seconds; sign one with an earlier expiry",
    });
    expect(await ok(strict, "prepare_signed_intent", swap({ owner: owner.address, expires_in: 3_600 }))).toMatchObject({ nonce: "0" });
  });

  it("prepare signed intent refuses terms beyond the relayer lamports", async () => {
    const relayer = await funded();
    const owner = await funded();
    await ata(w.authority, owner.address, w.inputMint, 1_000n);
    await cli(["set-economics", "--keypair", "a.json", "--yes", "--bounty", "6000", "--create-fee", "4000"], { "a.json": w.authority });
    const cheap = await connect(relayer, [...free(), "--relay-max-lamports", "9999"]);
    expect(await fail(cheap, "prepare_signed_intent", swap({ owner: owner.address }))).toEqual({
      code: "RelayTooCostly",
      retryable: false,
      hint: "relaying this intent costs at least 10000 lamports in create fee and crank bounty before any priority fee; this relayer pays at most 9999",
    });
    const enough = await connect(relayer, [...free(), "--relay-max-lamports", "10000"]);
    expect(await ok(enough, "prepare_signed_intent", swap({ owner: owner.address }))).toMatchObject({ nonce: "0" });
  });

  it("checks every result against its declared schema and turns bugs into problems", async () => {
    const lying = define({
      name: "lying",
      title: "t",
      description: "d",
      effect: "read",
      input: object({}),
      output: object({ n: amount() }),
      run: async () => ({ n: 5 }),
    });
    const ctx = { transport, relay: undefined, agent: undefined, claims: claimsOf() };
    const outcome = await invoke(lying, ctx, undefined);
    expect(outcome).toEqual({
      ok: false,
      problem: {
        code: "Failed",
        retryable: false,
        hint: "lying produced output outside its schema: n: must be a whole number of raw token units written as a decimal string",
      },
    });
    expect(new OutputMismatch("x", new InvalidInput([])).name).toBe("OutputMismatch");
    const exploding = define({ ...lying, output: object({}), run: async () => Promise.reject(new TypeError("boom")) });
    expect(await invoke(exploding, ctx, {})).toEqual({ ok: false, problem: { code: "Failed", retryable: false, hint: "boom" } });
    const throwingSchema = define({
      ...lying,
      output: { json: {}, read: () => { throw new RangeError("schema bug"); } },
      run: async () => ({}),
    });
    expect(await invoke(throwingSchema, ctx, {})).toEqual({ ok: false, problem: { code: "Failed", retryable: false, hint: "schema bug" } });
    expect(toJson({ a: [1n, { b: 2n }], c: null, d: "x", e: true })).toEqual({ a: ["1", { b: "2" }], c: null, d: "x", e: true });
  });
});

describe("tool annotations", () => {
  it("submit tools that move value are destructive", () => {
    const hinted = [...WALLET_ACTIONS, ...ACTIONS].map((action) => ({ name: action.name, effect: action.effect, ...annotationsOf(action) }));
    expect(hinted.filter((a) => a.destructiveHint).map((a) => a.name).sort()).toEqual(
      [
        "solive_agent_create",
        "solive_submit_signed_intent",
        "solive_wallet_attest",
        "solive_wallet_attest_split",
        "solive_wallet_auction",
        "solive_wallet_cancel",
        "solive_wallet_claim",
        "solive_wallet_profile",
        "solive_wallet_committee_release",
        "solive_wallet_committee_vote",
        "solive_wallet_deliver",
        "solive_wallet_escrow",
        "solive_wallet_escrow_plan",
        "solive_wallet_recurring",
        "solive_wallet_swap",
      ].sort(),
    );
    expect(hinted.filter((a) => a.effect === "prepare").every((a) => !a.readOnlyHint && !a.destructiveHint)).toBe(true);
    expect(hinted.filter((a) => a.effect === "read").every((a) => a.readOnlyHint && !a.destructiveHint)).toBe(true);
    expect(hinted.find((a) => a.name === "solive_wallet_setup")).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });
});
