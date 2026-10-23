import {
  type Address,
  generateKeyPairSigner,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  lamports,
  none,
} from "@solana/kit";
import { AccountState, getMintEncoder, getMintSize, getTokenEncoder, getTokenSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import {
  DEVNET_TEST_MINT,
  EVENT_IX_TAG,
  findAssociatedTokenAddress,
  findIntentPda,
  formatAmount,
  getCreateIntentInstructionDataEncoder,
  getIntentAttestedEventEncoder,
  getIntentCreatedEventEncoder,
  getIntentDecoder,
  getIntentEncoder,
  IntentStatus,
  NATIVE_MINT,
  openingMemo,
  releaseMemo,
  splitFee,
} from "@intent-engine/core";
import { commitmentOf, type EngineTransaction, MEMO_PROGRAM_ADDRESS, saltCheckOf, signersAmong } from "@intent-engine/client";
import { tool } from "../src/agent/names.js";
import { LANDING_SECONDS, PAID_WRAPPED, RECEIPT_PARTIAL, WALLET_NOTICE } from "../src/agent/wallet.js";
import { EXIT_OK } from "../src/main.js";
import { LAMPORTS_PER_SOL } from "../src/wallet.js";
import { saltFor, sealedDelivery } from "./announce.js";
import { balance, cli, creation, FEE_BPS, h, NOW, world } from "./harness.js";

type Json = Record<string, unknown> & { [key: string]: any };

const URL_OF_WORK = "https://" + "example.org/work";

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

function tokenAccountAt(address: Address, holder: Address): void {
  const space = BigInt(getTokenSize());
  h.svm.setAccount({
    address,
    data: Uint8Array.from(
      getTokenEncoder().encode({ mint: NATIVE_MINT, owner: holder, amount: 0n, delegate: none(), state: AccountState.Initialized, isNative: none(), delegatedAmount: 0n, closeAuthority: none() }),
    ),
    executable: false,
    lamports: lamports(h.svm.minimumBalanceForRentExemption(space)),
    programAddress: TOKEN_PROGRAM_ADDRESS,
    space,
  });
}

function landedAs(wire: string, slot: bigint): EngineTransaction {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
  const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const keys = message.staticAccounts;
  const memos = ("instructions" in message ? message.instructions : []).filter((ix) => keys[ix.programAddressIndex] === MEMO_PROGRAM_ADDRESS);
  return {
    signature: getSignatureFromTransaction(tx),
    slot,
    blockTime: null,
    failed: false,
    emitted: [],
    memos: memos.map((ix) => new TextDecoder().decode(Uint8Array.from(ix.data ?? []))),
    memoSigners: memos.map((ix) => signersAmong(keys, ix.accountIndices ?? [], message.header.numSignerAccounts)),
    ...(keys[0] === undefined ? {} : { feePayer: keys[0] }),
  };
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

async function ok(client: Client, name: string, args: object = {}): Promise<Json> {
  const result = await client.callTool({ name: tool(name), arguments: args as Record<string, unknown> });
  expect(result.isError === true, JSON.stringify(result.structuredContent)).toBe(false);
  return result.structuredContent as Json;
}

async function setUp() {
  const w = await world();
  h.files.clear();
  preset(NATIVE_MINT);
  preset(DEVNET_TEST_MINT);
  const client = await connect();
  const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
  h.watched.push(wallet);
  h.engineLog = [];
  return { w, client, wallet };
}

async function proofEscrow(client: Client, wallet: Address, hint: string) {
  const escrow = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: wallet, spec_hash: hint.repeat(32), send: true });
  return { intent: escrow["intent"] as Address, nonce: escrow["nonce"] as string };
}

const sealedAt = async (intent: Address, wallet: Address, signature: string, slot: bigint, sha256: string, feePayer: Address): Promise<EngineTransaction> => ({
  signature,
  slot,
  blockTime: null,
  failed: false,
  emitted: [],
  memos: [await sealedDelivery(intent, feePayer, sha256, URL_OF_WORK, [wallet])],
  feePayer,
});

const tag = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);

function createdFrom(intent: Address): EngineTransaction {
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
    emitted: [tag(event)],
    called: [Uint8Array.from(getCreateIntentInstructionDataEncoder().encode({ args }))],
    calledAccounts: [[escrow.owner, escrow.owner, escrow.owner, intent]],
    feePayer: escrow.owner,
  };
}

const attestedTo = (intent: Address, wallet: Address, payee: Address) => {
  const { fee, net } = splitFee(LAMPORTS_PER_SOL / 20n, FEE_BPS);
  return tag(
    getIntentAttestedEventEncoder().encode({
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
    }),
  );
};

