import { type Address, generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { getApproveInstruction, getTokenDecoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { beforeEach, describe, expect, it } from "vitest";
import { findAssociatedTokenAddress, findIntentPda, splitFee } from "@intent-engine/core";
import { ALLOWANCE_LOW, ALLOWANCE_SPENT } from "@intent-engine/solver";
import { DEFAULT_URL, ENV_KEYPAIR, FLOAT_SHOW_TAKES, FLOAT_TAKES, INVENTORY_OWNER_ALONE, parse, SOLVER_NEEDS_FLOAT, UsageError } from "../src/args.js";
import { FLOAT_TO_OWNER, replacesDelegate } from "../src/float-commands.js";
import { signsOnDevice } from "../src/ledger-keys.js";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "../src/main.js";
import { ata, balance, cli, ESCROW, FEE_BPS, funded, h, mint, NOW, send, type World, world } from "./harness.js";

const A = "So11111111111111111111111111111111111111112" as Address;
const B = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;
const C = "SysvarC1ock11111111111111111111111111111111" as Address;

const usage = (argv: string[]) => {
  try {
    parse(argv);
  } catch (error) {
    if (error instanceof UsageError) {
      return error.message;
    }
    throw error;
  }
  return null;
};

const allowance = (account: Address) => {
  const view = h.svm.getAccount(account);
  return view.exists ? getTokenDecoder().decode(view.data).delegatedAmount : -1n;
};

describe("solver float arguments", () => {
  it("reads float, float show and --inventory-owner, and refuses what each does not take", () => {
    expect(parse(["solver", "float", "--keypair", "o.json", "--delegate", A, "--mint", B, "--amount", "2.5"])).toEqual({
      name: "solver-float",
      url: DEFAULT_URL,
      priority: 0n,
      keypair: "o.json",
      yes: false,
      delegate: A,
      mint: B,
      amount: { tokens: "2.5", side: "input" },
    });
    expect(parse(["solver", "float", "--keypair", "o.json", "--delegate", A, "--mint", B, "--amount", "7", "--units", "raw", "--yes"])).toMatchObject({ amount: "7", yes: true });
    expect(parse(["solver", "float", "show", "--owner", C, "--delegate", A, "--mints", `${B},${A}`])).toEqual({
      name: "solver-float-show",
      url: DEFAULT_URL,
      priority: 0n,
      owner: C,
      delegate: A,
      mints: [B, A],
    });
    expect(parse(["solver", "float", "show", "--owner", C, "--delegate", A])).toMatchObject({ mints: null });
    expect(parse(["solver", "float", "show", "--owner", C, "--delegate", A], { [ENV_KEYPAIR]: "k.json" })).toMatchObject({ name: "solver-float-show" });
    expect(usage(["solver"])).toBe(SOLVER_NEEDS_FLOAT);
    expect(usage(["solver", "table"])).toBe(SOLVER_NEEDS_FLOAT);
    expect(usage(["solver", "float", "list"])).toBe(SOLVER_NEEDS_FLOAT);
    expect(usage(["solver", "float", "show", "x", "--owner", C])).toBe("unexpected argument x");
    expect(usage(["solver", "float", "show", "--owner", C, "--delegate", A, "--keypair", "o.json"])).toBe(FLOAT_SHOW_TAKES);
    expect(usage(["solver", "float", "show", "--owner", C, "--delegate", A, "--amount", "1"])).toBe(FLOAT_SHOW_TAKES);
    expect(usage(["solver", "float", "show", "--owner", C, "--delegate", A, "--yes"])).toBe(FLOAT_SHOW_TAKES);
    expect(usage(["solver", "float", "show", "--delegate", A])).toBe("missing --owner");
    expect(usage(["solver", "float", "--keypair", "o.json", "--delegate", A, "--mint", B, "--amount", "1", "--owner", C])).toBe(FLOAT_TAKES);
    expect(usage(["solver", "float", "--keypair", "o.json", "--delegate", A, "--mint", B])).toBe("missing --amount");
    expect(usage(["solver", "float", "--keypair", "o.json", "--mint", B, "--amount", "1"])).toBe("missing --delegate");
    expect(usage(["solver", "float", "--keypair", "o.json", "--delegate", A, "--mint", B, "--amount", "1", "--jupiter", "https://q.example"])).toBe(
      "solver float does not take --jupiter",
    );
    expect(signsOnDevice(parse(["solver", "float", "--keypair", "usb://ledger", "--delegate", A, "--mint", B, "--amount", "1"]))).toBe(true);
  });

  it("solve takes --inventory-owner only with --inventory and no route", () => {
    const stocking = ["solve", "--keypair", "k", "--min-profit", `${B}=1`, "--inventory", `${A}:${B}=1/1`];
    expect(parse([...stocking, "--inventory-owner", C])).toMatchObject({ inventoryOwner: C });
    expect(parse(stocking)).not.toHaveProperty("inventoryOwner");
    expect(usage([...stocking, "--inventory-owner", C, "--issue", `${A}:${B}=1/1`])).toBe(INVENTORY_OWNER_ALONE);
    expect(usage([...stocking, "--inventory-owner", C, "--jupiter", "https://q.example"])).toBe(INVENTORY_OWNER_ALONE);
    expect(usage(["solve", "--keypair", "k", "--min-profit", `${B}=1`, "--issue", `${A}:${B}=1/1`, "--inventory-owner", C])).toBe(INVENTORY_OWNER_ALONE);
    expect(usage([...stocking, "--inventory-owner", "nope"])).toMatch(/^--inventory-owner/);
  });
});

describe("solver float on the engine", () => {
  let w: World;
  let solver: KeyPairSigner;
  let keys: Record<string, KeyPairSigner>;

  beforeEach(async () => {
    w = await world();
    solver = await funded();
    keys = { "owner.json": w.owner, "s.json": solver };
  });

  const floating = (amount: string, ...rest: string[]) =>
    cli(["solver", "float", "--keypair", "owner.json", "--delegate", solver.address, "--mint", w.inputMint, "--amount", amount, "--url", "http://cluster", ...rest], keys);

  const showing = () =>
    cli(["solver", "float", "show", "--owner", w.owner.address, "--delegate", solver.address, "--mints", `${w.inputMint},${w.outputMint}`, "--url", "http://cluster"], keys);

  it("approves the solver key for the amount, and float show reads what it may still spend", async () => {
    const preview = await floating("0.0005");
    expect([preview.code, preview.err]).toEqual([EXIT_OK, ""]);
    expect(preview.json()).toMatchObject({ account: w.ownerInput, delegate: solver.address, allowance: "500", sent: false, warnings: [] });
    expect(preview.json()["summary"]).toEqual([`Lets ${solver.address} spend up to 0.0005 from ${w.ownerInput} (now 0), and nothing else the owner holds`]);
    expect(allowance(w.ownerInput)).toBe(0n);
    const sent = await floating("500", "--units", "raw", "--yes");
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
    expect(sent.json()).toMatchObject({ sent: true });
    expect(allowance(w.ownerInput)).toBe(500n);
    const outputAccount = await findAssociatedTokenAddress({ owner: w.owner.address, mint: w.outputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect((await showing()).json()).toEqual({
      owner: w.owner.address,
      delegate: solver.address,
      floats: [
        { mint: w.inputMint, account: w.ownerInput, balance: "0.001", allowance: "0.0005", spendable: "0.0005" },
        { mint: w.outputMint, account: outputAccount, balance: "0", allowance: "0", spendable: "0" },
      ],
    });
    await floating("2000", "--units", "raw", "--yes");
    expect((await showing()).json()["floats"]).toMatchObject([{ allowance: "0.002", spendable: "0.001" }, {}]);
    const other = (await generateKeyPairSigner()).address;
    const elsewhere = await cli(["solver", "float", "show", "--owner", w.owner.address, "--delegate", other, "--mints", w.inputMint, "--url", "http://cluster"], keys);
    expect(elsewhere.json()["floats"]).toEqual([{ mint: w.inputMint, account: w.ownerInput, balance: "0.001", allowance: "0", spendable: "0" }]);
  });

  it("warns that a float replaces another delegate, and refuses the owner as its own delegate or a missing account", async () => {
    const other = (await generateKeyPairSigner()).address;
    await send(w.owner, [getApproveInstruction({ source: w.ownerInput, delegate: other, owner: w.owner, amount: 9n })]);
    const replacing = (await floating("1", "--units", "raw")).json();
    expect(replacing["warnings"]).toEqual([replacesDelegate(other, w.ownerInput)]);
    expect(replacing["summary"]).toContain(`WARNING: ${replacesDelegate(other, w.ownerInput)}`);
    const self = await cli(["solver", "float", "--keypair", "owner.json", "--delegate", w.owner.address, "--mint", w.inputMint, "--amount", "1", "--url", "http://cluster"], keys);
    expect([self.code, self.err]).toEqual([EXIT_FAILED, FLOAT_TO_OWNER]);
    const empty = await funded();
    const missing = await cli(["solver", "float", "--keypair", "e.json", "--delegate", solver.address, "--mint", w.inputMint, "--amount", "1", "--url", "http://cluster"], { "e.json": empty });
    expect(missing.code).toBe(EXIT_FAILED);
    expect(missing.err).toBe(
      `${empty.address} holds no token account for ${w.inputMint} at ${await findAssociatedTokenAddress({ owner: empty.address, mint: w.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS })}`,
    );
    expect((await cli(["solver", "float", "--keypair", "owner.json"], keys)).code).toBe(EXIT_USAGE);
  });

  it("solve --inventory-owner fills from the owner's float, pays the owner, and says when the float runs low", async () => {
    const holder = await funded();
    keys["holder.json"] = holder;
    const issued = await mint(w.authority, 6);
    const receiver = await ata(w.authority, w.owner.address, issued);
    const net = splitFee(ESCROW, FEE_BPS).net;
    const holderOutput = await ata(w.authority, holder.address, issued, 10n * net);
    await ata(w.authority, w.feeRecipient.address, w.inputMint);
    h.watched.length = 0;
    h.watched.push(w.owner.address);
    const create = (nonce: string) =>
      cli(
        ["create", "swap", "--keypair", "owner.json", "--nonce", nonce, "--input-mint", w.inputMint, "--output-mint", issued, "--expires-at", (NOW + 3_600n).toString(), "--amount-in", ESCROW.toString(), "--min-out", "300", "--units", "raw", "--url", "http://cluster", "--yes"],
        keys,
      );
    expect((await create("1")).code).toBe(EXIT_OK);
    expect((await create("2")).code).toBe(EXIT_OK);
    const [first] = await findIntentPda({ owner: w.owner.address, nonce: 1n });
    const [second] = await findIntentPda({ owner: w.owner.address, nonce: 2n });
    const floated = await cli(["solver", "float", "--keypair", "holder.json", "--delegate", solver.address, "--mint", issued, "--amount", "450", "--units", "raw", "--url", "http://cluster", "--yes"], keys);
    expect([floated.code, floated.err]).toEqual([EXIT_OK, ""]);
    const run = await cli(["solve", "--keypair", "s.json", "--inventory", `${w.inputMint}:${issued}=1/1`, "--inventory-owner", holder.address, "--min-profit", `${issued}=1`, "--url", "http://cluster"], keys);
    expect([run.code, run.err]).toEqual([EXIT_OK, ""]);
    const report = run.json() as { filled: { intent: Address }[]; skipped: { intent: Address; reason: string }[]; low: unknown };
    expect(report.filled).toHaveLength(1);
    const left = report.filled[0]?.intent === first ? second : first;
    expect(report.skipped).toEqual([{ intent: left, reason: `${ALLOWANCE_SPENT}: 150 left, 300 needed` }]);
    expect(report.low).toEqual([{ account: holderOutput, left: "150", needed: "300", warning: `${ALLOWANCE_LOW}: 150 left, 300 needed` }]);
    const holderInput = await findAssociatedTokenAddress({ owner: holder.address, mint: w.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect([balance(receiver), balance(holderOutput), balance(holderInput), allowance(holderOutput)]).toEqual([300n, 10n * net - 300n, net, 150n]);
    const solverOutput = await findAssociatedTokenAddress({ owner: solver.address, mint: issued, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(balance(solverOutput)).toBe(-1n);
    h.rounds = 1;
    h.waits.length = 0;
    h.changed = [];
    const watched = await cli(["solve", "--keypair", "s.json", "--inventory", `${w.inputMint}:${issued}=1/1`, "--inventory-owner", holder.address, "--min-profit", `${issued}=1`, "--url", "http://cluster", "--watch"], keys);
    expect([watched.code, watched.err]).toEqual([EXIT_OK, ""]);
    expect(watched.each().filter((line) => "low" in line).map((line) => line["low"])).toEqual([
      [{ account: holderOutput, left: "150", needed: "300", warning: `${ALLOWANCE_LOW}: 150 left, 300 needed` }],
    ]);
  });
});
