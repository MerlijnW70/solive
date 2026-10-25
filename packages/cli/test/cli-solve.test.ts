import {
  AccountRole,
  type Address,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  generateKeyPairSigner,
  type KeyPairSigner,
} from "@solana/kit";
import { getMintToInstruction, getApproveInstruction, getTransferCheckedInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { beforeEach, describe, expect, it } from "vitest";
import { findAssociatedTokenAddress } from "@intent-engine/core";
import { findIntentPda, splitFee } from "@intent-engine/core/internal";
import { ENV_JUPITER_KEY, JUPITER_DOMAIN, jupiterHost, stillOpen, SOLVER_TABLE_NEXT } from "../src/commands.js";
import { EXIT_OK } from "../src/main.js";
import { JITO_TIP_ACCOUNTS, MAX_COMPUTE_UNITS, NET_BELOW_FLOOR, SIMULATION_REFUSED } from "@intent-engine/solver";
import { ata, balance, cli, ESCROW, FEE_BPS, funded, h, mint, NOW, send, transport, world } from "./harness.js";
import { createSwap, type Json, unitLimitOf } from "./cli-kit.js";

describe("cli against the deployed engine", () => {
  let authority: KeyPairSigner;
  let feeRecipient: KeyPairSigner;
  let owner: KeyPairSigner;
  let inputMint: Address;
  let outputMint: Address;

  beforeEach(async () => {
    ({ authority, feeRecipient, owner, inputMint, outputMint } = await world());
  });

  const create = (nonce: string, expiresAt: bigint) => createSwap(inputMint, outputMint, nonce, expiresAt);

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
});