describe("a wallet release of a partner's escrow", () => {
  it("signs a fee bound that covers the partner, creates the partner's account and records no work", async () => {
    const { w, client, wallet } = await setUp();
    const partner = (await generateKeyPairSigner()).address;
    const worker = (await generateKeyPairSigner()).address;
    const terms = ["--units", "raw", "--amount-in", "1000", "--min-result", "1", "--max-result", "1", "--attestor", wallet, "--partner", partner, "--partner-bps", "50", "--nonce", "0"];
    const made = await cli(["create", "attested", "--keypair", "owner.json", "--input-mint", w.inputMint, "--output-mint", w.outputMint, "--expires-in", "3600", ...terms, "--yes"], { "owner.json": w.owner });
    expect([made.code, made.err]).toEqual([EXIT_OK, ""]);
    const release = { owner: w.owner.address, nonce: "0", pay_to: worker };
    const shown = await ok(client, "wallet_attest", release);
    expect(shown["summary"]).toContain(`Setup: creates the partner ${partner}'s ${w.inputMint} account for its fee, paid by this wallet: ${formatAmount(h.svm.minimumBalanceForRentExemption(165n), 9)} SOL of rent`);
    expect((shown["summary"] as string[]).filter((line) => line.startsWith("Records:"))).toEqual([]);
    expect(await ok(client, "wallet_attest", { ...release, approval: shown["approval"], send: true })).toMatchObject({ sent: true });
    expect(balance(await findAssociatedTokenAddress({ owner: partner, mint: w.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))).toBe(5n);
    expect(balance(await findAssociatedTokenAddress({ owner: worker, mint: w.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))).toBeGreaterThan(0n);
  });
});

describe("the openings after a release and the deliveries it shows", () => {
  it("names no skipped work, keeps no empty signature list when the opening fails, and lists the opened salt and the release", async () => {
    const { client, wallet } = await setUp();
    const { intent, nonce } = await proofEscrow(client, wallet, "71");
    const worker = (await generateKeyPairSigner()).address;
    const other = (await generateKeyPairSigner()).address;
    const work = "e1".repeat(32);
    const first = await sealedAt(intent, wallet, "first", 5n, work, worker);
    const earlier = await sealedAt(intent, wallet, "other", 3n, "e2".repeat(32), other);
    h.engineLog = [first, earlier, creation(intent)];
    const release = { owner: wallet, nonce, pay_to: worker, delivered_sha256: work };
    const shown = await ok(client, "wallet_attest", release);
    expect(shown).not.toHaveProperty("skipped");
    h.sendFails = { error: new Error("blockhash not found"), landed: false, after: 1 };
    const sent = await ok(client, "wallet_attest", { ...release, approval: shown["approval"], send: true });
    expect(sent).toMatchObject({ sent: true, opening_memos: [openingMemo({ intent, salts: [saltFor(intent)] })] });
    expect(sent).not.toHaveProperty("opening_signatures");
    expect(sent).not.toHaveProperty("skipped");

    const payee = await findAssociatedTokenAddress({ owner: worker, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const released: EngineTransaction = {
      signature: "released",
      slot: 7n,
      blockTime: null,
      failed: false,
      emitted: [attestedTo(intent, wallet, payee)],
      memos: [releaseMemo(work, saltFor(intent))],
      memoSigners: [[wallet]],
      feePayer: wallet,
      tokens: [{ account: payee, mint: NATIVE_MINT, owner: worker }],
    };
    const opening: EngineTransaction = { signature: "opening", slot: 8n, blockTime: null, failed: false, emitted: [], memos: [openingMemo({ intent, salts: [saltFor(intent)] })], feePayer: wallet };
    h.engineLog = [opening, released, first, earlier, creation(intent)];
    const check = saltCheckOf(saltFor(intent));
    const listed = await ok(client, "wallet_check_delivery", { intent });
    expect(listed["deliveries"]).toEqual([
      { worker: other, commitment: commitmentOf(intent, other, saltFor(intent), "e2".repeat(32)), check, signature: "other", slot: "3", url: URL_OF_WORK, opened_salt: saltFor(intent) },
      { worker, commitment: commitmentOf(intent, worker, saltFor(intent), work), check, signature: "first", slot: "5", url: URL_OF_WORK, opened_salt: saltFor(intent) },
    ]);
    expect(listed["release"]).toStrictEqual({ signature: "released", sha256: work, valid: true });
  });

  it("tells a worker its own announcement is not the earliest once an earlier one of the same work is opened", async () => {
    const { client, wallet } = await setUp();
    const { intent } = await proofEscrow(client, wallet, "72");
    const work = "e3".repeat(32);
    h.wires.length = 0;
    await ok(client, "wallet_deliver", { intent, sha256: work, url: URL_OF_WORK, send: true });
    const own = landedAs(h.wires[0] as string, 9n);
    const rival = (await generateKeyPairSigner()).address;
    const opening: EngineTransaction = { signature: "opening", slot: 4n, blockTime: null, failed: false, emitted: [], memos: [openingMemo({ intent, salts: [saltFor(intent)] })], feePayer: rival };
    h.engineLog = [own, opening, await sealedAt(intent, wallet, "rival", 3n, work, rival), creation(intent)];
    const checked = await ok(client, "wallet_check_delivery", { intent, sha256: work });
    expect(checked["own"]).toMatchObject({ landed: true, earliest: false, signature: own.signature });
  });
});

describe("a receipt paid in wrapped SOL to this wallet", () => {
  it("keeps the receipt's own next step before the unwrap hint", async () => {
    const { client, wallet } = await setUp();
    const { intent, nonce } = await proofEscrow(client, wallet, "73");
    const held = h.svm.getAccount(intent);
    if (!held.exists) {
      throw new Error("the escrow was not created");
    }
    h.svm.setAccount({ ...held, data: Uint8Array.from(getIntentEncoder().encode({ ...getIntentDecoder().decode(held.data), status: IntentStatus.Filled })) });
    const payee = (await generateKeyPairSigner()).address;
    tokenAccountAt(payee, wallet);
    const release: EngineTransaction = {
      signature: "6".repeat(87) + "d",
      slot: 3n,
      blockTime: null,
      failed: false,
      emitted: [attestedTo(intent, wallet, payee)],
      feePayer: wallet,
      tokens: [{ account: payee, mint: NATIVE_MINT, owner: wallet }],
    };
    const lagging = { signature: "5".repeat(87) + "e", slot: 4n, blockTime: null, failed: false, emitted: [], unread: true as const };
    h.engineLog = [lagging, release, createdFrom(intent)];
    const paid = await ok(client, "wallet_receipt", { nonce });
    expect(paid).toMatchObject({ released: true, paid_to: wallet, mint: NATIVE_MINT, complete: false });
    expect(paid["next"]).toBe(`${RECEIPT_PARTIAL}; ${PAID_WRAPPED}`);
  });
});

describe("wallet_escrow terms", () => {
  it("expires the escrow the given seconds after it lands, nets the judge fee out of the payee's share and pre-checks the spec only on a preview", async () => {
    const { client, wallet } = await setUp();
    const spec = "the spec\n";
    const url = "https://" + "example.org/spec.md";
    h.specPages.set(url, new TextEncoder().encode(spec));
    const shown = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: wallet, spec_hash: "aa".repeat(32), spec_url: url, judge_fee: "0.001" });
    expect((shown["warnings"] as string[]).some((line) => line.includes("hashes to"))).toBe(true);
    const { net } = splitFee(LAMPORTS_PER_SOL / 20n - LAMPORTS_PER_SOL / 1_000n, FEE_BPS);
    expect(shown["summary"]).toContain(`Payee receives: ${formatAmount(net, 9)}, after the ${FEE_BPS / 100}% protocol fee at today's config`);
    const sent = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: wallet, spec_hash: "aa".repeat(32), spec_url: url, expires_in: 600, send: true });
    expect((sent["warnings"] as string[]).some((line) => line.includes("hashes to"))).toBe(false);
    const held = h.svm.getAccount(sent["intent"] as Address);
    expect(held.exists && getIntentDecoder().decode(held.data).expiresAt).toBe(NOW + 600n + BigInt(LANDING_SECONDS));
  });
});

describe("wallet_history", () => {
  it("reads the history of each of the wallet's nonces from the newest down, and of no nonce past it", async () => {
    const { client, wallet } = await setUp();
    const made: Address[] = [];
    for (const hint of ["74", "75"]) {
      made.push((await proofEscrow(client, wallet, hint)).intent);
    }
    h.requestedOf.length = 0;
    const listed = await ok(client, "wallet_history");
    expect(listed["activity"]).toHaveLength(0);
    expect(h.requestedOf.filter((of) => of !== undefined)).toEqual([made[1], made[0], wallet]);
    const [next] = await findIntentPda({ owner: wallet, nonce: 2n });
    expect(h.requestedOf).not.toContain(next);
  });
});
