import { type Address, generateKeyPairSigner } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it } from "vitest";
import { findAssociatedTokenAddress, splitFees } from "@intent-engine/core";
import { findIntentPda, INTENT_VERSION, WARN_ATTESTOR, WARN_LONG_LIVED } from "@intent-engine/core/internal";
import {
  EXTENDED_MINT_TYPE,
  EXTENDED_TYPE_OFFSET,
  EXTENSIONS_OFFSET,
  MINT_BASE_SIZE,
  mintOf,
  scalesDisplay,
  SCALING_EXTENSIONS,
} from "@intent-engine/client/internal";
import { ENGINE_PROBLEMS } from "../src/agent/problems.js";
import { ata, balance, cli, ESCROW, FEE_BPS, funded, h, NOW, transport, type World } from "./harness.js";
import { createIntentOf, exists, execute, fail, type Json, ok, served, swapOf } from "./agent-kit.js";

describe("agent server against the deployed engine", () => {
  let w: World;
  let client: Client;

  const swap = (over: object = {}) => swapOf(w, over);

  const createIntent = async (over: object = {}, owner = w.owner) => createIntentOf(client, w, over, owner);

  beforeEach(async () => {
    ({ w, client } = await served());
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
      `Expires: ${new Date(Number(NOW + 3_600n) * 1000).toISOString()}, 1 hour from now`,
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

  it("refuses to read an intent of an unknown version instead of inventing its terms", async () => {
    const made = await createIntent();
    const account = h.svm.getAccount(made["intent"]);
    if (!account.exists) {
      throw new Error("intent missing");
    }
    const data = new Uint8Array(account.data);
    data[8 + 164] = INTENT_VERSION + 1;
    data[8 + 161] = 9;
    h.svm.setAccount({ ...account, data });
    expect(await fail(client, "get_intent", { owner: w.owner.address, nonce: "0" })).toMatchObject({
      code: "AccountOutdated",
      retryable: false,
      hint: `this intent account is of version ${INTENT_VERSION + 1}; this SDK reads intent versions 1 to ${INTENT_VERSION} only. Close it with intent-engine close-legacy`,
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
    expect(await mintOf(transport, await plant(base))).toEqual({ tokenProgram: TOKEN_PROGRAM_ADDRESS, decimals: 6, scaled: false, freezeAuthority: null });
    const extended = new Uint8Array(170);
    extended.set(base);
    extended[165] = 1;
    expect(await mintOf(transport, await plant(extended, T22))).toEqual({ tokenProgram: T22, decimals: 6, scaled: false, freezeAuthority: null });
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
});
