import { AccountRole, type Address, type Blockhash, generateKeyPairSigner, type Instruction } from "@solana/kit";
import { COMPUTE_BUDGET_ADDRESS, computeUnitLimit, computeUnitPrice, MAX_COMPUTE_UNITS } from "@intent-engine/solver";
import { describe, expect, it } from "vitest";
import type { Simulation, Transport } from "@intent-engine/client";
import {
  AUTO_PERCENTILE,
  AUTO_PRICE_CAP,
  budgeted,
  headroom,
  percentile,
  priceOf,
  priorityLamports,
  UNIT_HEADROOM_DIVISOR,
  UNIT_HEADROOM_FLOOR,
  withPriority,
  writableAccounts,
} from "../src/compute.js";

const A = "11111111111111111111111111111112" as Address;
const B = "SysvarC1ock11111111111111111111111111111111" as Address;
const C = "SysvarRent111111111111111111111111111111111" as Address;
const PROGRAM = "So11111111111111111111111111111111111111112" as Address;

const ix = (accounts: { address: Address; role: AccountRole }[]): Instruction => ({
  programAddress: PROGRAM,
  accounts,
  data: new Uint8Array([7]),
});

function fake(simulation: Simulation, fees: bigint[] = []) {
  const seen = { simulated: 0, feeAccounts: [] as Address[][], sent: [] as Instruction[][] };
  const transport = {
    latestBlockhash: async () => ({ blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: 9n }),
    simulate: async () => {
      seen.simulated++;
      return simulation;
    },
    recentFees: async (accounts: readonly Address[]) => {
      seen.feeAccounts.push([...accounts]);
      return fees;
    },
    send: async (instructions: readonly Instruction[]) => {
      seen.sent.push([...instructions]);
      return "sig";
    },
    budget: async (instructions: readonly Instruction[]) => [...instructions],
  } as unknown as Transport;
  return { transport, seen };
}

