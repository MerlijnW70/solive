import { claimsOf } from "../src/agent/claims.js";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import { type AddressInfo, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AccountRole,
  createAddressWithSeed,
  type Address,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  createKeyPairSignerFromPrivateKeyBytes,
  generateKeyPairSigner,
  getBase58Decoder,
  getAddressEncoder,
  type KeyPairSigner,
  lamports,
} from "@solana/kit";
import {
  AccountState,
  getTokenEncoder,
  getCloseAccountInstruction,
  getMintToInstruction,
  getApproveInstruction,
  getTransferCheckedInstruction,
  getTransferInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  findAssociatedTokenAddress,
  findConfigPda,
  getConfigDecoder,
  EVENT_IX_TAG,
  findIntentPda,
  findUserStatePda,
  getUserStateDecoder,
  getPauseRaisedEventEncoder,
  getUserInitializedEventEncoder,
  findVaultPda,
  type Intent,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  splitFee,
  splitFees,
} from "@intent-engine/core";
import { agentServer } from "../src/agent/mcp.js";
import { ACTIONS } from "../src/agent/registry.js";
import { UsageError } from "../src/args.js";
import {
  crankAction,
  IMMUTABLE_OWNER,
  refundable,
  refundSeed,
  configExists,
  ENV_JUPITER_KEY,
  JUPITER_DOMAIN,
  jupiterHost,
  lostRaces,
  run,
  SOLVER_TABLE_NEXT,
  STATUS,
  TOKEN_ACCOUNT_BYTES,
  UNFUNDED,
} from "../src/commands.js";
import { rentFor } from "../src/agent/budget.js";
import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  FETCH_TIMEOUT_MS,
  KEYPAIR_EXPOSED,
  KEYPAIR_UNREADABLE,
  loadKeypairFile,
  nodeRuntime,
  render,
  runProcess,
} from "../src/main.js";
import { COMPUTE_BUDGET_ADDRESS, JITO_TIP_ACCOUNTS, MAX_COMPUTE_UNITS, SIMULATION_REFUSED } from "@intent-engine/solver";
import { costlyFunding, FUNDING_RENT } from "../src/crank.js";
import {
  ata,
  balance,
  boot,
  cli,
  DOMAIN,
  ESCROW,
  FEE_BPS,
  funded,
  h,
  mint,
  NOW,
  runtime,
  send,
  transport,
  world,
} from "./harness.js";

type Json = Record<string, unknown>;

function unitLimitOf(wire: string): number | null {
  const message = getCompiledTransactionMessageDecoder().decode(
    getTransactionDecoder().decode(getBase64Encoder().encode(wire)).messageBytes,
  );
  const budget = message.staticAccounts.indexOf(COMPUTE_BUDGET_ADDRESS);
  const instructions = "instructions" in message ? message.instructions : [];
  const set = instructions.find((ix) => ix.programAddressIndex === budget && ix.data?.[0] === 2);
  return set?.data === undefined ? null : new DataView(set.data.buffer, set.data.byteOffset).getUint32(1, true);
}

