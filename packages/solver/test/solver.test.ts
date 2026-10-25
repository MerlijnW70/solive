import type { Address, Base64EncodedWireTransaction, KeyPairSigner } from "@solana/kit";
import { LiteSVM } from "litesvm";
import { beforeEach, describe, expect, it } from "vitest";
import { IntentStatus, splitFees } from "@intent-engine/core";
import { getIntentDecoder } from "@intent-engine/core/internal";
import {
  backingOff,
  backoff,
  FAILED_ON_CHAIN,
  type Flight,
  landings,
  headroom,
  MAX_COMPUTE_UNITS,
  SIMULATION_REFUSED,
  type Simulated,
} from "../src/index.js";
import {
  AMOUNT,
  deployEngine,
  type Engine,
  engineTools,
  MIN_OUT,
  stashMarket,
  swapping,
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
  const { balance, chain, open, simulated, landed, solve, budgetOf } = engineTools(engine);

  beforeEach(async () => {
    ({ svm, authority, feeRecipient, owner, solver, stash, inputMint, outputMint, receiver, solverInput, solverOutput, stashAccount, feeTo, intents } = await deployEngine());
  });

  it("fills a profitable intent through a flash route, keeps the spread and pays exact fees", async () => {
    const intent = await open(1n);
    const report = await solve(stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 4_000n));
    expect(report.skipped).toEqual([]);
    expect(report.failed).toEqual([]);
    expect(report.filled).toEqual([{ intent, profit: 4_000n, cost: expect.any(BigInt), signature: expect.any(String) }]);
    const fees = splitFees(AMOUNT, 5, 0, 0);
    expect(balance(receiver)).toBe(MIN_OUT);
    expect(balance(solverOutput)).toBe(4_000n);
    expect([balance(solverInput), balance(swapping.current?.to ?? solverInput)]).toEqual([0n, fees.net]);
    expect(balance(feeTo)).toBe(fees.protocol);
    const stored = svm.getAccount(intent);
    const state = getIntentDecoder().decode(stored.exists ? stored.data : new Uint8Array());
    expect(state.status).toBe(IntentStatus.Filled);
    const again = await solve(stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 4_000n));
    expect(again).toEqual({ filled: [], sent: [], skipped: [{ intent, reason: "not open" }], failed: [] });
  });

  it("asks only for the compute a simulation measured, padded, and the maximum when it cannot measure", async () => {
    const pricer = () => stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 4_000n);
    const measure = async (simulate: (wire: Base64EncodedWireTransaction, watch: readonly Address[]) => Promise<Simulated>) => {
      const sent: Base64EncodedWireTransaction[] = [];
      const seen: (bigint | null)[] = [];
      const report = await solve(pricer(), {
        simulate: async (wire, watch) => {
          const result = await simulate(wire, watch);
          seen.push(result.unitsConsumed);
          return result;
        },
        send: async (wire) => {
          sent.push(wire);
          return landed(wire);
        },
      });
      expect(report.failed).toEqual([]);
      expect(report.filled).toHaveLength(1);
      return { limit: sent.map((wire) => budgetOf(wire, 2)), seen };
    };
    await open(10n);
    const sized = await measure(simulated);
    const used = sized.seen[0] ?? 0n;
    expect(used).toBeGreaterThan(0n);
    expect(sized.limit).toEqual([headroom(used)]);
    expect(headroom(used)).toBeLessThan(MAX_COMPUTE_UNITS / 10);
    await open(11n);
    const blind = await measure(async (wire, watch) => ({ ...(await simulated(wire, watch)), unitsConsumed: null }));
    expect(blind.limit).toEqual([MAX_COMPUTE_UNITS]);
  });

  it("never sends a fill that fails its simulation and says why", async () => {
    const intent = await open(12n);
    const sent: Base64EncodedWireTransaction[] = [];
    const report = await solve(stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 4_000n), {
      simulate: async () => ({ err: "InstructionError", unitsConsumed: 900n, balances: [] }),
      send: async (wire) => {
        sent.push(wire);
        return landed(wire);
      },
    });
    expect(SIMULATION_REFUSED).toBe("the fill failed in simulation, so it was not sent");
    expect(report).toEqual({ filled: [], sent: [], skipped: [], failed: [{ intent, error: `${SIMULATION_REFUSED}: InstructionError` }] });
    expect(sent).toEqual([]);
    expect(balance(receiver)).toBe(0n);
  });

  it("asks its confirm hook about the intent and its own token accounts before it sends, and skips with the hook's reason", async () => {
    const intent = await open(13n);
    const asked: [Address, readonly Address[]][] = [];
    const sent: Base64EncodedWireTransaction[] = [];
    const market = () => stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 4_000n);
    const hooked = (reason: string | null) => ({
      confirm: async (at: Address, accounts: readonly Address[]) => {
        asked.push([at, accounts]);
        return reason;
      },
      send: async (wire: Base64EncodedWireTransaction) => {
        sent.push(wire);
        return landed(wire);
      },
    });
    const refused = await solve(market(), hooked("the second node disagrees"));
    expect(refused).toEqual({ filled: [], sent: [], skipped: [{ intent, reason: "the second node disagrees" }], failed: [] });
    expect([asked, sent]).toEqual([[[intent, [solverInput, solverOutput]]], []]);
    const agreed = await solve(market(), hooked(null));
    expect(agreed.filled.map((f) => f.intent)).toEqual([intent]);
    expect(sent).toHaveLength(1);
  });

  it("the sent transaction is simulated with its own compute limit", async () => {
    const pricer = () => stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 4_000n);
    const tight = await open(61n);
    const refusedSims: Base64EncodedWireTransaction[] = [];
    const refusedSends: Base64EncodedWireTransaction[] = [];
    const refused = await solve(pricer(), {
      simulate: async (wire, watch) => {
        refusedSims.push(wire);
        return budgetOf(wire, 2) === MAX_COMPUTE_UNITS ? simulated(wire, watch) : { err: "ComputationalBudgetExceeded", unitsConsumed: null, balances: [] };
      },
      send: async (wire) => {
        refusedSends.push(wire);
        return landed(wire);
      },
    });
    expect(refused).toEqual({
      filled: [],
      sent: [],
      skipped: [],
      failed: [{ intent: tight, error: `${SIMULATION_REFUSED}: ComputationalBudgetExceeded` }],
    });
    expect(refusedSims).toHaveLength(2);
    expect(refusedSends).toEqual([]);
    expect(balance(receiver)).toBe(0n);
    const sims: { wire: Base64EncodedWireTransaction; used: bigint | null }[] = [];
    const sent: Base64EncodedWireTransaction[] = [];
    const filled = await solve(pricer(), {
      simulate: async (wire, watch) => {
        const result = await simulated(wire, watch);
        sims.push({ wire, used: result.unitsConsumed });
        return result;
      },
      send: async (wire) => {
        sent.push(wire);
        return landed(wire);
      },
    });
    expect(filled.filled.map((f) => f.intent)).toEqual([tight]);
    const used = sims[0]?.used ?? 0n;
    expect(used).toBeGreaterThan(0n);
    expect(sims.map((s) => budgetOf(s.wire, 2))).toEqual([MAX_COMPUTE_UNITS, headroom(used)]);
    expect(sent).toEqual([sims[1]?.wire]);
    expect(balance(receiver)).toBe(MIN_OUT);
  });

  it("a fill that failed on chain is backed off", async () => {
    const intent = await open(62n);
    const interval = 5;
    let clock = 0;
    const held = backoff(interval, () => clock);
    const pricer = () => stashMarket(stash, stashAccount, outputMint, solverOutput, () => MIN_OUT + 4_000n);
    const flights = new Map<Address, Flight>();
    const signatures: string[] = [];
    let tried = 0;
    const run = async (at: bigint) => {
      const result = await solve(pricer(), {
        backoff: held,
        simulate: async (wire, watch) => {
          tried += 1;
          return simulated(wire, watch);
        },
        send: async () => {
          const signature = `lost-${signatures.length}`;
          signatures.push(signature);
          return { signature, confirmed: false };
        },
      });
      for (const { intent: address, signature } of result.sent) {
        flights.set(address, { until: at + 10n, signature });
      }
      return result;
    };
    const asked: string[] = [];
    const failedOnChain = async (signature: string) => {
      asked.push(signature);
      return signature.startsWith("lost-");
    };
    expect((await run(0n)).sent.map((s) => s.intent)).toEqual([intent]);
    expect(held.size()).toBe(0);
    expect(await landings(flights, 9n, await chain().intents(), failedOnChain, held)).toEqual([]);
    expect(asked).toEqual([]);
    expect(await landings(flights, 10n, await chain().intents(), failedOnChain, held)).toEqual([
      { intent, error: `${FAILED_ON_CHAIN}: lost-0` },
    ]);
    expect(flights.size).toBe(0);
    const triedBefore = tried;
    expect((await run(10n)).skipped).toEqual([{ intent, reason: backingOff(1, interval) }]);
    expect(tried).toBe(triedBefore);
    clock = interval * 1_000;
    expect((await run(20n)).sent.map((s) => s.intent)).toEqual([intent]);
    expect(await landings(flights, 30n, await chain().intents(), failedOnChain, held)).toEqual([
      { intent, error: `${FAILED_ON_CHAIN}: lost-1` },
    ]);
    expect((await run(30n)).skipped).toEqual([{ intent, reason: backingOff(2, 2 * interval) }]);
    expect(asked).toEqual(["lost-0", "lost-1"]);
    clock += 2 * interval * 1_000;
    expect((await run(40n)).sent.map((s) => s.intent)).toEqual([intent]);
    const listed = await chain().intents();
    expect(await landings(flights, 50n, listed, async () => false, held)).toEqual([]);
    expect(listed.map((entry) => held.waiting(entry.address, entry.intent))).toEqual([null]);
    expect(balance(receiver)).toBe(0n);
  });
});