describe("compute budget", () => {
  it("pads the simulated units by a tenth plus a floor and never exceeds the maximum", () => {
    expect([UNIT_HEADROOM_DIVISOR, UNIT_HEADROOM_FLOOR]).toEqual([10n, 1_000n]);
    expect(headroom(0n)).toBe(1_000);
    expect(headroom(20_000n)).toBe(23_000);
    expect(headroom(20_009n)).toBe(23_009);
    expect(headroom(1_271_818n)).toBe(1_399_999);
    expect(headroom(1_271_819n)).toBe(MAX_COMPUTE_UNITS);
    expect(headroom(5_000_000n)).toBe(MAX_COMPUTE_UNITS);
  });

  it("takes the requested percentile of recent fees, rounding down, and zero when there are none", () => {
    expect(AUTO_PERCENTILE).toBe(75n);
    expect(percentile([], 75n)).toBe(0n);
    expect(percentile([9n], 75n)).toBe(9n);
    expect(percentile([40n, 10n, 30n, 20n, 50n], 75n)).toBe(40n);
    expect(percentile([40n, 10n, 30n, 20n], 75n)).toBe(30n);
    expect(percentile([3n, 1n, 2n], 0n)).toBe(1n);
    expect(percentile([3n, 1n, 2n], 100n)).toBe(3n);
  });

  it("asks for fees only on accounts the transaction writes, each once", () => {
    expect(
      writableAccounts([
        ix([
          { address: A, role: AccountRole.WRITABLE },
          { address: B, role: AccountRole.READONLY },
          { address: C, role: AccountRole.WRITABLE_SIGNER },
        ]),
        ix([
          { address: A, role: AccountRole.WRITABLE },
          { address: B, role: AccountRole.READONLY_SIGNER },
        ]),
        { programAddress: PROGRAM },
      ]),
    ).toEqual([A, C]);
  });

  it("uses a fixed price as given and an automatic one from recent fees up to a cap", async () => {
    const write = [ix([{ address: A, role: AccountRole.WRITABLE }])];
    const quiet = fake({ err: null, logs: [], unitsConsumed: 1n, accounts: [] }, [5n, 7n, 100n, 1n]);
    expect(await priceOf(quiet.transport, 42n, write)).toBe(42n);
    expect(quiet.seen.feeAccounts).toEqual([]);
    expect(await priceOf(quiet.transport, "auto", write)).toBe(7n);
    expect(quiet.seen.feeAccounts).toEqual([[A]]);
    expect(AUTO_PRICE_CAP).toBe(10_000_000n);
    const busy = fake({ err: null, logs: [], unitsConsumed: 1n, accounts: [] }, [AUTO_PRICE_CAP + 1n]);
    expect(await priceOf(busy.transport, "auto", write)).toBe(AUTO_PRICE_CAP);
    const edge = fake({ err: null, logs: [], unitsConsumed: 1n, accounts: [] }, [AUTO_PRICE_CAP - 1n]);
    expect(await priceOf(edge.transport, "auto", write)).toBe(AUTO_PRICE_CAP - 1n);
  });

  it("sets the limit from a simulation, adds a price only when there is one, and keeps the caller's own budget", async () => {
    const payer = await generateKeyPairSigner();
    const body = [ix([{ address: A, role: AccountRole.WRITABLE }])];
    const ran = fake({ err: null, logs: [], unitsConsumed: 20_000n, accounts: [] });
    expect(await budgeted(ran.transport, 0n, body, payer.address)).toEqual([computeUnitLimit(23_000), ...body]);
    expect(await budgeted(ran.transport, 3n, body, payer.address)).toEqual([computeUnitLimit(23_000), computeUnitPrice(3n), ...body]);
    expect(ran.seen.simulated).toBe(2);
    const failed = fake({ err: "boom", logs: [], unitsConsumed: 20_000n, accounts: [] });
    expect(await budgeted(failed.transport, 0n, body, payer.address)).toEqual([computeUnitLimit(MAX_COMPUTE_UNITS), ...body]);
    const unknown = fake({ err: null, logs: [], unitsConsumed: null, accounts: [] });
    expect(await budgeted(unknown.transport, 0n, body, payer.address)).toEqual([computeUnitLimit(MAX_COMPUTE_UNITS), ...body]);
    const own = [{ programAddress: COMPUTE_BUDGET_ADDRESS, data: new Uint8Array([2, 1, 0, 0, 0]) }, ...body];
    const kept = fake({ err: null, logs: [], unitsConsumed: 1n, accounts: [] });
    expect(await budgeted(kept.transport, 9n, own, payer.address)).toEqual(own);
    expect(kept.seen.simulated).toBe(0);
  });

  it("prices a transaction's priority fee from its limit and price, rounding up", () => {
    const body = ix([]);
    expect(priorityLamports([body])).toBe(0n);
    expect(priorityLamports([computeUnitLimit(1), body])).toBe(0n);
    expect(priorityLamports([computeUnitLimit(23_000), computeUnitPrice(4n), body])).toBe(1n);
    expect(priorityLamports([computeUnitLimit(1_000_000), computeUnitPrice(3n), body])).toBe(3n);
    expect(priorityLamports([computeUnitLimit(1_000_001), computeUnitPrice(3n), body])).toBe(4n);
    expect(priorityLamports([computeUnitPrice(5n), body, body])).toBe(2n);
    expect(priorityLamports([computeUnitPrice(1_000_000n), ...Array.from({ length: 8 }, () => body)])).toBe(1_400_000n);
    const odd = { programAddress: COMPUTE_BUDGET_ADDRESS, data: new Uint8Array([3, 1]) };
    expect(priorityLamports([odd, body])).toBe(0n);
    const long = { programAddress: COMPUTE_BUDGET_ADDRESS, data: new Uint8Array([2, 1, 0, 0, 0, 0, 0, 0, 0]) };
    expect(priorityLamports([long, computeUnitPrice(1_000_000n), body])).toBe(200_000n);
    expect(priorityLamports([computeUnitPrice(1_000_000n), long, body])).toBe(200_000n);
    const priceless = { programAddress: COMPUTE_BUDGET_ADDRESS, data: new Uint8Array([3, 1, 0, 0, 0]) };
    expect(priorityLamports([computeUnitPrice(1_000_000n), priceless, body])).toBe(200_000n);
    const short = { programAddress: COMPUTE_BUDGET_ADDRESS, data: new Uint8Array([2, 1, 0, 0]) };
    expect(priorityLamports([short, computeUnitPrice(1_000_000n), body])).toBe(200_000n);
    const tagged = { programAddress: COMPUTE_BUDGET_ADDRESS, data: new Uint8Array([4, 1, 0, 0, 0]) };
    expect(priorityLamports([tagged, computeUnitPrice(1_000_000n), body])).toBe(200_000n);
    const bare = { programAddress: COMPUTE_BUDGET_ADDRESS };
    expect(priorityLamports([bare, computeUnitPrice(1_000_000n)])).toBe(200_000n);
  });

  it("budgets every send and every prepared transaction through the wrapped transport", async () => {
    const payer = await generateKeyPairSigner();
    const body = [ix([{ address: A, role: AccountRole.WRITABLE }])];
    const ran = fake({ err: null, logs: [], unitsConsumed: 20_000n, accounts: [] });
    const wrapped = withPriority(ran.transport, 4n);
    expect(await wrapped.budget(body, payer.address)).toEqual([computeUnitLimit(23_000), computeUnitPrice(4n), ...body]);
    expect(await wrapped.send(body, payer)).toBe("sig");
    expect(ran.seen.sent).toEqual([[computeUnitLimit(23_000), computeUnitPrice(4n), ...body]]);
  });
});
