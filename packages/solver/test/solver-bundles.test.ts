import {
  type Address,
  type Base64EncodedWireTransaction,
  generateKeyPairSigner,
  getCompiledTransactionMessageDecoder,
  getBase64Encoder,
  getTransactionDecoder,
  type KeyPairSigner,
  lamports,
} from "@solana/kit";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { LiteSVM } from "litesvm";
import { beforeEach, describe, expect, it } from "vitest";
import { type IntentParams, IntentStatus } from "@intent-engine/core";
import {
  decodeParamsLoose,
  remainingOf,
  requiredOut,
  buildInitUser,
  getIntentDecoder,
} from "@intent-engine/core/internal";
import {
  badBundleSize,
  LAMPORTS_PER_SIGNATURE,
  tooCostly,
  SIMULATION_REFUSED,
  tick,
} from "../src/index.js";
import {
  AMOUNT,
  deployEngine,
  type Engine,
  engineTools,
  MIN_OUT,
  NOW,
  stashMarket,
} from "./solver-engine.js";

let svm: LiteSVM;

describe("solver against the deployed engine", () => {
  let authority: KeyPairSigner;
  let feeRecipient: KeyPairSigner;
  let owner: KeyPairSigner;
  let solver: KeyPairSigner;
  let stash: KeyPairSigner;
  let inputMint: Address;
  let outputMint: Address;
  let receiver: Address;
  let solverInput: Address;
  let solverOutput: Address;
  let stashAccount: Address;
  let feeTo: Address;
  let intents: Address[];

  const engine = (): Engine => ({ svm, authority, feeRecipient, owner, solver, stash, inputMint, outputMint, receiver, solverInput, solverOutput, stashAccount, feeTo, intents });
  const { send, funded, ata, balance, chain, submit, open, simulated, landed, solve, budgetOf, accountsIn, tipOf, bundled } = engineTools(engine);

  beforeEach(async () => {
    ({ svm, authority, feeRecipient, owner, solver, stash, inputMint, outputMint, receiver, solverInput, solverOutput, stashAccount, feeTo, intents } = await deployEngine());
  });

  it("bids the priority price it is given and reports a bundle as sent, not filled, until it lands", async () => {
    const intent = await open(13n);
    const sent: Base64EncodedWireTransaction[] = [];
    const priced: (readonly unknown[])[] = [];
    const report = await solve(stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 4_000n), {
      unitPrice: async (instructions) => {
        priced.push(instructions);
        return 7_000n;
      },
      send: async (wire) => {
        sent.push(wire);
        return { signature: "bundle-1", confirmed: false };
      },
    });
    expect(report).toEqual({ filled: [], sent: [{ intent, profit: 4_000n, cost: expect.any(BigInt), signature: "bundle-1" }], skipped: [], failed: [] });
    expect(priced).toHaveLength(1);
    expect(sent.map((wire) => budgetOf(wire, 3))).toEqual([7_000n]);
    const free = await solve(stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 4_000n), {
      send: async (wire) => {
        sent.push(wire);
        return landed(wire);
      },
    });
    expect(free.filled).toHaveLength(1);
    expect(budgetOf(sent[1] ?? ("" as Base64EncodedWireTransaction), 3)).toBeNull();
  });

  it("pays a bundle tip of exactly the lamports it is told to the account it is told, last, from the solver", async () => {
    const intent = await open(14n);
    const tipAccount = (await generateKeyPairSigner()).address;
    svm.airdrop(tipAccount, lamports(1_000_000_000n));
    const before = svm.getBalance(tipAccount) ?? 0n;
    const solverBefore = svm.getBalance(solver.address) ?? 0n;
    const sent: Base64EncodedWireTransaction[] = [];
    const report = await solve(stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 4_000n), {
      tip: { account: tipAccount, lamports: 12_345n },
      send: async (wire) => {
        sent.push(wire);
        return landed(wire);
      },
    });
    expect(report.filled).toEqual([{ intent, profit: 4_000n, cost: expect.any(BigInt), signature: expect.any(String) }]);
    expect((svm.getBalance(tipAccount) ?? 0n) - before).toBe(12_345n);
    expect(solverBefore - (svm.getBalance(solver.address) ?? 0n)).toBeGreaterThanOrEqual(12_345n);
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(sent[0] ?? ("" as Base64EncodedWireTransaction)));
    const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    const instructions = "instructions" in message ? message.instructions : [];
    const last = instructions.at(-1);
    expect(message.staticAccounts[last?.programAddressIndex ?? -1]).toBe(SYSTEM_PROGRAM_ADDRESS);
    expect(last?.accountIndices?.map((i) => message.staticAccounts[i])).toEqual([solver.address, tipAccount]);
  });

  it("sends three fills of a tick as one bundle that pays one tip, on its last transaction", async () => {
    const { opened, tipAccount, bundles, report, tipped } = await bundled(3);
    expect([report.filled, report.skipped, report.failed]).toEqual([[], [], []]);
    expect(new Set(report.sent.map((s) => s.intent))).toEqual(new Set(opened));
    expect(report.sent.map((s) => [s.profit, s.signature])).toEqual(opened.map(() => [4_000n, "bundle-1"]));
    expect(bundles).toHaveLength(1);
    expect(bundles[0]?.map(tipOf)).toEqual([null, null, tipAccount]);
    expect(bundles[0]?.map((wire) => accountsIn(wire).includes(tipAccount))).toEqual([false, false, true]);
    expect(tipped).toBe(12_345n);
    expect(balance(receiver)).toBe(3n * MIN_OUT);
  });

  it("lands a bundle's transactions in order, pays every receiver at least its required and the tip once", async () => {
    const receivers: Address[] = [];
    const opened: Address[] = [];
    for (let i = 0; i < 3; i += 1) {
      owner = await funded();
      await ata(authority, owner.address, inputMint, 10_000_000n);
      receivers.push(await ata(authority, owner.address, outputMint));
      await send(owner, [await buildInitUser({ owner })]);
      opened.push(await open(1n + BigInt(i)));
    }
    const required = new Map<Address, bigint>();
    for (const { address, intent } of await chain().intents()) {
      required.set(address, requiredOut(decodeParamsLoose(intent.kind, Uint8Array.from(intent.params)) as IntentParams, remainingOf(intent), NOW));
    }
    const tipAccount = (await generateKeyPairSigner()).address;
    svm.airdrop(tipAccount, lamports(1_000_000_000n));
    const before = svm.getBalance(tipAccount) ?? 0n;
    const landedInOrder: string[] = [];
    const report = await solve(stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 4_000n), {
      tip: { account: tipAccount, lamports: 12_345n },
      sendBundle: async (wires) => {
        for (const wire of wires) {
          landedInOrder.push(await submit(wire));
        }
        return "bundle-landed";
      },
    });
    expect(report.sent.map((s) => s.signature)).toEqual(opened.map(() => "bundle-landed"));
    expect(landedInOrder).toHaveLength(3);
    opened.forEach((intent, i) => {
      const stored = svm.getAccount(intent);
      expect(getIntentDecoder().decode(stored.exists ? stored.data : new Uint8Array()).status).toBe(IntentStatus.Filled);
      expect(required.get(intent)).toBe(MIN_OUT);
      expect(balance(receivers[i] ?? receiver)).toBeGreaterThanOrEqual(required.get(intent) ?? AMOUNT);
    });
    expect((svm.getBalance(tipAccount) ?? 0n) - before).toBe(12_345n);
  });

  it("splits seven fills into bundles of the bundle size, each tipped once", async () => {
    const { opened, tipAccount, bundles, report, tipped } = await bundled(7, { bundleSize: 5 });
    expect(report.sent).toHaveLength(7);
    expect(new Set(report.sent.map((s) => s.intent))).toEqual(new Set(opened));
    expect(bundles.map((wires) => wires.map(tipOf))).toEqual([
      [null, null, null, null, tipAccount],
      [null, tipAccount],
    ]);
    expect(report.sent.filter((s) => s.signature === "bundle-1")).toHaveLength(5);
    expect(report.sent.filter((s) => s.signature === "bundle-2")).toHaveLength(2);
    expect(tipped).toBe(2n * 12_345n);
    expect(balance(receiver)).toBe(7n * MIN_OUT);
  });

  it("keeps a fill that fails its checks out of the bundle, and checks each transaction as it is sent", async () => {
    const bad = await open(30n);
    const simulatedWires: Base64EncodedWireTransaction[] = [];
    const { opened, tipAccount, bundles, report, tipped } = await bundled(2, {
      simulate: async (wire, watch) => {
        simulatedWires.push(wire);
        return accountsIn(wire).includes(bad) ? { err: "InstructionError", unitsConsumed: null, balances: [] } : simulated(wire, watch);
      },
    });
    expect(report.failed).toEqual([{ intent: bad, error: `${SIMULATION_REFUSED}: InstructionError` }]);
    expect(new Set(report.sent.map((s) => s.intent))).toEqual(new Set(opened));
    expect(bundles).toHaveLength(1);
    expect(bundles[0]?.some((wire) => accountsIn(wire).includes(bad))).toBe(false);
    expect(bundles[0]?.map(tipOf)).toEqual([null, tipAccount]);
    expect(bundles[0]?.every((wire) => simulatedWires.includes(wire))).toBe(true);
    expect(tipped).toBe(12_345n);
    const cost = 2n * LAMPORTS_PER_SIGNATURE + 12_345n;
    const dear = await bundled(2, { maxSolCost: cost - 1n }, 20);
    expect(dear.bundles).toEqual([]);
    expect(dear.report.skipped.filter((s) => dear.opened.includes(s.intent)).map((s) => s.reason)).toEqual([tooCostly(cost, cost - 1n), tooCostly(cost, cost - 1n)]);
  });

  it("reports every fill of a bundle the engine refused as failed with its error", async () => {
    const opened = [await open(40n), await open(41n)];
    const tipAccount = (await generateKeyPairSigner()).address;
    svm.airdrop(tipAccount, lamports(1_000_000_000n));
    const report = await solve(stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 4_000n), {
      tip: { account: tipAccount, lamports: 12_345n },
      sendBundle: async () => {
        throw new Error("jito rejected the bundle with status 429");
      },
    });
    expect([report.filled, report.sent, report.skipped]).toEqual([[], [], []]);
    expect(new Set(report.failed.map((f) => f.intent))).toEqual(new Set(opened));
    expect(report.failed.map((f) => f.error)).toEqual(opened.map(() => "jito rejected the bundle with status 429"));
    expect(balance(receiver)).toBe(0n);
  });

  it("sends each fill on its own with its own tip when it has no bundle sender, and refuses a bad bundle size", async () => {
    const opened = [await open(50n), await open(51n), await open(52n)];
    const tipAccount = (await generateKeyPairSigner()).address;
    svm.airdrop(tipAccount, lamports(1_000_000_000n));
    const before = svm.getBalance(tipAccount) ?? 0n;
    const sent: Base64EncodedWireTransaction[] = [];
    const report = await solve(stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 4_000n), {
      tip: { account: tipAccount, lamports: 12_345n },
      send: async (wire) => {
        sent.push(wire);
        return landed(wire);
      },
    });
    expect(new Set(report.filled.map((f) => f.intent))).toEqual(new Set(opened));
    expect(sent.map(tipOf)).toEqual([tipAccount, tipAccount, tipAccount]);
    expect((svm.getBalance(tipAccount) ?? 0n) - before).toBe(3n * 12_345n);
    for (const bad of [0, 6, 1.5]) {
      await expect(solve(stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT), { bundleSize: bad })).rejects.toThrow(badBundleSize(bad));
    }
  });
});