describe("cli against the deployed engine", () => {
  let authority: KeyPairSigner;
  let feeRecipient: KeyPairSigner;
  let owner: KeyPairSigner;
  let inputMint: Address;
  let outputMint: Address;
  let ownerInput: Address;

  beforeEach(async () => {
    ({ authority, feeRecipient, owner, inputMint, outputMint, ownerInput } = await world());
  });

  const create = (nonce: string, expiresAt: bigint) => [
    "create",
    "swap",
    "--keypair",
    "owner.json",
    "--nonce",
    nonce,
    "--input-mint",
    inputMint,
    "--output-mint",
    outputMint,
    "--expires-at",
    expiresAt.toString(),
    "--amount-in",
    ESCROW.toString(),
    "--min-out",
    "300",
    "--units",
    "raw",
    "--url",
    "http://cluster",
    "--yes",
  ];

  it("creates an intent, initialising the user on first use, then shows and quotes it", async () => {
    const created = await cli(create("7", NOW + 3_600n), { "owner.json": owner });
    expect(created.err).toBe("");
    expect(created.code).toBe(EXIT_OK);
    const [intent] = await findIntentPda({ owner: owner.address, nonce: 7n });
    expect(created.json()["intent"]).toBe(intent);
    expect(created.json()).toMatchObject({ sent: true, nonce: "7", escrow: ESCROW.toString() });
    expect(created.json()["signatures"]).toHaveLength(1);
    expect(h.urls).toEqual(["http://cluster"]);
    expect(balance(ownerInput)).toBe(1_000n - ESCROW);
    expect((await cli(create("8", NOW + 3_600n), { "owner.json": owner })).code).toBe(EXIT_OK);

    const shown = (await cli(["show", "intent", "--owner", owner.address, "--nonce", "7"], {})).json();
    expect(shown).toMatchObject({
      address: intent,
      owner: owner.address,
      inputMint,
      outputMint,
      rentPayer: owner.address,
      nonce: "7",
      escrowed: ESCROW.toString(),
      createdAt: NOW.toString(),
      expiresAt: (NOW + 3_600n).toString(),
      status: "open",
      version: 1,
      flags: 0,
      filled: "0",
      revision: 0,
      params: { kind: "SwapExactIn", amountIn: ESCROW.toString(), minOut: "300" },
    });

    const { protocol, net } = splitFees(ESCROW, FEE_BPS, 0, 0);
    expect((await cli(["quote", "--owner", owner.address, "--nonce", "7"], {})).json()).toEqual({
      address: intent,
      at: (NOW + 1_000n).toString(),
      amountIn: ESCROW.toString(),
      requiredOut: "300",
      feeBps: FEE_BPS,
      partnerBps: 0,
      protocolFee: protocol.toString(),
      partnerFee: "0",
      net: net.toString(),
    });
    expect((await cli(["quote", "--owner", owner.address, "--nonce", "7", "--at", "5"], {})).json()["at"]).toBe("5");

    const config = (await cli(["show", "config"], {})).json();
    expect(config).toMatchObject({ feeBps: FEE_BPS, feeRecipient: feeRecipient.address, domainMatchesCluster: true });
    expect((await cli(["domain"], {})).json()).toEqual({ genesisHash: h.genesis, domain: "11".repeat(32) });
    h.genesis = getBase58Decoder().decode(new Uint8Array(32).fill(0x12));
    expect((await cli(["show", "config"], {})).json()["domainMatchesCluster"]).toBe(false);
    h.genesis = getBase58Decoder().decode(new Uint8Array(31).fill(0x11));
    expect((await cli(["show", "config"], {})).json()["domainMatchesCluster"]).toBe(false);
    h.genesis = getBase58Decoder().decode(DOMAIN);
  });

  it("cancels and closes an intent, returning escrow and rent", async () => {
    await cli(create("1", NOW + 3_600n), { "owner.json": owner });
    const cancelled = await cli(["cancel", "--keypair", "owner.json", "--nonce", "1"], { "owner.json": owner });
    expect(cancelled.code).toBe(EXIT_OK);
    expect(balance(ownerInput)).toBe(1_000n);
    expect((await cli(["show", "intent", "--owner", owner.address, "--nonce", "1"], {})).json()["status"]).toBe("cancelled");
    const cranker = await funded();
    const closed = await cli(["close", "--keypair", "c.json", "--owner", owner.address, "--nonce", "1"], {
      "c.json": cranker,
    });
    expect(closed.code).toBe(EXIT_OK);
    const [intent] = await findIntentPda({ owner: owner.address, nonce: 1n });
    expect(h.svm.getAccount(intent).exists).toBe(false);
  });

  it("expires an intent once its deadline passes", async () => {
    await cli(create("2", NOW + 10n), { "owner.json": owner });
    const cranker = await funded();
    const args = ["expire", "--keypair", "c.json", "--owner", owner.address, "--nonce", "2"];
    const early = await cli(args, { "c.json": cranker });
    expect(early.code).toBe(EXIT_FAILED);
    const clock = h.svm.getClock();
    clock.unixTimestamp = NOW + 10n;
    h.svm.setClock(clock);
    expect((await cli(args, { "c.json": cranker })).code).toBe(EXIT_OK);
    expect(balance(ownerInput)).toBe(1_000n);
    expect((await cli(["show", "intent", "--owner", owner.address, "--nonce", "2"], {})).json()["status"]).toBe("expired");
  });

  it("recreates a missing canonical account only when expire or close has something to refund", async () => {
    const drainAndClose = async () => {
      const held = balance(ownerInput);
      const sink = await ata(authority, (await generateKeyPairSigner()).address, inputMint);
      await send(owner, [
        ...(held > 0n
          ? [getTransferInstruction({ source: ownerInput, destination: sink, authority: owner, amount: held })]
          : []),
        getCloseAccountInstruction({ account: ownerInput, destination: owner.address, owner }),
      ]);
      expect(h.svm.getAccount(ownerInput).exists).toBe(false);
    };
    const cranker = await funded();
    await cli(create("6", NOW + 10n), { "owner.json": owner });
    await cli(create("8", NOW + 3_600n), { "owner.json": owner });
    expect((await cli(["cancel", "--keypair", "owner.json", "--nonce", "8"], { "owner.json": owner })).code).toBe(
      EXIT_OK,
    );
    await drainAndClose();
    const clock = h.svm.getClock();
    clock.unixTimestamp = NOW + 10n;
    h.svm.setClock(clock);
    const expireArgs = ["expire", "--keypair", "c.json", "--owner", owner.address, "--nonce", "6"];
    expect((await cli(expireArgs, { "c.json": cranker })).code).toBe(EXIT_OK);
    expect(balance(ownerInput)).toBe(ESCROW);
    await drainAndClose();
    const [intent6] = await findIntentPda({ owner: owner.address, nonce: 6n });
    const [vault6] = await findVaultPda({ intent: intent6 });
    await send(authority, [getMintToInstruction({ mint: inputMint, token: vault6, mintAuthority: authority, amount: 5n })]);
    const close6 = ["close", "--keypair", "c.json", "--owner", owner.address, "--nonce", "6"];
    expect((await cli(close6, { "c.json": cranker })).code).toBe(EXIT_OK);
    expect(balance(ownerInput)).toBe(5n);
    await drainAndClose();
    const close8 = ["close", "--keypair", "c.json", "--owner", owner.address, "--nonce", "8"];
    expect((await cli(close8, { "c.json": cranker })).code).toBe(EXIT_OK);
    expect(h.svm.getAccount(ownerInput).exists).toBe(false);
  });

  it("initialises config with the cluster's own domain and drives the pause from the CLI", async () => {
    const admin = await boot();
    const guardian = await funded();
    const fresh = getBase58Decoder().decode(new Uint8Array(32).fill(0x2a));
    h.genesis = fresh;
    const terms = ["--guardian", guardian.address, "--fee-recipient", feeRecipient.address, "--fee-bps", "7", "--kinds", "swap,limit", "--flags", "fill"];
    const previewed = await cli(["init-config", "--keypair", "admin.json", ...terms], { "admin.json": admin });
    expect(previewed.code).toBe(EXIT_OK);
    const [configAddress] = await findConfigPda();
    expect(previewed.json()).toMatchObject({
      config: configAddress,
      sent: false,
      next: "nothing was sent; check the summary and pass --yes to sign and send",
      summary: [
        `Creates the engine config ${configAddress} for this cluster (domain ${fresh}) with the signer as admin`,
        `Guardian: ${guardian.address}`,
        `Fee recipient: ${feeRecipient.address}`,
        "Fee: 7 bps",
        "Enabled kinds: swap, limit",
        "Paused: filling",
      ],
    });
    expect(BigInt(previewed.json()["units_consumed"] as string)).toBeGreaterThan(0n);
    expect(h.svm.getAccount(configAddress).exists).toBe(false);
    expect((await cli(["init-config", "--authority", admin.address, "--yes", ...terms], {})).err).toBe(
      "--yes signs and sends with --keypair; --authority only prints an unsigned transaction",
    );
    const init = await cli(
      [
        "init-config",
        "--keypair",
        "admin.json",
        "--yes",
        "--guardian",
        guardian.address,
        "--fee-recipient",
        feeRecipient.address,
        "--fee-bps",
        "7",
        "--kinds",
        "swap,limit",
        "--flags",
        "fill",
      ],
      { "admin.json": admin },
    );
    expect(init.err).toBe("");
    expect(init.json()["domain"]).toBe("2a".repeat(32));
    const shown = (await cli(["show", "config"], {})).json();
    expect(shown).toMatchObject({
      admin: admin.address,
      guardian: guardian.address,
      feeRecipient: feeRecipient.address,
      feeBps: 7,
      enabledKinds: "6",
      paused: 2,
      domainMatchesCluster: true,
    });
    const lower = ["lower-pause", "--keypair", "k.json", "--yes", "--flags", "fill"];
    expect((await cli(lower, { "k.json": guardian })).code).toBe(EXIT_FAILED);
    expect((await cli(lower, { "k.json": admin })).code).toBe(EXIT_OK);
    expect((await cli(["show", "config"], {})).json()["paused"]).toBe(0);
    const raise = ["raise-pause", "--keypair", "k.json", "--yes", "--flags", "all"];
    expect((await cli(raise, { "k.json": guardian })).code).toBe(EXIT_OK);
    expect((await cli(["show", "config"], {})).json()["paused"]).toBe(3);
    const sentBefore = h.wires.length;
    const again = await cli(
      [
        "init-config",
        "--keypair",
        "admin.json",
        "--yes",
        "--guardian",
        guardian.address,
        "--fee-recipient",
        feeRecipient.address,
        "--fee-bps",
        "7",
        "--kinds",
        "swap",
      ],
      { "admin.json": admin },
    );
    expect(again.code).toBe(EXIT_FAILED);
    expect(again.err).toBe(configExists(configAddress));
    expect(h.wires).toHaveLength(sentBefore);
    const unsigned = await cli(["init-config", "--authority", admin.address, ...terms], {});
    expect([unsigned.code, unsigned.err]).toEqual([EXIT_FAILED, configExists(configAddress)]);
  });

  it("cranks expired intents to refunds and leaves cancelled ones to the wallet that paid for them", async () => {
    h.watched.length = 0;
    h.watched.push(owner.address);
    for (const [nonce, expiry] of [
      ["0", NOW + 10n],
      ["2", NOW + 3_600n],
    ] as const) {
      expect((await cli(create(nonce, expiry), { "owner.json": owner })).code).toBe(EXIT_OK);
    }
    await cli(["cancel", "--keypair", "owner.json", "--nonce", "2"], { "owner.json": owner });
    expect((await cli(create("1", NOW + 3_600n), { "owner.json": owner })).code).toBe(EXIT_OK);
    const clock = h.svm.getClock();
    clock.unixTimestamp = NOW + 10n;
    h.svm.setClock(clock);
    const cranker = await funded();
    const dry = await cli(["crank", "--keypair", "c.json", "--dry-run"], { "c.json": cranker });
    const [i0] = await findIntentPda({ owner: owner.address, nonce: 0n });
    const [i2] = await findIntentPda({ owner: owner.address, nonce: 2n });
    expect(dry.json()).toEqual({
      now: (NOW + 10n).toString(),
      dryRun: true,
      untouched: 2,
      actions: [{ intent: i0, action: "expire" }],
    });
    const wet = (await cli(["crank", "--keypair", "c.json"], { "c.json": cranker })).json() as {
      actions: { intent: string; action: string; signature?: string; error?: string }[];
    };
    expect(wet.actions.map((a) => [a.intent, a.action, typeof a.signature])).toEqual([[i0, "expire", "string"]]);
    expect(h.svm.getAccount(i0).exists).toBe(false);
    expect(h.svm.getAccount(i2).exists).toBe(true);
    expect(balance(ownerInput)).toBe(1_000n - ESCROW);
    const own = (await cli(["crank", "--keypair", "owner.json"], { "owner.json": owner })).json() as typeof wet;
    expect(own.actions.map((a) => [a.intent, a.action, typeof a.signature])).toEqual([[i2, "close", "string"]]);
    expect(h.svm.getAccount(i2).exists).toBe(false);
    const again = (await cli(["crank", "--keypair", "c.json"], { "c.json": cranker })).json() as typeof wet;
    expect(again.actions).toEqual([]);
  });

  it("skips refunds that would make the cranker pay for a missing account unless told to fund them", async () => {
    h.watched.length = 0;
    h.watched.push(owner.address);
    await cli(create("0", NOW + 10n), { "owner.json": owner });
    const held = balance(ownerInput);
    const sink = await ata(authority, (await generateKeyPairSigner()).address, inputMint);
    await send(owner, [
      getTransferInstruction({ source: ownerInput, destination: sink, authority: owner, amount: held }),
      getCloseAccountInstruction({ account: ownerInput, destination: owner.address, owner }),
    ]);
    const clock = h.svm.getClock();
    clock.unixTimestamp = NOW + 10n;
    h.svm.setClock(clock);
    const cranker = await funded();
    const lamports = h.svm.getBalance(cranker.address);
    const [i0] = await findIntentPda({ owner: owner.address, nonce: 0n });
    const skipped = (await cli(["crank", "--keypair", "c.json"], { "c.json": cranker })).json() as {
      actions: { intent: string; action: string; signature?: string; error?: string; skipped?: string }[];
    };
    expect(skipped.actions).toEqual([{ intent: i0, action: "expire", skipped: UNFUNDED }]);
    expect(h.svm.getBalance(cranker.address)).toBe(lamports);
    expect(h.svm.getAccount(ownerInput).exists).toBe(false);
    const costly = (await cli(["crank", "--keypair", "c.json", "--fund-accounts"], { "c.json": cranker })).json() as {
      actions: { intent: string; action: string; skipped?: string }[];
    };
    expect(costly.actions).toEqual([{ intent: i0, action: "expire", skipped: costlyFunding(0n) }]);
    expect(costlyFunding(0n)).toBe(
      `recreating the owner's token account costs ${FUNDING_RENT} lamports of rent, more than this intent's 0 lamport bounty; settle it with expire or close to pay that knowingly`,
    );
    expect(FUNDING_RENT).toBe(rentFor(TOKEN_ACCOUNT_BYTES));
    expect(h.svm.getBalance(cranker.address)).toBe(lamports);
    const paid = await cli(["expire", "--keypair", "c.json", "--owner", owner.address, "--nonce", "0"], { "c.json": cranker });
    expect(paid.code).toBe(EXIT_OK);
    expect(balance(ownerInput)).toBe(ESCROW);
  });

  it("funds a missing refund account in a crank run when the bounty covers its rent", async () => {
    h.watched.length = 0;
    h.watched.push(owner.address);
    const bounty = (FUNDING_RENT - 1n).toString();
    await cli(["set-economics", "--keypair", "a.json", "--yes", "--bounty", bounty, "--create-fee", "0"], { "a.json": authority });
    await cli(create("0", NOW + 10n), { "owner.json": owner });
    await cli(["set-economics", "--keypair", "a.json", "--yes", "--bounty", FUNDING_RENT.toString(), "--create-fee", "0"], { "a.json": authority });
    await cli(create("1", NOW + 10n), { "owner.json": owner });
    const sink = await ata(authority, (await generateKeyPairSigner()).address, inputMint);
    await send(owner, [
      getTransferInstruction({ source: ownerInput, destination: sink, authority: owner, amount: balance(ownerInput) }),
      getCloseAccountInstruction({ account: ownerInput, destination: owner.address, owner }),
    ]);
    const clock = h.svm.getClock();
    clock.unixTimestamp = NOW + 10n;
    h.svm.setClock(clock);
    const cranker = await funded();
    const [i0] = await findIntentPda({ owner: owner.address, nonce: 0n });
    const [i1] = await findIntentPda({ owner: owner.address, nonce: 1n });
    const run = (await cli(["crank", "--keypair", "c.json", "--fund-accounts"], { "c.json": cranker })).json() as {
      actions: { intent: string; action: string; signature?: string; skipped?: string }[];
    };
    const by = new Map(run.actions.map((a) => [a.intent, a]));
    expect(typeof by.get(i1)?.signature).toBe("string");
    expect(h.svm.getAccount(i1).exists).toBe(false);
    expect(balance(ownerInput)).toBeGreaterThanOrEqual(ESCROW);
    const first = by.get(i0);
    expect(first?.signature !== undefined || first?.skipped === costlyFunding(FUNDING_RENT - 1n)).toBe(true);
  });

  it("records a failing crank action and carries on with the rest", async () => {
    h.watched.length = 0;
    h.watched.push(owner.address);
    await cli(create("0", NOW + 10n), { "owner.json": owner });
    await cli(create("1", NOW + 10n), { "owner.json": owner });
    const [i0] = await findIntentPda({ owner: owner.address, nonce: 0n });
    const [i1] = await findIntentPda({ owner: owner.address, nonce: 1n });
    const [vault0] = await findVaultPda({ intent: i0 });
    const frozen = h.svm.getAccount(vault0);
    if (!frozen.exists) {
      throw new Error("vault missing");
    }
    const data = new Uint8Array(frozen.data);
    data[108] = 2;
    h.svm.setAccount({ ...frozen, data });
    const clock = h.svm.getClock();
    clock.unixTimestamp = NOW + 10n;
    h.svm.setClock(clock);
    const cranker = await funded();
    const run = (await cli(["crank", "--keypair", "c.json"], { "c.json": cranker })).json() as {
      actions: { intent: string; action: string; signature?: string; error?: string }[];
    };
    expect(run.actions.map((a) => [a.intent, a.action])).toEqual([
      [i0, "expire"],
      [i1, "expire"],
    ]);
    expect(run.actions[0]?.error).toMatch(/Custom|0x11/);
    expect(run.actions[0]?.signature).toBeUndefined();
    expect(typeof run.actions[1]?.signature).toBe("string");
    expect(h.svm.getAccount(i1).exists).toBe(false);
    expect(h.svm.getAccount(i0).exists).toBe(true);
  });

  it("refunds into a fresh account the owner holds when their own one cannot take it, only when told to fund it", async () => {
    h.watched.length = 0;
    h.watched.push(owner.address);
    await cli(["set-economics", "--keypair", "a.json", "--yes", "--bounty", FUNDING_RENT.toString(), "--create-fee", "0"], { "a.json": authority });
    await cli(create("0", NOW + 10n), { "owner.json": owner });
    const meddler = await funded();
    await send(owner, [
      getApproveInstruction({ source: ownerInput, delegate: meddler.address, owner, amount: 1n }),
    ]);
    const clock = h.svm.getClock();
    clock.unixTimestamp = NOW + 10n;
    h.svm.setClock(clock);
    const cranker = await funded();
    const [i0] = await findIntentPda({ owner: owner.address, nonce: 0n });
    const skipped = (await cli(["crank", "--keypair", "c.json"], { "c.json": cranker })).json() as {
      actions: { intent: string; action: string; skipped?: string }[];
    };
    expect(skipped.actions).toEqual([{ intent: i0, action: "expire", skipped: UNFUNDED }]);
    const before = balance(ownerInput);
    const done = (await cli(["crank", "--keypair", "c.json", "--fund-accounts"], { "c.json": cranker })).json() as {
      actions: { intent: string; action: string; signature?: string }[];
    };
    expect(done.actions.map((a) => [a.intent, typeof a.signature])).toEqual([[i0, "string"]]);
    expect(h.svm.getAccount(i0).exists).toBe(false);
    expect(balance(ownerInput)).toBe(before);
    const spare = await createAddressWithSeed({
      baseAddress: cranker.address,
      programAddress: TOKEN_PROGRAM_ADDRESS,
      seed: refundSeed(owner.address, inputMint),
    });
    expect(refundSeed(owner.address, inputMint)).toBe(owner.address.slice(0, 16) + inputMint.slice(0, 16));
    expect(balance(spare)).toBe(ESCROW);
    await cli(create("1", NOW + 20n), { "owner.json": owner });
    clock.unixTimestamp = NOW + 20n;
    h.svm.setClock(clock);
    const lamports = h.svm.getBalance(cranker.address) ?? 0n;
    await cli(["crank", "--keypair", "c.json", "--fund-accounts"], { "c.json": cranker });
    expect(balance(spare)).toBe(2n * ESCROW);
    expect(lamports - (h.svm.getBalance(cranker.address) ?? 0n)).toBeLessThan(rentFor(TOKEN_ACCOUNT_BYTES));
  });

  it("shows an intent of a version it does not understand as raw bytes with the reason", async () => {
    await cli(create("4", NOW + 3_600n), { "owner.json": owner });
    const [intent] = await findIntentPda({ owner: owner.address, nonce: 4n });
    const account = h.svm.getAccount(intent);
    if (!account.exists) {
      throw new Error("intent missing");
    }
    const data = new Uint8Array(account.data);
    data[8 + 164] = 2;
    h.svm.setAccount({ ...account, data });
    const shown = (await cli(["show", "intent", "--owner", owner.address, "--nonce", "4"], {})).json();
    expect(shown["version"]).toBe(2);
    expect(shown["params"]).toEqual({
      kind: "unknown(1)",
      raw: Array.from(data.subarray(8 + 168, 8 + 296), (b) => b.toString(16).padStart(2, "0")).join(""),
      reason: "unsupported version 2",
    });
  });

  it("sets the economics and pays an expiring cranker the bounty held by each intent", async () => {
    h.watched.length = 0;
    h.watched.push(owner.address);
    const economics = [
      "set-economics",
      "--keypair",
      "admin.json",
      "--yes",
      "--bounty",
      "90000",
      "--create-fee",
      "20000",
      "--kind-fees",
      "swap=3,attested=9",
      "--partner-cut",
      "2000",
    ];
    expect((await cli(economics, { "admin.json": owner })).code).toBe(EXIT_FAILED);
    expect((await cli(economics, { "admin.json": authority })).code).toBe(EXIT_OK);
    const [configAddress] = await findConfigPda();
    const view = await transport.getAccount(configAddress);
    const config = getConfigDecoder().decode(view?.data ?? new Uint8Array());
    expect(config).toMatchObject({
      crankBounty: 90_000,
      createFee: 20_000,
      kindFeeMask: 0b1_0010,
      partnerCutBps: 2_000,
    });
    expect(Array.from(config.kindFeeBps)).toEqual([3, 0, 0, 9]);
    const treasury = h.svm.getBalance(feeRecipient.address) ?? 0n;
    await cli(create("0", NOW + 10n), { "owner.json": owner });
    expect(h.svm.getBalance(feeRecipient.address)).toBe(treasury + 20_000n);
    const shown = (await cli(["show", "intent", "--owner", owner.address, "--nonce", "0"], {})).json();
    expect(shown["bounty"]).toBe(90_000);
    const clock = h.svm.getClock();
    clock.unixTimestamp = NOW + 10n;
    h.svm.setClock(clock);
    const cranker = await funded();
    const before = h.svm.getBalance(cranker.address) ?? 0n;
    await cli(["crank", "--keypair", "c.json"], { "c.json": cranker });
    const [intent] = await findIntentPda({ owner: owner.address, nonce: 0n });
    expect(h.svm.getAccount(intent).exists).toBe(false);
    expect(h.svm.getBalance(cranker.address)).toBe(before + 90_000n - 5_000n);
  });

  it("creates an intent that names a partner and shows it", async () => {
    const partner = await funded();
    const created = await cli(
      [...create("5", NOW + 3_600n), "--partner", partner.address, "--partner-bps", "25"],
      { "owner.json": owner },
    );
    expect(created.code).toBe(EXIT_OK);
    const shown = (await cli(["show", "intent", "--owner", owner.address, "--nonce", "5"], {})).json();
    expect(shown).toMatchObject({ partner: partner.address, partnerBps: 25 });
    await cli(create("6", NOW + 3_600n), { "owner.json": owner });
    const plain = (await cli(["show", "intent", "--owner", owner.address, "--nonce", "6"], {})).json();
    expect(plain).not.toHaveProperty("partner");
    expect(plain).not.toHaveProperty("partnerBps");
  });

  it("solves an open intent through the aggregator route and reports what it skipped", async () => {
    h.watched.length = 0;
    h.watched.push(owner.address);
    h.wires.length = 0;
    h.fetched.length = 0;
    await cli(create("8", NOW + 3_600n), { "owner.json": owner });
    await cli(create("9", NOW + 3_600n), { "owner.json": owner });
    h.wires.length = 0;
    const solver = await funded();
    await ata(authority, feeRecipient.address, inputMint);
    const solverInput = await ata(authority, solver.address, inputMint);
    const solverOutput = await ata(authority, solver.address, outputMint);
    const stash = await funded();
    const stashAccount = await ata(authority, stash.address, outputMint, 1_000_000n);
    await send(stash, [
      getApproveInstruction({ source: stashAccount, delegate: solver.address, owner: stash, amount: 1_000_000n }),
    ]);
    const route = getTransferCheckedInstruction({
      source: stashAccount,
      mint: outputMint,
      destination: solverOutput,
      authority: solver.address,
      amount: 350n,
      decimals: 6,
    });
    const asJupiter = {
      programId: route.programAddress,
      accounts: (route.accounts ?? []).map((m) => ({
        pubkey: m.address,
        isSigner: m.role === AccountRole.READONLY_SIGNER || m.role === AccountRole.WRITABLE_SIGNER,
        isWritable: m.role === AccountRole.WRITABLE || m.role === AccountRole.WRITABLE_SIGNER,
      })),
      data: Buffer.from(route.data ?? new Uint8Array()).toString("base64"),
    };
    const net = splitFee(ESCROW, FEE_BPS).net;
    const quote = { inAmount: net.toString(), outAmount: "360", otherAmountThreshold: "350" };
    h.jupiterReplies = [
      { status: 200, body: quote },
      { status: 200, body: { setupInstructions: [], swapInstruction: asJupiter, addressLookupTableAddresses: [] } },
      { status: 404, body: {} },
    ];
    const solve = [
      "solve",
      "--keypair",
      "s.json",
      "--jupiter",
      "https://quote.example/swap/v1/",
      "--min-profit",
      `${outputMint}=40`,
      "--route-program",
      route.programAddress,
    ];
    h.env[ENV_JUPITER_KEY] = "paid-key";
    const result = await cli(solve, { "s.json": solver });
    delete h.env[ENV_JUPITER_KEY];
    expect(result.code).toBe(EXIT_OK);
    const [i8] = await findIntentPda({ owner: owner.address, nonce: 8n });
    const [i9] = await findIntentPda({ owner: owner.address, nonce: 9n });
    expect(result.json()).toEqual({
      filled: [{ intent: i8, profit: "50", signature: expect.any(String) }],
      sent: [],
      skipped: [{ intent: i9, reason: "no route" }],
      failed: [],
    });
    expect(h.wires).toHaveLength(1);
    const statics = getCompiledTransactionMessageDecoder().decode(
      getTransactionDecoder().decode(getBase64Encoder().encode(h.wires[0] ?? "")).messageBytes,
    ).staticAccounts;
    expect(statics.some((a) => JITO_TIP_ACCOUNTS.includes(a))).toBe(false);
    const limit = unitLimitOf(h.wires[0] ?? "");
    expect(limit).toBeGreaterThan(0);
    expect(limit).toBeLessThan(MAX_COMPUTE_UNITS / 10);
    expect(h.fetched[0]?.url.startsWith("https://quote.example/swap/v1/quote?")).toBe(true);
    expect(h.fetched.map((f) => f.headers?.["x-api-key"])).toEqual([undefined, undefined, undefined]);
    expect([JUPITER_DOMAIN, jupiterHost("https://api.jup.ag/swap/v1"), jupiterHost("https://jup.ag")]).toEqual(["jup.ag", true, true]);
    expect(["https://quote.example", "https://jup.ag.evil.example", "https://notjup.ag", "https://evil.example/jup.ag"].map(jupiterHost)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(balance(solverInput)).toBe(net);
    expect(balance(solverOutput)).toBe(50n);
  });

  it("solves an intent by minting the token it issues, only for that pair and only as its mint authority", async () => {
    h.watched.length = 0;
    h.watched.push(owner.address);
    h.fetched.length = 0;
    const solver = await funded();
    const stranger = await funded();
    const issued = await mint(solver, 6);
    const receiver = await ata(authority, owner.address, issued);
    await cli(
      create("8", NOW + 3_600n).map((arg) => (arg === outputMint ? issued : arg)),
      { "owner.json": owner },
    );
    await cli(create("9", NOW + 3_600n), { "owner.json": owner });
    await ata(authority, feeRecipient.address, inputMint);
    const solverInput = await ata(authority, solver.address, inputMint);
    const solverOutput = await ata(authority, solver.address, issued);
    await ata(authority, stranger.address, issued);
    const [i8] = await findIntentPda({ owner: owner.address, nonce: 8n });
    const [i9] = await findIntentPda({ owner: owner.address, nonce: 9n });
    const net = splitFee(ESCROW, FEE_BPS).net;
    const issuing = async (rate: string, signer: KeyPairSigner) => {
      h.wires.length = 0;
      const run = await cli(
        ["solve", "--keypair", "s.json", "--issue", `${inputMint}:${issued}=${rate}`, "--min-profit", `${issued}=1,${outputMint}=1`, "--url", "http://cluster"],
        { "s.json": signer },
      );
      expect(run.code).toBe(EXIT_OK);
      return run.json() as { filled: unknown[]; sent: unknown[]; skipped: unknown[]; failed: { intent: Address; error: string }[] };
    };
    expect(await issuing("1/2", solver)).toEqual({
      filled: [],
      sent: [],
      skipped: [
        { intent: i8, reason: `the route pays ${net / 2n}, less than the 300 the intent requires` },
        { intent: i9, reason: "no route" },
      ],
      failed: [],
    });
    const foreign = await issuing("1/1", stranger);
    expect(foreign.failed.map((f) => [f.intent, f.error.startsWith(SIMULATION_REFUSED)])).toEqual([[i8, true]]);
    expect([foreign.filled, foreign.sent, h.wires]).toEqual([[], [], []]);
    expect(await issuing("1/1", solver)).toEqual({
      filled: [{ intent: i8, profit: String(net - 300n), signature: expect.any(String) }],
      sent: [],
      skipped: [{ intent: i9, reason: "no route" }],
      failed: [],
    });
    expect(h.wires).toHaveLength(1);
    expect(h.fetched).toEqual([]);
    expect([balance(receiver), balance(solverOutput), balance(solverInput)]).toEqual([300n, net - 300n, net]);
  });

  it("keeps solving with --watch: scans on the timer, fills a changed intent straight from its notification, and sends without waiting", async () => {
    h.watched.length = 0;
    h.watched.push(owner.address);
    h.waits.length = 0;
    h.closed = 0;
    h.submitted.length = 0;
    h.rounds = 3;
    const solver = await funded();
    const issued = await mint(solver, 6);
    const receiver = await ata(authority, owner.address, issued);
    for (const nonce of ["7", "12"]) {
      await cli(
        create(nonce, NOW + 3_600n).map((arg) => (arg === outputMint ? issued : arg)),
        { "owner.json": owner },
      );
    }
    await ata(authority, feeRecipient.address, inputMint);
    await ata(authority, solver.address, inputMint);
    await ata(authority, solver.address, issued);
    const [i7] = await findIntentPda({ owner: owner.address, nonce: 7n });
    const [i12] = await findIntentPda({ owner: owner.address, nonce: 12n });
    const created = h.svm.getAccount(i12);
    expect(created.exists).toBe(true);
    h.changed = [[{ address: i12, data: new Uint8Array(created.exists ? created.data : []) }]];
    const scans = h.scans;
    const run = await cli(
      ["solve", "--keypair", "s.json", "--issue", `${inputMint}:${issued}=1/1`, "--min-profit", `${issued}=1`, "--url", "http://cluster", "--watch", "--interval", "3"],
      { "s.json": solver },
    );
    expect([run.code, run.err]).toEqual([EXIT_OK, ""]);
    const profit = String(splitFee(ESCROW, FEE_BPS).net - 300n);
    expect(run.each()).toEqual([
      { filled: [], sent: [{ intent: i7, profit, signature: expect.any(String) }], failed: [] },
      { filled: [], sent: [{ intent: i12, profit, signature: expect.any(String) }], failed: [] },
    ]);
    expect([h.scans - scans, h.submitted.length, h.waits, h.closed]).toEqual([2, 2, [3, 3, 3], 1]);
    expect(balance(receiver)).toBe(600n);
  });

  it("tells a lost race, where the intent is already settled or gone, from a failure on an intent that is still open", async () => {
    await cli(create("4", NOW + 3_600n), { "owner.json": owner });
    await cli(create("5", NOW + 3_600n), { "owner.json": owner });
    await cli(["cancel", "--keypair", "owner.json", "--nonce", "5", "--url", "http://cluster"], { "owner.json": owner });
    const [open] = await findIntentPda({ owner: owner.address, nonce: 4n });
    const [settled] = await findIntentPda({ owner: owner.address, nonce: 5n });
    const [gone] = await findIntentPda({ owner: owner.address, nonce: 6n });
    expect(await lostRaces(transport, [])).toBe(true);
    expect(await lostRaces(transport, [settled, gone])).toBe(true);
    expect(await lostRaces(transport, [settled, open])).toBe(false);
  });

  it("sends a tipped bundle to jito only for a fill that simulates, and reports it as sent", async () => {
    h.watched.length = 0;
    h.watched.push(owner.address);
    h.wires.length = 0;
    h.fetched.length = 0;
    await cli(create("8", NOW + 3_600n), { "owner.json": owner });
    h.wires.length = 0;
    const solver = await funded();
    await ata(authority, feeRecipient.address, inputMint);
    await ata(authority, solver.address, inputMint);
    const solverOutput = await ata(authority, solver.address, outputMint);
    const net = splitFee(ESCROW, FEE_BPS).net;
    const jito = (swapInstruction: unknown) => [
      { status: 200, body: { inAmount: net.toString(), otherAmountThreshold: "999999" } },
      { status: 200, body: { swapInstruction, addressLookupTableAddresses: [] } },
      { status: 200, body: { jsonrpc: "2.0", id: 1, result: "bundle-7" } },
    ];
    const run = (program: string) =>
      cli(
        [
          "solve",
          "--keypair",
          "s.json",
          "--jupiter",
          "https://api.jup.ag/swap/v1",
          "--jito",
          "https://engine.example",
          "--tip",
          "10000",
          "--min-profit",
          `${outputMint}=1`,
          "--route-program",
          program,
        ],
        { "s.json": solver },
      );
    const [i8] = await findIntentPda({ owner: owner.address, nonce: 8n });
    h.jupiterReplies = jito({ programId: "11111111111111111111111111111111", accounts: [], data: "" });
    const doomed = (await run("11111111111111111111111111111111")).json() as Json;
    expect(doomed).toMatchObject({ filled: [], sent: [], skipped: [] });
    expect((doomed["failed"] as { intent: string; error: string }[]).map((f) => [f.intent, f.error.startsWith(SIMULATION_REFUSED)])).toEqual([
      [i8, true],
    ]);
    expect(h.fetched).toHaveLength(2);
    expect(h.wires).toEqual([]);
    for (const tip of JITO_TIP_ACCOUNTS) {
      h.svm.airdrop(tip, lamports(1_000_000_000n));
    }
    const stash = await funded();
    const stashAccount = await ata(authority, stash.address, outputMint, 1_000_000n);
    await send(stash, [getApproveInstruction({ source: stashAccount, delegate: solver.address, owner: stash, amount: 1_000_000n })]);
    const route = getTransferCheckedInstruction({
      source: stashAccount,
      mint: outputMint,
      destination: solverOutput,
      authority: solver.address,
      amount: 999_999n,
      decimals: 6,
    });
    h.fetched.length = 0;
    h.env[ENV_JUPITER_KEY] = "paid-key";
    h.jupiterReplies = jito({
      programId: route.programAddress,
      accounts: (route.accounts ?? []).map((m) => ({
        pubkey: m.address,
        isSigner: m.role === AccountRole.READONLY_SIGNER || m.role === AccountRole.WRITABLE_SIGNER,
        isWritable: m.role === AccountRole.WRITABLE || m.role === AccountRole.WRITABLE_SIGNER,
      })),
      data: Buffer.from(route.data ?? new Uint8Array()).toString("base64"),
    });
    const result = (await run(route.programAddress)).json() as Json;
    expect(result).toMatchObject({ filled: [], sent: [{ intent: i8, signature: "bundle-7" }], failed: [] });
    expect(h.wires).toEqual([]);
    expect(h.fetched[2]?.url).toBe("https://engine.example/api/v1/bundles");
    expect(h.fetched.map((f) => f.headers?.["x-api-key"])).toEqual(["paid-key", "paid-key", undefined]);
    expect(ENV_JUPITER_KEY).toBe("JUPITER_API_KEY");
    delete h.env[ENV_JUPITER_KEY];
    const sent = JSON.parse(h.fetched[2]?.body ?? "{}") as { params: [string[]] };
    expect(sent.params[0]).toHaveLength(1);
    const accounts = (wire: string) =>
      getCompiledTransactionMessageDecoder().decode(
        getTransactionDecoder().decode(getBase64Encoder().encode(wire)).messageBytes,
      ).staticAccounts;
    expect(accounts(sent.params[0][0] ?? "").some((a) => JITO_TIP_ACCOUNTS.includes(a))).toBe(true);
    expect(unitLimitOf(sent.params[0][0] ?? "")).toBeLessThan(MAX_COMPUTE_UNITS / 10);
  });

  it("lists the fixed accounts a solver can keep in its own lookup table", async () => {
    const solver = await generateKeyPairSigner();
    const listed = (await cli(["solver-table", "--solver", solver.address, "--mints", inputMint], {})).json() as Json;
    const fee = await findAssociatedTokenAddress({ owner: feeRecipient.address, mint: inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const own = await findAssociatedTokenAddress({ owner: solver.address, mint: inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(listed).toMatchObject({ solver: solver.address, count: 15, next: SOLVER_TABLE_NEXT });
    expect((listed["addresses"] as string[]).slice(-2)).toEqual([fee, own]);
    expect(SOLVER_TABLE_NEXT).toBe(
      "put these in an address lookup table you own (solana address-lookup-table create, then extend with them) and pass it to solve with --lookup-table",
    );
  });

  it("advances the signing epoch", async () => {
    await cli(create("0", NOW + 3_600n), { "owner.json": owner });
    const [user] = await findUserStatePda({ owner: owner.address });
    const epoch = async () => {
      const view = await transport.getAccount(user);
      return view === null ? -1n : getUserStateDecoder().decode(view.data).epoch;
    };
    let previous = await epoch();
    expect(previous).toBe(0n);
    for (let i = 0; i < 2; i++) {
      const advanced = await cli(["advance-epoch", "--keypair", "owner.json"], { "owner.json": owner });
      expect(advanced.code).toBe(EXIT_OK);
      expect(typeof advanced.json()["signature"]).toBe("string");
      const now = await epoch();
      expect(advanced.json()["epoch"]).toBe(now.toString());
      expect(now > previous && now - previous <= 2n ** 48n).toBe(true);
      previous = now;
    }
    const stranger = await generateKeyPairSigner();
    expect((await cli(["advance-epoch", "--keypair", "s.json"], { "s.json": stranger })).code).toBe(EXIT_FAILED);
  });

  it("advances the nonce window", async () => {
    await cli(create("0", NOW + 3_600n), { "owner.json": owner });
    const advanced = await cli(["advance-nonce", "--keypair", "owner.json", "--base", "300"], { "owner.json": owner });
    expect(advanced.code).toBe(EXIT_OK);
    const stale = await cli(create("3", NOW + 3_600n), { "owner.json": owner });
    expect(stale.code).toBe(EXIT_FAILED);
  });

  it("derives addresses offline", async () => {
    const result = await cli(["pda", "--owner", owner.address, "--nonce", "9"], {});
    const [intent] = await findIntentPda({ owner: owner.address, nonce: 9n });
    const [vault] = await findVaultPda({ intent });
    expect(result.json()).toEqual({ intent, vault });
    expect(h.urls).toEqual([]);
  });

  it("reports missing and foreign accounts as failures", async () => {
    const missing = await cli(["show", "intent", "--owner", owner.address, "--nonce", "5"], {});
    const [intent] = await findIntentPda({ owner: owner.address, nonce: 5n });
    expect(missing).toMatchObject({ code: EXIT_FAILED, err: `intent ${intent} does not exist`, out: "" });
    h.svm.setAccount({
      address: intent,
      programAddress: TOKEN_PROGRAM_ADDRESS,
      data: new Uint8Array(400),
      executable: false,
      lamports: lamports(1_000_000n),
      space: 400n,
    });
    expect((await cli(["show", "intent", "--owner", owner.address, "--nonce", "5"], {})).err).toBe(
      `${intent} is not an engine intent`,
    );
    h.svm.setAccount({
      address: intent,
      programAddress: INTENT_ENGINE_PROGRAM_ADDRESS,
      data: new Uint8Array(400),
      executable: false,
      lamports: lamports(1_000_000n),
      space: 400n,
    });
    expect((await cli(["show", "intent", "--owner", owner.address, "--nonce", "5"], {})).err).toBe(
      `${intent} is not an engine intent`,
    );
    const ghost = (await generateKeyPairSigner()).address;
    const noMint = await cli(
      ["create", "swap", "--keypair", "owner.json", "--nonce", "4", "--input-mint", ghost, "--output-mint", outputMint,
        "--expires-at", "1", "--amount-in", "1", "--min-out", "1"],
      { "owner.json": owner },
    );
    expect(noMint.err).toBe(`NotFound: mint ${ghost} does not exist`);
  });

  it("maps usage errors to exit code two", async () => {
    expect(await cli(["fly"], {})).toMatchObject({ code: EXIT_USAGE, out: "" });
    expect([EXIT_OK, EXIT_FAILED, EXIT_USAGE]).toEqual([0, 1, 2]);
  });
});

describe("process plumbing", () => {
  it("renders bigints as decimal strings and bytes as hex", () => {
    expect(render({ a: 1n, b: new Uint8Array([0, 255]), c: "x" })).toBe('{\n  "a": "1",\n  "b": "00ff",\n  "c": "x"\n}');
  });

  it("names every lifecycle status in order", () => {
    expect(STATUS).toEqual(["open", "filled", "cancelled", "expired", "filling"]);
  });

  it("loads a solana keypair file and rejects anything else", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cli-"));
    const seed = new Uint8Array(32).fill(7);
    seed[0] = 0;
    seed[1] = 255;
    const kp = await createKeyPairSignerFromPrivateKeyBytes(seed);
    const good = join(dir, "good.json");
    const secret = new Uint8Array(64);
    secret.set(seed);
    secret.set(getAddressEncoder().encode(kp.address), 32);
    await writeFile(good, JSON.stringify([...secret]), { mode: 0o600 });
    expect((await loadKeypairFile(good)).address).toBe(kp.address);
    for (const mode of [0o640, 0o604, 0o620, 0o602, 0o700, 0o400]) {
      const path = join(dir, `mode-${mode.toString(8)}.json`);
      await writeFile(path, JSON.stringify([...secret]), { mode });
      await chmod(path, mode);
      if ((mode & 0o077) === 0) {
        expect((await loadKeypairFile(path)).address).toBe(kp.address);
      } else {
        await expect(loadKeypairFile(path)).rejects.toThrow(KEYPAIR_EXPOSED);
        expect((await loadKeypairFile(path, "win32")).address).toBe(kp.address);
      }
    }
    for (const [name, body] of [
      ["short", JSON.stringify([...secret.subarray(0, 63)])],
      ["large", JSON.stringify([...secret.subarray(0, 63), 256])],
      ["negative", JSON.stringify([...secret.subarray(0, 63), -1])],
      ["fraction", JSON.stringify([...secret.subarray(0, 63), 1.5])],
      ["object", JSON.stringify({ length: 64 })],
    ] as const) {
      const path = join(dir, `${name}.json`);
      await writeFile(path, body, { mode: 0o600 });
      await expect(loadKeypairFile(path)).rejects.toThrow(KEYPAIR_UNREADABLE);
    }
    const garbled = join(dir, "garbled.json");
    await writeFile(garbled, "{", { mode: 0o600 });
    await expect(loadKeypairFile(garbled)).rejects.toBeInstanceOf(UsageError);
    const secret58 = "4hZ".repeat(29);
    const phantom = join(dir, "phantom.txt");
    await writeFile(phantom, secret58, { mode: 0o600 });
    for (const target of [phantom, secret58, join(dir, "absent.json")]) {
      const failure = await loadKeypairFile(target).then(
        () => "loaded",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      expect(failure).toBe(KEYPAIR_UNREADABLE);
      expect(failure).not.toContain("4hZ");
    }
  });

  it("serves the agent tools over stdio until the client hangs up", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const replies: Record<string, unknown>[] = [];
    let buffered = "";
    stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      replies.push(...lines.filter((l) => l !== "").map((l) => JSON.parse(l) as Record<string, unknown>));
    });
    const rt = nodeRuntime(Date.now, { stdin, stdout });
    const served = rt.serve(agentServer({ transport, relay: undefined, agent: undefined, claims: claimsOf() }));
    const ask = (id: number, method: string, params: object) =>
      stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    ask(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    ask(2, "tools/list", {});
    await vi.waitFor(() => expect(replies.map((r) => r["id"])).toEqual([1, 2]));
    expect(replies[0]?.["result"]).toMatchObject({ serverInfo: { name: "solive" } });
    expect((replies[1]?.["result"] as { tools: unknown[] }).tools).toHaveLength(ACTIONS.length);
    stdin.end();
    await expect(served).resolves.toBeUndefined();
  });

  it("gives up on an http request that never answers instead of stalling the run", async () => {
    expect(FETCH_TIMEOUT_MS).toBe(10_000);
    const sockets: Socket[] = [];
    const silent = createServer((socket) => sockets.push(socket));
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const port = (silent.address() as AddressInfo).port;
    const started = Date.now();
    const target = new URL("http://127.0.0.1:1/quote");
    target.port = String(port);
    await expect(nodeRuntime(Date.now, process, 200).fetch(target.href)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => silent.close(resolve));
  });

  it("reads wall-clock seconds and builds an rpc transport", async () => {
    const rt = nodeRuntime(() => 1_700_000_000_999);
    expect(rt.now()).toBe(1_700_000_000n);
    expect(rt.loadSigner).toBe(loadKeypairFile);
    expect(Object.keys(rt.transport("http://127.0.0.1:1"))).toEqual([
      "getAccount",
      "getAccounts",
      "send",
      "airdrop",
      "latestBlockhash",
      "sendWire",
      "submitWire",
      "simulate",
      "genesisHash",
      "recentFees",
      "budget",
      "engineTransactions",
      "intents",
    ]);
    expect(Number.isInteger(rt.entropy())).toBe(true);
    expect(typeof rt.fetch).toBe("function");
    const live = nodeRuntime().now();
    expect(Number(live)).toBeCloseTo(Date.now() / 1000, -1);
    expect(rt.env).toBe(process.env);
    expect(await rt.sleep(0)).toBe(true);
    const dir = await mkdtemp(join(tmpdir(), "engine-cli-"));
    const path = join(dir, "signed.json");
    await rt.writeText(path, "first");
    expect(await rt.readText(path)).toBe("first");
    await expect(rt.writeText(path, "second")).rejects.toThrow();
    expect(await rt.readText(path)).toBe("first");
  });

  it("runs a process, dropping node and script from argv", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const proc = {
      argv: ["node", "bin.js", "pda", "--owner", "11111111111111111111111111111112", "--nonce", "1"],
      stdout: { write: (t: string) => out.push(t) },
      stderr: { write: (t: string) => err.push(t) },
    };
    expect(await runProcess(proc, runtime({}))).toBe(EXIT_OK);
    expect(out).toHaveLength(1);
    expect(out[0]?.endsWith("}\n")).toBe(true);
    const bad = { ...proc, argv: ["node", "bin.js", "fly"] };
    expect(await runProcess(bad, runtime({}))).toBe(EXIT_USAGE);
    expect(err.at(-1)?.startsWith("usage:")).toBe(true);
    expect(err.at(-1)?.endsWith("\n")).toBe(true);
  });

  it("does not need the network to build commands", async () => {
    await expect(run({ name: "pda", owner: "11111111111111111111111111111112" as Address, nonce: 0n }, runtime({}))).resolves.toBeDefined();
  });
});

describe("event monitoring", () => {
  it("decodes engine events per transaction and counts the notable ones", async () => {
    const key = "11111111111111111111111111111112" as Address;
    const tag = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);
    h.engineLog = [
      {
        signature: "sig-a",
        slot: 9n,
        blockTime: 1_700_000_000n,
        failed: false,
        emitted: [
          tag(getPauseRaisedEventEncoder().encode({ by: key, paused: 2 })),
          new Uint8Array([1, 2, 3]),
          tag(getUserInitializedEventEncoder().encode({ owner: key })),
        ],
      },
      {
        signature: "sig-b",
        slot: 10n,
        blockTime: null,
        failed: true,
        emitted: [tag(getPauseRaisedEventEncoder().encode({ by: key, paused: 0 }))],
      },
      {
        signature: "sig-c",
        slot: 11n,
        blockTime: null,
        failed: false,
        emitted: [tag(getPauseRaisedEventEncoder().encode({ by: key, paused: 2 }).subarray(0, 12))],
      },
    ];
    h.requestedLimits.length = 0;
    const result = await cli(["events", "--limit", "7"], {});
    expect(h.requestedLimits).toEqual([7]);
    expect(result.json()).toEqual({
      notable: 1,
      transactions: [
        {
          signature: "sig-a",
          slot: "9",
          blockTime: "1700000000",
          failed: false,
          events: [
            { name: "PauseRaised", notable: true, fields: { by: key, paused: 2 } },
            { name: "UserInitialized", notable: false, fields: { owner: key } },
          ],
        },
        { signature: "sig-b", slot: "10", blockTime: null, failed: true, events: [] },
        { signature: "sig-c", slot: "11", blockTime: null, failed: false, events: [] },
      ],
    });
    h.requestedLimits.length = 0;
    await cli(["events"], {});
    expect(h.requestedLimits).toEqual([20]);
    h.engineLog = [];
  });
});

describe("refund targets", () => {
  it("accept a token account the owner holds outright, with no extension but immutable ownership", async () => {
    const T22 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;
    const owner = (await generateKeyPairSigner()).address;
    const mint = (await generateKeyPairSigner()).address;
    const engine = (await generateKeyPairSigner()).address;
    const base = Uint8Array.from(
      getTokenEncoder().encode({
        mint,
        owner,
        amount: 0n,
        delegate: null,
        state: AccountState.Initialized,
        isNative: null,
        delegatedAmount: 0n,
        closeAuthority: null,
      }),
    );
    const extended = (type: number) => {
      const data = new Uint8Array(170);
      data.set(base);
      data[165] = 2;
      data.set([type, 0, 0, 0], 166);
      return { owner: T22, data, lamports: 0n };
    };
    expect(IMMUTABLE_OWNER).toBe(7);
    expect(refundable({ owner: T22, data: base, lamports: 0n }, owner, mint, T22, engine)).toBe(true);
    expect(refundable(extended(7), owner, mint, T22, engine)).toBe(true);
    expect(refundable(extended(1), owner, mint, T22, engine)).toBe(false);
    const chained = (second: number) => {
      const data = new Uint8Array(178);
      data.set(base);
      data[165] = 2;
      data.set([7, 0, 4, 0, 7, 0, 0, 0, second, 0, 0, 0], 166);
      return { owner: T22, data, lamports: 0n };
    };
    expect(refundable(chained(7), owner, mint, T22, engine)).toBe(true);
    expect(refundable(chained(1), owner, mint, T22, engine)).toBe(false);
    expect(refundable({ owner: TOKEN_PROGRAM_ADDRESS, data: base, lamports: 0n }, owner, mint, T22, engine)).toBe(false);
    expect(refundable(null, owner, mint, T22, engine)).toBe(false);
  });
});

describe("crank decisions", () => {
  const PAYER = "SysvarRent111111111111111111111111111111111" as Address;
  const at = (status: number, expiresAt: bigint, version = 1) =>
    ({ status, expiresAt, version, rentPayer: PAYER }) as unknown as Intent;

  it("expires open intents from their deadline and closes settled ones, cancelled ones only for their payer", () => {
    expect(crankAction(at(0, 100n), 99n)).toBeUndefined();
    expect(crankAction(at(0, 100n), 100n)).toBe("expire");
    expect(crankAction(at(0, 100n), 101n)).toBe("expire");
    for (const status of [1, 3]) {
      expect(crankAction(at(status, 100n), 0n)).toBe("close");
    }
    expect(crankAction(at(2, 100n), 0n)).toBeUndefined();
    expect(crankAction(at(2, 100n), 0n, "11111111111111111111111111111112" as Address)).toBeUndefined();
    expect(crankAction(at(2, 100n), 0n, PAYER)).toBe("close");
    expect(crankAction(at(4, 100n), 1_000n)).toBeUndefined();
    expect(crankAction(at(9, 100n), 1_000n)).toBeUndefined();
  });

  it("leaves intents of a version it does not understand alone", () => {
    for (const version of [0, 2, 255]) {
      expect(crankAction(at(0, 100n, version), 1_000n)).toBeUndefined();
      expect(crankAction(at(1, 100n, version), 1_000n)).toBeUndefined();
    }
  });
});
