import { createHash } from "node:crypto";
import { claimsOf } from "../src/agent/claims.js";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
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
  type Signature,
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
import { TransactionMetadata } from "litesvm";
import { MAX_EXPIRES_IN, MIN_EXPIRES_IN } from "../src/agent/create.js";
import { NOT_SENT } from "../src/flows.js";
import {
  findAssociatedTokenAddress,
  findConfigPda,
  formatAmount,
  getConfigDecoder,
  getIntentAttestedEventEncoder,
  getIntentCreatedEventEncoder,
  releaseMemo,
  specMemo,
  EVENT_IX_TAG,
  findIntentPda,
  findUserStatePda,
  getUserStateDecoder,
  getPauseRaisedEventEncoder,
  getUserInitializedEventEncoder,
  findVaultPda,
  type Intent,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  INTENT_VERSION,
  DELIVERY_MEMO_PREFIX,
  Kind,
  splitFee,
  splitFees,
} from "@intent-engine/core";
import { agentServer } from "../src/agent/mcp.js";
import { ACTIONS } from "../src/agent/registry.js";
import { needsSpecHash, SHA256_NEEDED, SPEC_HASH_FORMAT, UsageError, usageOf } from "../src/args.js";
import { expandHome } from "../src/wallet.js";
import { DELIVER_ONE_OF } from "../src/job-args.js";
import { commitmentOf, createClient, deliverySalt, DEVNET_GENESIS_HASH, PLAIN_HTTP_ON_PUBLIC, rentExemptMinimum, saltCheckOf } from "@intent-engine/client";
import { ANNOUNCE_FIRST } from "../src/agent/wallet/delivery.js";
import {
  crankAction,
  IMMUTABLE_OWNER,
  refundable,
  refundSeed,
  configExists,
  ENV_JUPITER_KEY,
  JUPITER_DOMAIN,
  IN_FLIGHT_SECONDS,
  REFRESH_AFTER_SECONDS,
  jupiterHost,
  NOT_RELEASED,
  run,
  stillOpen,
  SOLVER_TABLE_NEXT,
  STATUS,
  TOKEN_ACCOUNT_BYTES,
  UNFUNDED,
} from "../src/commands.js";
import { rentFor, rentRate } from "../src/agent/budget.js";
import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  FETCH_TIMEOUT_MS,
  KEYPAIR_EXPOSED,
  KEYPAIR_UNREADABLE,
  keypairUnreadable,
  loadKeypairFile,
  nodeRuntime,
  PREVIEW_ONLY,
  render,
  runProcess,
} from "../src/main.js";
import { COMPUTE_BUDGET_ADDRESS, FAILED_ON_CHAIN, JITO_TIP_ACCOUNTS, MAX_COMPUTE_UNITS, NET_BELOW_FLOOR, SIMULATION_REFUSED } from "@intent-engine/solver";
import { costlyFunding, fundingRent } from "../src/crank.js";
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
  setNow,
  transport,
  world,
  type World,
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
      version: 2,
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
    const cancelled = await cli(["cancel", "--keypair", "owner.json", "--nonce", "1", "--yes"], { "owner.json": owner });
    expect(cancelled.code).toBe(EXIT_OK);
    expect(balance(ownerInput)).toBe(1_000n);
    expect((await cli(["show", "intent", "--owner", owner.address, "--nonce", "1"], {})).json()["status"]).toBe("cancelled");
    const cranker = await funded();
    const closed = await cli(["close", "--keypair", "c.json", "--owner", owner.address, "--nonce", "1", "--yes"], {
      "c.json": cranker,
    });
    expect(closed.code).toBe(EXIT_OK);
    const [intent] = await findIntentPda({ owner: owner.address, nonce: 1n });
    expect(h.svm.getAccount(intent).exists).toBe(false);
  });

  it("expires an intent once its deadline passes", async () => {
    await cli(create("2", NOW + 10n), { "owner.json": owner });
    const cranker = await funded();
    const args = ["expire", "--keypair", "c.json", "--owner", owner.address, "--nonce", "2", "--yes"];
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
    expect((await cli(["cancel", "--keypair", "owner.json", "--nonce", "8", "--yes"], { "owner.json": owner })).code).toBe(
      EXIT_OK,
    );
    await drainAndClose();
    const clock = h.svm.getClock();
    clock.unixTimestamp = NOW + 10n;
    h.svm.setClock(clock);
    const expireArgs = ["expire", "--keypair", "c.json", "--owner", owner.address, "--nonce", "6", "--yes"];
    expect((await cli(expireArgs, { "c.json": cranker })).code).toBe(EXIT_OK);
    expect(balance(ownerInput)).toBe(ESCROW);
    await drainAndClose();
    const [intent6] = await findIntentPda({ owner: owner.address, nonce: 6n });
    const [vault6] = await findVaultPda({ intent: intent6 });
    await send(authority, [getMintToInstruction({ mint: inputMint, token: vault6, mintAuthority: authority, amount: 5n })]);
    const close6 = ["close", "--keypair", "c.json", "--owner", owner.address, "--nonce", "6", "--yes"];
    expect((await cli(close6, { "c.json": cranker })).code).toBe(EXIT_OK);
    expect(balance(ownerInput)).toBe(5n);
    await drainAndClose();
    const close8 = ["close", "--keypair", "c.json", "--owner", owner.address, "--nonce", "8", "--yes"];
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
    await cli(["cancel", "--keypair", "owner.json", "--nonce", "2", "--yes"], { "owner.json": owner });
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
    const rent = await fundingRent(transport);
    expect(costly.actions).toEqual([{ intent: i0, action: "expire", skipped: costlyFunding(0n, rent) }]);
    expect(costlyFunding(0n, rent)).toBe(
      `recreating the owner's token account costs ${rent} lamports of rent, more than this intent's 0 lamport bounty; settle it with expire or close to pay that knowingly`,
    );
    expect(rent).toBe(rentFor(TOKEN_ACCOUNT_BYTES, await rentRate(transport)));
    expect(h.svm.getBalance(cranker.address)).toBe(lamports);
    const paid = await cli(["expire", "--keypair", "c.json", "--owner", owner.address, "--nonce", "0", "--yes"], { "c.json": cranker });
    expect(paid.code).toBe(EXIT_OK);
    expect(balance(ownerInput)).toBe(ESCROW);
  });

  it("funds a missing refund account in a crank run when the bounty covers its rent", async () => {
    h.watched.length = 0;
    h.watched.push(owner.address);
    const rent = await fundingRent(transport);
    const bounty = (rent - 1n).toString();
    await cli(["set-economics", "--keypair", "a.json", "--yes", "--bounty", bounty, "--create-fee", "0"], { "a.json": authority });
    await cli(create("0", NOW + 10n), { "owner.json": owner });
    await cli(["set-economics", "--keypair", "a.json", "--yes", "--bounty", rent.toString(), "--create-fee", "0"], { "a.json": authority });
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
    expect(first?.signature !== undefined || first?.skipped === costlyFunding(rent - 1n, rent)).toBe(true);
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
    const rent = await fundingRent(transport);
    await cli(["set-economics", "--keypair", "a.json", "--yes", "--bounty", rent.toString(), "--create-fee", "0"], { "a.json": authority });
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
    expect(h.svm.getBalance(spare)).toBe(rent);
    expect(rent).toBe(await rentExemptMinimum(transport, TOKEN_ACCOUNT_BYTES));
    expect(rent).toBe(h.svm.minimumBalanceForRentExemption(BigInt(TOKEN_ACCOUNT_BYTES)));
    await cli(create("1", NOW + 20n), { "owner.json": owner });
    clock.unixTimestamp = NOW + 20n;
    h.svm.setClock(clock);
    const lamports = h.svm.getBalance(cranker.address) ?? 0n;
    await cli(["crank", "--keypair", "c.json", "--fund-accounts"], { "c.json": cranker });
    expect(balance(spare)).toBe(2n * ESCROW);
    expect(lamports - (h.svm.getBalance(cranker.address) ?? 0n)).toBeLessThan(rent);
  });

  it("refuses to show an intent of a version it does not understand and names close-legacy", async () => {
    await cli(create("4", NOW + 3_600n), { "owner.json": owner });
    const [intent] = await findIntentPda({ owner: owner.address, nonce: 4n });
    const account = h.svm.getAccount(intent);
    if (!account.exists) {
      throw new Error("intent missing");
    }
    const data = new Uint8Array(account.data);
    data[8 + 164] = INTENT_VERSION + 1;
    h.svm.setAccount({ ...account, data });
    const shown = await cli(["show", "intent", "--owner", owner.address, "--nonce", "4"], {});
    expect(shown.code).toBe(EXIT_FAILED);
    expect(shown.err).toContain(`this intent account is of version ${INTENT_VERSION + 1}; this SDK reads intent versions 1 to ${INTENT_VERSION} only. Close it with intent-engine close-legacy`);
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

  const kindFees = (fees: string) => ["set-economics", "--keypair", "admin.json", "--yes", "--bounty", "0", "--create-fee", "0", "--kind-fees", fees];

  const kindFeeBps = async () => {
    const [configAddress] = await findConfigPda();
    const view = await transport.getAccount(configAddress);
    return Array.from(getConfigDecoder().decode(view?.data ?? new Uint8Array()).kindFeeBps);
  };

  it("set economics accepts attested up to 300 bps", async () => {
    const sent = h.wires.length;
    const over = await cli(kindFees("attested=301"), { "admin.json": authority });
    expect(over).toMatchObject({ code: EXIT_USAGE, err: "--kind-fees attested must be an integer from 0 to 300 bps" });
    expect(h.wires).toHaveLength(sent);
    expect((await cli(kindFees("swap=100,limit=100,dutch=100,attested=300"), { "admin.json": authority })).code).toBe(EXIT_OK);
    expect(await kindFeeBps()).toEqual([100, 100, 100, 300]);
  });

  it("set economics refuses swap above 100 bps", async () => {
    const sent = h.wires.length;
    for (const [fees, name] of [
      ["swap=101", "swap"],
      ["swap=300,attested=300", "swap"],
      ["limit=101", "limit"],
      ["dutch=101", "dutch"],
    ] as const) {
      const refused = await cli(kindFees(fees), { "admin.json": authority });
      expect(refused).toMatchObject({ code: EXIT_USAGE, err: `--kind-fees ${name} must be an integer from 0 to 100 bps` });
    }
    expect(h.wires).toHaveLength(sent);
    expect(await kindFeeBps()).toEqual([0, 0, 0, 0]);
    expect((await cli(["update-config", "--keypair", "admin.json", "--yes", "--fee-bps", "101"], { "admin.json": authority })).code).toBe(
      EXIT_USAGE,
    );
  });

  it("lists open proof escrows as jobs and announces a delivery to the judge, previewing unless --yes", async () => {
    h.watched.push(owner.address);
    h.engineLog = [];
    const judge = await generateKeyPairSigner();
    const worker = await funded();
    const client = createClient({ url: "http://cluster", transport });
    const specHash = new Uint8Array(32).fill(7);
    const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash, judgeFee: 0n } as const;
    const job = await client.createIntent({ signer: owner, params, inputMint, outputMint, nonce: 3n, expiresAt: NOW + 3_600n });
    const swap = await client.createIntent({ signer: owner, params: { kind: Kind.SwapExactIn, amountIn: 10n, minOut: 1n }, inputMint, outputMint, nonce: 4n, expiresAt: NOW + 3_600n });

    expect((await cli(["jobs", "--attestor", judge.address], {})).json()).toEqual({
      jobs: [
        {
          intent: job.intent,
          owner: owner.address,
          nonce: "3",
          attestor: judge.address,
          specHash: "07".repeat(32),
          specUrl: null,
          sells: "100",
          judgeFee: "0",
          feeBps: FEE_BPS,
          inputMint,
          expiresAt: (NOW + 3_600n).toString(),
          net_pay: "0.000099",
          payable: true,
          claimed_by: null,
          claim_ends: null,
          waiting: 0,
        },
      ],
    });
    expect((await cli(["jobs"], {})).json()["jobs"]).toHaveLength(1);
    expect((await cli(["jobs", "--attestor", worker.address], {})).json()).toEqual({ jobs: [] });

    const work = "ab".repeat(32);
    const args = ["deliver", "--keypair", "w.json", "--intent", job.intent, "--sha256", work.toUpperCase(), "--work-url", "https://example.org/work"];
    const salt = await deliverySalt(worker, job.intent, work);
    const summary = [
      `Announces: the work with sha256 ${work}, for the proof escrow ${job.intent}, as the commitment ${commitmentOf(job.intent, worker.address, salt, work)}, which binds it to ${worker.address} and a salt only its key derives`,
      "Seals: the salt and the url " + "https://example.org/work" + `, so only the judge ${judge.address} can read it`,
      `Notifies: its judge ${judge.address}, with a transfer of 0 lamports from ${worker.address}, which signs and pays the fee`,
    ];
    const preview = await cli(args, { "w.json": worker });
    expect(preview.json()).toMatchObject({ intent: job.intent, attestor: judge.address, check: saltCheckOf(salt), summary, sent: false });
    expect(JSON.stringify(preview.json())).not.toContain(salt);
    const sent = await cli([...args, "--yes"], { "w.json": worker });
    expect(sent.json()).toMatchObject({ intent: job.intent, attestor: judge.address, summary, sent: true, signature: expect.any(String) });

    const bad = await cli([...args.slice(0, 6), "xyz", ...args.slice(7)], { "w.json": worker });
    expect([bad.code, bad.err]).toEqual([EXIT_USAGE, SHA256_NEEDED]);
    const local = await cli([...args.slice(0, 8), "http://example.org/work"], { "w.json": worker });
    expect(local.code).toBe(EXIT_USAGE);
    expect(local.err).toContain("--work-url must be an https url");
    const refused = await cli(["deliver", "--keypair", "w.json", "--intent", swap.intent, "--sha256", work, "--work-url", "https://example.org/work"], { "w.json": worker });
    expect(refused.code).toBe(EXIT_FAILED);
    expect(refused.err).toContain(`intent ${swap.intent} is not a proof escrow`);
  });

  it("deliver --artifact announces the same hash that hash --artifact prints", async () => {
    const judge = await generateKeyPairSigner();
    const worker = await funded();
    const client = createClient({ url: "http://cluster", transport });
    const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: new Uint8Array(32).fill(7), judgeFee: 0n } as const;
    const job = await client.createIntent({ signer: owner, params, inputMint, outputMint, nonce: 3n, expiresAt: NOW + 3_600n });
    const dir = await mkdtemp(join(tmpdir(), "deliver-"));
    await mkdir(join(dir, "work", "src"), { recursive: true });
    await writeFile(join(dir, "work", "answer.txt"), "42\n");
    await writeFile(join(dir, "work", "src", "notes.txt"), "how\n");
    await writeFile(join(dir, "work.mjs"), "export default 1;\n");
    for (const artifact of [join(dir, "work"), join(dir, "work.mjs")]) {
      const hashed = await cli(["hash", "--artifact", artifact], {});
      const sha256 = (hashed.json() as { sha256: string }).sha256;
      const args = ["deliver", "--keypair", "w.json", "--intent", job.intent, "--artifact", artifact, "--work-url", "https://example.org/work"];
      const preview = await cli(args, { "w.json": worker });
      expect([preview.code, preview.err]).toEqual([EXIT_OK, ""]);
      const salt = await deliverySalt(worker, job.intent, sha256);
      const commitment = commitmentOf(job.intent, worker.address, salt, sha256);
      expect(preview.json()).toMatchObject({ commitment, warnings: [ANNOUNCE_FIRST] });
      expect(preview.json()["summary"] as string[]).toEqual([
        `Announces: the work with sha256 ${sha256}, for the proof escrow ${job.intent}, as the commitment ${commitment}, which binds it to ${worker.address} and a salt only its key derives`,
        "Seals: the salt and the url " + "https://example.org/work" + `, so only the judge ${judge.address} can read it`,
        `Notifies: its judge ${judge.address}, with a transfer of 0 lamports from ${worker.address}, which signs and pays the fee`,
      ]);
      const sent = await cli([...args, "--yes"], { "w.json": worker });
      expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
      const landed = h.svm.getTransaction(sent.json()["signature"] as Signature);
      if (!(landed instanceof TransactionMetadata)) {
        throw new Error("the delivery did not land");
      }
      expect(landed.logs().some((line) => line.includes(`${DELIVERY_MEMO_PREFIX}${job.intent}:${commitment}:${saltCheckOf(salt)}:`))).toBe(true);
      expect(landed.logs().some((line) => line.includes("example.org"))).toBe(false);
    }
  });

  it("deliver refuses both --artifact and --sha256, and neither", async () => {
    const worker = await funded();
    const dir = await mkdtemp(join(tmpdir(), "deliver-"));
    await writeFile(join(dir, "work.mjs"), "export default 1;\n");
    const [intent] = await findIntentPda({ owner: owner.address, nonce: 3n });
    const base = ["deliver", "--keypair", "w.json", "--intent", intent, "--work-url", "https://example.org/work"];
    const sent = h.wires.length;
    for (const extra of [["--artifact", join(dir, "work.mjs"), "--sha256", "ab".repeat(32)], []]) {
      const refused = await cli([...base, ...extra], { "w.json": worker });
      expect(refused).toMatchObject({ code: EXIT_USAGE, err: DELIVER_ONE_OF, out: "" });
    }
    expect(h.wires).toHaveLength(sent);
    expect(usageOf("deliver")).toMatchObject({ usage: expect.stringContaining("(--artifact <file or directory> | --sha256 <64 hex>)") });
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
    const quote = { inputMint, outputMint, swapMode: "ExactIn", inAmount: net.toString(), outAmount: "360", otherAmountThreshold: "350" };
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
      "--concurrency",
      "1",
    ];
    h.env[ENV_JUPITER_KEY] = "paid-key";
    const result = await cli(solve, { "s.json": solver });
    delete h.env[ENV_JUPITER_KEY];
    expect(result.code).toBe(EXIT_OK);
    const [i8] = await findIntentPda({ owner: owner.address, nonce: 8n });
    const [i9] = await findIntentPda({ owner: owner.address, nonce: 9n });
    expect(result.json()).toEqual({
      filled: [{ intent: i8, profit: "50", cost: expect.any(String), signature: expect.any(String) }],
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
    const issuing = async (rate: string, signer: KeyPairSigner, extra: string[] = []) => {
      h.wires.length = 0;
      const run = await cli(
        ["solve", "--keypair", "s.json", "--issue", `${inputMint}:${issued}=${rate}`, "--min-profit", `${issued}=1,${outputMint}=1`, "--url", "http://cluster", ...extra],
        { "s.json": signer },
      );
      expect(run.code).toBe(EXIT_OK);
      return run.json() as { filled: unknown[]; sent: unknown[]; skipped: { intent: Address; reason: string }[]; failed: { intent: Address; error: string }[] };
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
    const dear = await issuing("1/1", solver, ["--sol-value", `${issued}=${net}/1`]);
    expect(dear.skipped.map((s) => [s.intent, s.reason.startsWith(NET_BELOW_FLOOR)])).toEqual([[i8, true], [i9, false]]);
    expect([dear.filled, dear.sent, dear.failed, h.wires]).toEqual([[], [], [], []]);
    expect(await issuing("1/1", solver)).toEqual({
      filled: [{ intent: i8, profit: String(net - 300n), cost: expect.any(String), signature: expect.any(String) }],
      sent: [],
      skipped: [{ intent: i9, reason: "no route" }],
      failed: [],
    });
    expect(h.wires).toHaveLength(1);
    expect(h.fetched).toEqual([]);
    expect([balance(receiver), balance(solverOutput), balance(solverInput)]).toEqual([300n, net - 300n, net]);
  });

  it("solves from the solver's own tokens before it mints, and finds no route from inventory alone when the balance is short", async () => {
    h.watched.length = 0;
    h.watched.push(owner.address);
    h.fetched.length = 0;
    const solver = await funded();
    const issued = await mint(solver, 6);
    const receiver = await ata(authority, owner.address, issued);
    await cli(
      create("8", NOW + 3_600n).map((arg) => (arg === outputMint ? issued : arg)),
      { "owner.json": owner },
    );
    await ata(authority, feeRecipient.address, inputMint);
    const solverInput = await ata(authority, solver.address, inputMint);
    const solverOutput = await ata(authority, solver.address, issued);
    const [i8] = await findIntentPda({ owner: owner.address, nonce: 8n });
    const net = splitFee(ESCROW, FEE_BPS).net;
    await send(solver, [getMintToInstruction({ mint: issued, token: solverOutput, mintAuthority: solver, amount: net - 1n })]);
    const solving = async (market: string[]) => {
      h.wires.length = 0;
      const run = await cli(["solve", "--keypair", "s.json", ...market, "--min-profit", `${issued}=1`, "--url", "http://cluster"], {
        "s.json": solver,
      });
      expect(run.code).toBe(EXIT_OK);
      return run.json();
    };
    const rate = `${inputMint}:${issued}=1/1`;
    expect(await solving(["--inventory", rate])).toEqual({ filled: [], sent: [], skipped: [{ intent: i8, reason: "no route" }], failed: [] });
    await send(solver, [getMintToInstruction({ mint: issued, token: solverOutput, mintAuthority: solver, amount: 1n })]);
    expect(await solving(["--inventory", rate, "--issue", rate])).toEqual({
      filled: [{ intent: i8, profit: String(net - 300n), cost: expect.any(String), signature: expect.any(String) }],
      sent: [],
      skipped: [],
      failed: [],
    });
    expect(h.wires).toHaveLength(1);
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
    const timing = { at: String(NOW + 1_000n), ms: expect.any(Number) };
    expect(run.each()).toEqual([
      { ...timing, scan: "full", filled: [], sent: [{ intent: i7, profit, cost: expect.any(String), signature: expect.any(String) }], failed: [] },
      { ...timing, scan: "changed", filled: [], sent: [{ intent: i12, profit, cost: expect.any(String), signature: expect.any(String) }], failed: [] },
    ]);
    expect([h.scans - scans, h.submitted.length, h.waits, h.closed]).toEqual([2, 2, [3, 3, 3], 1]);
    expect(balance(receiver)).toBe(600n);
  });

  it("tells which failed intents are still open, so a lost race on a settled or gone intent keeps the cache", async () => {
    await cli(create("4", NOW + 3_600n), { "owner.json": owner });
    await cli(create("5", NOW + 3_600n), { "owner.json": owner });
    await cli(["cancel", "--keypair", "owner.json", "--nonce", "5", "--url", "http://cluster", "--yes"], { "owner.json": owner });
    const [open] = await findIntentPda({ owner: owner.address, nonce: 4n });
    const [settled] = await findIntentPda({ owner: owner.address, nonce: 5n });
    const [gone] = await findIntentPda({ owner: owner.address, nonce: 6n });
    expect(await stillOpen(transport, [])).toEqual([]);
    expect(await stillOpen(transport, [settled, gone])).toEqual([]);
    expect(await stillOpen(transport, [settled, open, gone])).toEqual([open]);
  });

  const watching = async (issued: Address, solver: KeyPairSigner) =>
    cli(
      ["solve", "--keypair", "s.json", "--issue", `${inputMint}:${issued}=1/1`, "--min-profit", `${issued}=1`, "--url", "http://cluster", "--watch", "--interval", "3"],
      { "s.json": solver },
    );

  async function issuedMarket() {
    const solver = await funded();
    const issued = await mint(solver, 6);
    await ata(authority, owner.address, issued);
    await ata(authority, feeRecipient.address, inputMint);
    await ata(authority, solver.address, inputMint);
    await ata(authority, solver.address, issued);
    return { solver, issued };
  }

  it("solve backoff retain uses chain time", async () => {
    h.watched.length = 0;
    h.watched.push(owner.address);
    h.waits.length = 0;
    h.submitted.length = 0;
    const { solver, issued } = await issuedMarket();
    const chainNow = h.svm.getClock().unixTimestamp;
    const expiresAt = chainNow + 500n;
    expect(NOW + 1_000n).toBeGreaterThan(expiresAt);
    await cli(create("8", expiresAt).map((arg) => (arg === outputMint ? issued : arg)), { "owner.json": owner });
    const [late] = await findIntentPda({ owner: owner.address, nonce: 8n });
    expect(h.svm.getAccount(late).exists).toBe(true);
    const refused: string[] = [];
    h.through = {
      ...transport,
      submitWire: async (wire) => {
        refused.push(wire);
        throw new Error("the node refused the fill");
      },
    };
    h.rounds = 3;
    h.changed = [];
    const run = await watching(issued, solver);
    expect([run.code, run.err]).toEqual([EXIT_OK, ""]);
    expect(run.each()).toEqual([expect.objectContaining({ scan: "full", failed: [expect.objectContaining({ intent: late })] })]);
    expect(h.waits).toHaveLength(3);
    expect(refused).toHaveLength(1);
  });

  it("still scans everything once the interval passes, however many notifications keep arriving", async () => {
    h.watched.length = 0;
    h.watched.push(owner.address);
    h.waits.length = 0;
    const { solver, issued } = await issuedMarket();
    await cli(create("3", NOW + 3_600n).map((arg) => (arg === outputMint ? issued : arg)), { "owner.json": owner });
    const [busy] = await findIntentPda({ owner: owner.address, nonce: 3n });
    const view = h.svm.getAccount(busy);
    const data = new Uint8Array(view.exists ? view.data : []);
    h.rounds = 4;
    h.steps = [2n, 2n, 2n];
    h.changed = [[{ address: busy, data }], [{ address: busy, data }], [{ address: busy, data }]];
    const scans = h.scans;
    expect((await watching(issued, solver)).code).toBe(EXIT_OK);
    expect(h.scans - scans).toBe(2);
  });

  it("does not send a second fill for an intent whose first fill is still in flight, and tries again once that wait ends", async () => {
    h.watched.length = 0;
    h.watched.push(owner.address);
    h.waits.length = 0;
    h.submitted.length = 0;
    const { solver, issued } = await issuedMarket();
    await cli(create("2", NOW + 3_600n).map((arg) => (arg === outputMint ? issued : arg)), { "owner.json": owner });
    const [pending] = await findIntentPda({ owner: owner.address, nonce: 2n });
    h.dropSubmits = true;
    h.rounds = 3;
    h.steps = [0n, IN_FLIGHT_SECONDS];
    h.changed = [];
    const run = await watching(issued, solver);
    h.dropSubmits = false;
    expect(run.code).toBe(EXIT_OK);
    expect(run.each().map((r) => (r["sent"] as { intent: Address }[]).map((s) => s.intent))).toEqual([[pending], [pending]]);
    expect(h.submitted).toHaveLength(2);
  });

  it("does not plan a second inventory fill from tokens an unlanded first fill holds, and frees them once that flight ends", async () => {
    h.watched.length = 0;
    h.watched.push(owner.address);
    h.waits.length = 0;
    h.submitted.length = 0;
    const solver = await funded();
    const issued = await mint(solver, 6);
    await ata(authority, owner.address, issued);
    await ata(authority, feeRecipient.address, inputMint);
    await ata(authority, solver.address, inputMint);
    const solverOutput = await ata(authority, solver.address, issued);
    await send(solver, [getMintToInstruction({ mint: issued, token: solverOutput, mintAuthority: solver, amount: splitFee(ESCROW, FEE_BPS).net })]);
    for (const nonce of ["4", "6"]) {
      await cli(create(nonce, NOW + 3_600n).map((arg) => (arg === outputMint ? issued : arg)), { "owner.json": owner });
    }
    const opened = await Promise.all([4n, 6n].map(async (nonce) => (await findIntentPda({ owner: owner.address, nonce }))[0]));
    h.dropSubmits = true;
    h.rounds = 3;
    h.steps = [3n, IN_FLIGHT_SECONDS - 3n];
    h.changed = [];
    const run = await cli(
      ["solve", "--keypair", "s.json", "--inventory", `${inputMint}:${issued}=1/1`, "--min-profit", `${issued}=1`, "--url", "http://cluster", "--watch", "--interval", "3"],
      { "s.json": solver },
    );
    h.dropSubmits = false;
    expect([run.code, run.err]).toEqual([EXIT_OK, ""]);
    const sent = run.each().map((r) => r["sent"] as { intent: Address; holds?: unknown }[]);
    expect(sent.map((round) => round.length)).toEqual([1, 1]);
    expect(sent.map((round) => round[0]?.holds)).toEqual([
      { account: solverOutput, amount: "300" },
      { account: solverOutput, amount: "300" },
    ]);
    expect(opened).toContain(sent[0]?.[0]?.intent);
    expect(h.submitted).toHaveLength(2);
    expect(balance(solverOutput)).toBe(splitFee(ESCROW, FEE_BPS).net);
  });

  it("backs off an intent whose sent fill failed on chain instead of resending it every in-flight window", async () => {
    h.watched.length = 0;
    h.watched.push(owner.address);
    h.waits.length = 0;
    const { solver, issued } = await issuedMarket();
    await cli(create("5", NOW + 3_600n).map((arg) => (arg === outputMint ? issued : arg)), { "owner.json": owner });
    const [doomed] = await findIntentPda({ owner: owner.address, nonce: 5n });
    const lost: string[] = [];
    h.through = {
      ...transport,
      submitWire: async () => {
        lost.push(`lost-${lost.length}`);
        return lost.at(-1) ?? "";
      },
      transactionOf: async (signature) =>
        lost.includes(signature) ? { signature, slot: 0n, blockTime: null, failed: true, emitted: [] } : null,
    };
    h.rounds = 4;
    h.steps = [IN_FLIGHT_SECONDS, 1n, 3n];
    h.changed = [];
    const run = await watching(issued, solver);
    expect(run.code).toBe(EXIT_OK);
    const intents = (key: string) => run.each().map((r) => ((r[key] ?? []) as { intent: Address }[]).map((s) => s.intent));
    expect(intents("sent")).toEqual([[doomed], [], [doomed]]);
    expect(intents("failed")).toEqual([[], [doomed], []]);
    expect(run.each()[1]?.["failed"]).toEqual([{ intent: doomed, error: `${FAILED_ON_CHAIN}: lost-0` }]);
    expect(lost).toEqual(["lost-0", "lost-1"]);
  });

  it("skips only a notification it cannot decode and still fills the valid ones that came with it", async () => {
    h.watched.length = 0;
    h.watched.push(owner.address);
    h.waits.length = 0;
    const { solver, issued } = await issuedMarket();
    await cli(create("12", NOW + 3_600n).map((arg) => (arg === outputMint ? issued : arg)), { "owner.json": owner });
    const [valid] = await findIntentPda({ owner: owner.address, nonce: 12n });
    const [bogus] = await findIntentPda({ owner: owner.address, nonce: 9n });
    const view = h.svm.getAccount(valid);
    h.rounds = 2;
    h.changed = [[{ address: bogus, data: new Uint8Array([1, 2, 3]) }, { address: valid, data: new Uint8Array(view.exists ? view.data : []) }]];
    const run = await watching(issued, solver);
    expect(run.code).toBe(EXIT_OK);
    expect(run.each()).toEqual([
      { at: String(NOW + 1_000n), scan: "changed", unreadable: [bogus] },
      expect.objectContaining({ scan: "changed", sent: [expect.objectContaining({ intent: valid })], failed: [] }),
    ]);
  });

  it("refreshes its cache for an intent that keeps failing at most once a minute, not every round and not never", async () => {
    h.watched.length = 0;
    h.watched.push(owner.address);
    h.waits.length = 0;
    const { solver, issued } = await issuedMarket();
    const stranger = await funded();
    await ata(authority, stranger.address, inputMint);
    await ata(authority, stranger.address, issued);
    await cli(create("4", NOW + 3_600n).map((arg) => (arg === outputMint ? issued : arg)), { "owner.json": owner });
    const [config] = await findConfigPda();
    h.rounds = 7;
    h.steps = [5n, 5n, 5n, 5n, REFRESH_AFTER_SECONDS, 5n];
    h.changed = [];
    h.reads.clear();
    const run = await watching(issued, stranger);
    expect(run.code).toBe(EXIT_OK);
    expect(run.each().map((r) => [r["at"], (r["failed"] as unknown[]).length])).toEqual([
      [String(NOW + 1_000n), 1],
      [String(NOW + 1_005n), 1],
      [String(NOW + 1_015n), 1],
      [String(NOW + 1_020n + REFRESH_AFTER_SECONDS), 1],
    ]);
    expect(h.reads.get(config)).toBe(3);
    expect(solver.address).not.toBe(stranger.address);
  });

  it("counts a full scan only once it succeeds, so the next round scans everything again", async () => {
    h.watched.length = 0;
    h.watched.push(owner.address);
    h.waits.length = 0;
    const { solver, issued } = await issuedMarket();
    const [busy] = await findIntentPda({ owner: owner.address, nonce: 3n });
    h.failScans = 1;
    h.rounds = 2;
    h.changed = [[{ address: busy, data: new Uint8Array([1, 2, 3]) }]];
    const scans = h.scans;
    const run = await watching(issued, solver);
    expect(run.code).toBe(EXIT_OK);
    expect(run.each()).toEqual([{ at: String(NOW + 1_000n), scan: "full", error: "scan refused" }]);
    expect(h.scans - scans).toBe(2);
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
      { status: 200, body: { inputMint, outputMint, swapMode: "ExactIn", inAmount: net.toString(), otherAmountThreshold: "999999" } },
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

  it("sends every fill of a solve through one jito bundle that tips only on its last transaction", async () => {
    h.watched.length = 0;
    h.watched.push(owner.address);
    await cli(create("8", NOW + 3_600n), { "owner.json": owner });
    await cli(create("9", NOW + 3_600n), { "owner.json": owner });
    h.wires.length = 0;
    const solver = await funded();
    await ata(authority, feeRecipient.address, inputMint);
    await ata(authority, solver.address, inputMint);
    const solverOutput = await ata(authority, solver.address, outputMint);
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
    const net = splitFee(ESCROW, FEE_BPS).net;
    const quoted = [
      { status: 200, body: { inputMint, outputMint, swapMode: "ExactIn", inAmount: net.toString(), otherAmountThreshold: "999999" } },
      {
        status: 200,
        body: {
          swapInstruction: {
            programId: route.programAddress,
            accounts: (route.accounts ?? []).map((m) => ({
              pubkey: m.address,
              isSigner: m.role === AccountRole.READONLY_SIGNER || m.role === AccountRole.WRITABLE_SIGNER,
              isWritable: m.role === AccountRole.WRITABLE || m.role === AccountRole.WRITABLE_SIGNER,
            })),
            data: Buffer.from(route.data ?? new Uint8Array()).toString("base64"),
          },
          addressLookupTableAddresses: [],
        },
      },
    ];
    const engine = "https://" + "engine.example";
    const run = (size: string, bundles: string[]) => {
      h.fetched.length = 0;
      h.jupiterReplies = [...quoted, ...quoted, ...bundles.map((id) => ({ status: 200, body: { jsonrpc: "2.0", id: 1, result: id } }))];
      return cli(
        [
          "solve",
          "--keypair",
          "s.json",
          "--jupiter",
          "https://api.jup.ag/swap/v1",
          "--jito",
          engine,
          "--tip",
          "10000",
          "--bundle-size",
          size,
          "--concurrency",
          "1",
          "--min-profit",
          `${outputMint}=1`,
          "--route-program",
          route.programAddress,
        ],
        { "s.json": solver },
      );
    };
    const [i8] = await findIntentPda({ owner: owner.address, nonce: 8n });
    const [i9] = await findIntentPda({ owner: owner.address, nonce: 9n });
    const tipped = (wire: string) =>
      getCompiledTransactionMessageDecoder()
        .decode(getTransactionDecoder().decode(getBase64Encoder().encode(wire)).messageBytes)
        .staticAccounts.some((a) => JITO_TIP_ACCOUNTS.includes(a));
    const bundled = (await run("5", ["bundle-1"])).json() as Json;
    expect(bundled).toMatchObject({ filled: [], skipped: [], failed: [] });
    expect(new Set((bundled["sent"] as { intent: string; signature: string }[]).map((s) => `${s.intent} ${s.signature}`))).toEqual(
      new Set([`${i8} bundle-1`, `${i9} bundle-1`]),
    );
    const requests = h.fetched.filter((f) => f.url === engine + "/api/v1/bundles");
    expect(requests).toHaveLength(1);
    const wires = (JSON.parse(requests[0]?.body ?? "{}") as { params: [string[]] }).params[0];
    expect(wires.map(tipped)).toEqual([false, true]);
    expect(h.wires).toEqual([]);
    const single = (await run("1", ["bundle-a", "bundle-b"])).json() as Json;
    expect((single["sent"] as { signature: string }[]).map((s) => s.signature).sort()).toEqual(["bundle-a", "bundle-b"]);
    const singles = h.fetched.filter((f) => f.url === engine + "/api/v1/bundles");
    expect(singles.map((f) => (JSON.parse(f.body ?? "{}") as { params: [string[]] }).params[0].map(tipped))).toEqual([[true], [true]]);
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

  it("prints the hash a judge computes for a file, offline, whatever the file is called", async () => {
    const dir = await mkdtemp(join(tmpdir(), "hash-"));
    await writeFile(join(dir, "work.mjs"), "export default 1;\n");
    await writeFile(join(dir, "other-name"), "export default 1;\n");
    const first = await cli(["hash", "--artifact", join(dir, "work.mjs")], {});
    const second = await cli(["hash", "--artifact", join(dir, "other-name")], {});
    expect(first.json()).toEqual({ artifact: join(dir, "work.mjs"), sha256: createHash("sha256").update("export default 1;\n").digest("hex") });
    expect((second.json() as { sha256: string }).sha256).toBe((first.json() as { sha256: string }).sha256);
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
    for (const target of [phantom, secret58, join(dir, "absent.json"), JSON.stringify([...secret])]) {
      const failure = await loadKeypairFile(target).then(
        () => "loaded",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      expect(failure).toBe(keypairUnreadable(target));
      expect(failure.startsWith(KEYPAIR_UNREADABLE)).toBe(true);
      expect(failure).not.toContain("4hZ");
      expect(failure).not.toContain("[");
    }
    expect(keypairUnreadable(phantom)).toBe(`${KEYPAIR_UNREADABLE}; tried ${phantom}`);
    expect(keypairUnreadable(secret58)).not.toContain(secret58);
  });

  it("a keypair path starting with a tilde is expanded", async () => {
    const home = await mkdtemp(join(tmpdir(), "home-"));
    const seed = new Uint8Array(32).fill(9);
    const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
    await writeFile(join(home, "wallet.json"), JSON.stringify([...seed, ...getAddressEncoder().encode(signer.address)]), { mode: 0o600 });
    expect((await loadKeypairFile("~/wallet.json", process.platform, home)).address).toBe(signer.address);
    expect((await loadKeypairFile(join(home, "wallet.json"), process.platform, home)).address).toBe(signer.address);
    const missing = await loadKeypairFile("~/absent.json", process.platform, home).then(
      () => "loaded",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    expect(missing).toBe(`${KEYPAIR_UNREADABLE}; tried ${home}/absent.json`);
    expect(expandHome("~", home)).toBe(home);
    expect(expandHome("~\\wallet.json", home)).toBe(`${home}\\wallet.json`);
    expect(expandHome("~other/wallet.json", home)).toBe("~other/wallet.json");
    expect(expandHome("a/~/wallet.json", home)).toBe("a/~/wallet.json");
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
    await expect(nodeRuntime(Date.now, process, 200).fetch(target.href)).rejects.toMatchObject({ name: "TimeoutError" });
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
      "signaturesOf",
      "transactionsOf",
      "transactionOf",
      "signatureStatuses",
      "firstAvailableSlot",
      "finalizedBlock",
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
    await expect(rt.writeText(path, "second")).rejects.toMatchObject({ code: "EEXIST" });
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
    const owner = "11111111111111111111111111111112" as Address;
    const [intent] = await findIntentPda({ owner, nonce: 0n });
    const [vault] = await findVaultPda({ intent });
    h.urls.length = 0;
    await expect(run({ name: "pda", owner, nonce: 0n }, runtime({}))).resolves.toEqual({ intent, vault });
    expect(h.urls).toEqual([]);
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
  const at = (status: number, expiresAt: bigint, version = 2) =>
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
    for (const version of [0, 1, 3, 255]) {
      expect(crankAction(at(0, 100n, version), 1_000n)).toBeUndefined();
      expect(crankAction(at(1, 100n, version), 1_000n)).toBeUndefined();
    }
  });
});

describe("the cli reaches what the other surfaces do", () => {
  let w: World;
  let keys: Record<string, KeyPairSigner>;

  beforeEach(async () => {
    w = await world();
    keys = { "owner.json": w.owner };
    h.engineLog = [];
  });

  const swap = (nonce: string, ...more: string[]) => [
    "create",
    "swap",
    "--keypair",
    "owner.json",
    "--nonce",
    nonce,
    "--input-mint",
    w.inputMint,
    "--output-mint",
    w.outputMint,
    "--expires-at",
    (NOW + 3_600n).toString(),
    "--amount-in",
    ESCROW.toString(),
    "--min-out",
    "300",
    "--units",
    "raw",
    ...more,
  ];

  const attested = (attestor: Address, ...more: string[]) => [
    "create",
    "attested",
    "--keypair",
    "owner.json",
    "--input-mint",
    w.inputMint,
    "--output-mint",
    w.outputMint,
    "--expires-in",
    "3600",
    "--amount-in",
    "0.0001",
    "--min-result",
    "1",
    "--max-result",
    "1",
    "--attestor",
    attestor,
    ...more,
  ];

  const grant = (maxTtl: string, validFor: string) => [
    "mandate",
    "grant",
    "--keypair",
    "owner.json",
    "--agent",
    w.authority.address,
    "--input-mint",
    w.inputMint,
    "--output-mint",
    w.outputMint,
    "--kinds",
    "swap",
    "--per-intent",
    "10",
    "--total",
    "100",
    "--max-intents",
    "5",
    "--max-ttl",
    maxTtl,
    "--valid-for",
    validFor,
    "--floor-out",
    "1",
    "--floor-in",
    "1",
    "--units",
    "raw",
  ];

  const shownIntent = async (nonce: string) => (await cli(["show", "intent", "--owner", w.owner.address, "--nonce", nonce], {})).json();

  it("create attested takes a spec hash judge fee and spec url", async () => {
    const judge = await generateKeyPairSigner();
    const specUrl = "https://example.org/spec.md";
    const args = attested(judge.address, "--nonce", "3", "--spec-hash", "AB".repeat(32), "--judge-fee", "0.00001", "--spec-url", specUrl);
    const preview = await cli(args, keys);
    expect([preview.code, preview.err]).toEqual([EXIT_OK, ""]);
    expect(preview.json()).toMatchObject({ sent: false, next: NOT_SENT });
    expect(preview.json()["summary"]).toContain(`Publishes: the acceptance spec's url ${specUrl}, in a memo the owner signs`);
    const made = await cli([...args, "--yes"], keys);
    expect([made.code, made.err]).toEqual([EXIT_OK, ""]);
    expect((await shownIntent("3"))["params"]).toEqual({
      kind: "AttestedResult",
      amountIn: "100",
      minResult: "1",
      maxResult: "1",
      attestor: judge.address,
      specHash: "ab".repeat(32),
      judgeFee: "10",
    });
    const [signature] = made.json()["signatures"] as Signature[];
    const landed = signature === undefined ? null : h.svm.getTransaction(signature);
    if (!(landed instanceof TransactionMetadata)) {
      throw new Error("the create did not land");
    }
    expect(landed.logs().some((line) => line.includes(specMemo(specUrl)))).toBe(true);
    expect(await cli(swap("4", "--spec-hash", "ab".repeat(32)), keys)).toMatchObject({ code: EXIT_USAGE, err: "a swap order does not take --spec-hash" });
    expect(await cli(attested(judge.address, "--spec-hash", "ab"), keys)).toMatchObject({ code: EXIT_USAGE, err: SPEC_HASH_FORMAT });
    h.genesis = DEVNET_GENESIS_HASH;
    const plain = "http://127.0.0.1:8080/spec.md";
    const refused = await cli(attested(judge.address, "--nonce", "5", "--spec-hash", "ab".repeat(32), "--spec-url", plain), keys);
    expect(refused).toMatchObject({ code: EXIT_FAILED, err: `--spec-url ${plain} ${PLAIN_HTTP_ON_PUBLIC}` });
  });

  it("create attested without a spec hash creates a plain attested escrow", async () => {
    const judge = await generateKeyPairSigner();
    const [intent] = await findIntentPda({ owner: w.owner.address, nonce: 3n });
    for (const option of ["--judge-fee", "--spec-url"] as const) {
      const value = option === "--judge-fee" ? "0.00001" : "https://example.org/spec.md";
      const refused = await cli(attested(judge.address, "--nonce", "3", option, value, "--yes"), keys);
      expect([refused.code, refused.err, refused.out]).toEqual([EXIT_USAGE, needsSpecHash(option.slice(2)), ""]);
    }
    expect(h.svm.getAccount(intent).exists).toBe(false);
    const preview = await cli(attested(judge.address, "--nonce", "3"), keys);
    expect([preview.code, preview.err]).toEqual([EXIT_OK, ""]);
    expect(preview.json()).toMatchObject({ sent: false, next: NOT_SENT });
    const made = await cli(attested(judge.address, "--nonce", "3", "--yes"), keys);
    expect([made.code, made.err]).toEqual([EXIT_OK, ""]);
    const params = (await shownIntent("3"))["params"] as Json;
    expect(params).toMatchObject({ kind: "AttestedResult", amountIn: "100", minResult: "1", maxResult: "1", attestor: judge.address });
    expect(params["specHash"] ?? "0".repeat(64)).toBe("0".repeat(64));
    expect(balance(w.ownerInput)).toBe(900n);
  });

  it("cancel adds a missing refund account", async () => {
    expect((await cli(swap("1", "--yes"), keys)).code).toBe(EXIT_OK);
    const sink = await ata(w.authority, (await generateKeyPairSigner()).address, w.inputMint);
    await send(w.owner, [
      getTransferInstruction({ source: w.ownerInput, destination: sink, authority: w.owner, amount: balance(w.ownerInput) }),
      getCloseAccountInstruction({ account: w.ownerInput, destination: w.owner.address, owner: w.owner }),
    ]);
    expect(h.svm.getAccount(w.ownerInput).exists).toBe(false);
    const preview = await cli(["cancel", "--keypair", "owner.json", "--nonce", "1", "--close"], keys);
    expect([preview.code, preview.err]).toEqual([EXIT_OK, PREVIEW_ONLY]);
    expect(preview.json()).toMatchObject({ sent: false, next: NOT_SENT });
    expect(preview.json()["summary"]).toContain(`Creates ${w.ownerInput} first, since it is missing; the owner pays its rent`);
    const [intent] = await findIntentPda({ owner: w.owner.address, nonce: 1n });
    const sent = await cli(["cancel", "--keypair", "owner.json", "--nonce", "1", "--close", "--yes"], keys);
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
    expect(sent.json()).toMatchObject({ intent, sent: true, signature: expect.any(String) });
    expect(balance(w.ownerInput)).toBe(ESCROW);
    expect(h.svm.getAccount(intent).exists).toBe(false);
  });

  it("a cancel preview says nothing was sent", async () => {
    expect((await cli(swap("1", "--yes"), keys)).code).toBe(EXIT_OK);
    const cancel = ["cancel", "--keypair", "owner.json", "--nonce", "1"];
    const preview = await cli(cancel, keys);
    expect([preview.code, preview.err]).toEqual([EXIT_OK, PREVIEW_ONLY]);
    expect(preview.json()).toMatchObject({ sent: false, next: NOT_SENT });
    expect(PREVIEW_ONLY).toBe("nothing was sent; pass --yes to sign and send it");
    const text = await cli([...cancel, "--output", "text"], keys);
    expect([text.code, text.err]).toEqual([EXIT_OK, PREVIEW_ONLY]);
    expect(text.out.split("\n")).toContain("sent: false");
    expect((await shownIntent("1"))["status"]).toBe("open");
    const sent = await cli([...cancel, "--yes"], keys);
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
    expect((await shownIntent("1"))["status"]).toBe("cancelled");
    const created = await cli(swap("2"), keys);
    expect([created.code, created.err]).toEqual([EXIT_OK, ""]);
  });

  it("cancel expire and close preview without yes", async () => {
    expect((await cli(swap("1", "--yes"), keys)).code).toBe(EXIT_OK);
    const shortLived = swap("2", "--yes");
    shortLived[shortLived.indexOf("--expires-at") + 1] = (NOW + 10n).toString();
    expect((await cli(shortLived, keys)).code).toBe(EXIT_OK);
    const cranker = await funded();
    const signers = { "c.json": cranker, "owner.json": w.owner };
    const [first] = await findIntentPda({ owner: w.owner.address, nonce: 1n });
    const [second] = await findIntentPda({ owner: w.owner.address, nonce: 2n });
    const steps: [string[], () => Promise<void>][] = [
      [["cancel", "--keypair", "owner.json", "--nonce", "1"], async () => expect((await shownIntent("1"))["status"]).toBe("cancelled")],
      [["close", "--keypair", "owner.json", "--owner", w.owner.address, "--nonce", "1"], async () => expect(h.svm.getAccount(first).exists).toBe(false)],
      [["expire", "--keypair", "c.json", "--owner", w.owner.address, "--nonce", "2"], async () => expect((await shownIntent("2"))["status"]).toBe("expired")],
    ];
    setNow(NOW + 10n);
    for (const [args, after] of steps) {
      const before = balance(w.ownerInput);
      const preview = await cli(args, signers);
      expect([preview.code, preview.err], args.join(" ")).toEqual([EXIT_OK, PREVIEW_ONLY]);
      expect(preview.json()).toMatchObject({ sent: false, next: NOT_SENT, summary: expect.any(Array) });
      expect(BigInt(preview.json()["units_consumed"] as string)).toBeGreaterThan(0n);
      expect(balance(w.ownerInput)).toBe(before);
      const sent = await cli([...args, "--yes"], signers);
      expect([sent.code, sent.err], args.join(" ")).toEqual([EXIT_OK, ""]);
      expect(sent.json()).toMatchObject({ sent: true, signature: expect.any(String) });
      await after();
    }
    expect(h.svm.getAccount(second).exists).toBe(true);
    expect(balance(w.ownerInput)).toBe(1_000n);
    expect(usageOf("cancel").usage).toBe("cancel --keypair <file> --nonce <n> [--close] [--yes]");
  });

  it("create takes pay to", async () => {
    const payee = await funded();
    const preview = await cli(swap("1", "--pay-to", payee.address), keys);
    expect([preview.code, preview.err]).toEqual([EXIT_OK, ""]);
    expect(preview.json()["summary"]).toContain(`Pays to: ${payee.address}, who receives what the solver pays`);
    expect((await cli(swap("1", "--pay-to", payee.address, "--yes"), keys)).code).toBe(EXIT_OK);
    const receiver = await findAssociatedTokenAddress({ owner: payee.address, mint: w.outputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect((await shownIntent("1"))["receiver"]).toBe(receiver);
    expect(h.svm.getAccount(receiver).exists).toBe(true);
    expect(await cli(swap("2", "--pay-to", "nope"), keys)).toMatchObject({ code: EXIT_USAGE, err: "--pay-to is not a base58 address" });
  });

  it("receipt prints the recorded delivery", async () => {
    const [intent] = await findIntentPda({ owner: w.owner.address, nonce: 7n });
    const receipt = ["receipt", "--owner", w.owner.address, "--nonce", "7"];
    expect((await cli(receipt, {})).json()).toEqual({ intent, released: false, next: NOT_RELEASED });
    const worker = await generateKeyPairSigner();
    const judge = await generateKeyPairSigner();
    const payee = await ata(w.authority, worker.address, w.inputMint);
    const tag = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);
    const released = getIntentAttestedEventEncoder().encode({
      intent,
      owner: w.owner.address,
      solver: judge.address,
      payee,
      attestor: judge.address,
      amountIn: 2_500_000n,
      result: 2n,
      fee: 0n,
      net: 2_500_000n,
      filled: 2_500_000n,
      remaining: 0n,
      partnerFee: 0n,
    });
    const created = getIntentCreatedEventEncoder().encode({
      intent,
      owner: w.owner.address,
      nonce: 7n,
      kind: 4,
      inputMint: w.inputMint,
      outputMint: w.outputMint,
      receiver: w.owner.address,
      escrowed: 2_500_000n,
      expiresAt: 0n,
      rentPayer: w.owner.address,
      flags: 0,
      bounty: 0,
      createFee: 0,
    });
    const work = "c".repeat(64);
    const release = { signature: "release", slot: 3n, blockTime: null, failed: false, emitted: [tag(released)], memos: [releaseMemo(work)], memoSigners: [[judge.address]] };
    h.engineLog = [{ ...release, signature: "failed", failed: true }, release, { signature: "create", slot: 1n, blockTime: null, failed: false, emitted: [tag(created)] }];
    const recorded = {
      intent,
      released: true,
      attestor: judge.address,
      result: "2",
      signature: "release",
      delivered_sha256: work,
      paid_to: worker.address,
      payee,
      paid: formatAmount(2_500_000n, 6),
    };
    expect((await cli([...receipt, "--sha256", work.toUpperCase()], {})).json()).toEqual({ ...recorded, matches: true });
    expect((await cli([...receipt, "--sha256", "d".repeat(64)], {})).json()).toEqual({ ...recorded, matches: false });
    expect((await cli(receipt, {})).json()).toEqual(recorded);
    expect(await cli([...receipt, "--sha256", "xyz"], {})).toMatchObject({ code: EXIT_USAGE, err: SHA256_NEEDED });
    expect((await cli([...receipt, "--output", "text"], {})).out).toContain(`delivered_sha256: ${work}`);
  });

  it("durations below a minute name the cli flag", async () => {
    const timeless = swap("1", "--yes").filter((a) => a !== "--expires-at" && a !== (NOW + 3_600n).toString());
    const refusals = [
      [[...timeless, "--expires-in", "59"], `--expires-in must be an integer from ${MIN_EXPIRES_IN} to ${MAX_EXPIRES_IN}`],
      [grant("59", "3600"), `--max-ttl must be an integer from ${MIN_EXPIRES_IN} to ${MAX_EXPIRES_IN}`],
      [grant("3600", "59"), `--valid-for must be an integer from ${MIN_EXPIRES_IN} to ${MAX_EXPIRES_IN}`],
    ] as const;
    for (const [args, refusal] of refusals) {
      const run = await cli([...args], keys);
      expect([run.code, run.err, run.out]).toEqual([EXIT_USAGE, refusal, ""]);
    }
    expect((await cli([...timeless, "--expires-in", String(MIN_EXPIRES_IN)], keys)).code).toBe(EXIT_OK);
  });
});
