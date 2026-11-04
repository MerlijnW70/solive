import { type Address, getAddressDecoder } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import type { Reputation } from "@intent-engine/client";
import { DEVNET_TEST_MINT, NATIVE_MINT } from "@intent-engine/core";
import { invoke } from "../src/agent/actions.js";
import { claimsOf } from "../src/agent/claims.js";
import { getReputation } from "../src/agent/reputation.js";
import { transport, world } from "./harness.js";

const mintAt = (i: number): Address => getAddressDecoder().decode(Uint8Array.from({ length: 32 }, (_, at) => (at === 0 ? i + 1 : 0x5e)));

const MINTS = 33;
const earned = Array.from({ length: MINTS }, (_, i) => ({ mint: mintAt(i), amount: BigInt(1_000 + i) }));

const stub = vi.hoisted(() => ({ reputation: undefined as unknown }));

vi.mock("@intent-engine/client/internal", async (original) => ({
  ...(await original<typeof import("@intent-engine/client/internal")>()),
  reputationOf: async () => stub.reputation,
}));

const reputationWith = (worker: Address, perMint: typeof earned): Reputation => ({
  wallet: worker,
  complete: true,
  announced: MINTS,
  paid: MINTS,
  refuted: 0,
  selfDealt: 0,
  fundedByWorker: 0,
  fundingUnknown: 0,
  paidVerified: MINTS,
  payers: MINTS,
  judges: 1,
  committeeJudged: 0,
  earned: perMint,
  held: perMint,
  backed: perMint,
  backedSol: "0",
  feedback: { count: 0, average: null },
  first: null,
  last: null,
  records: [],
  unreadable: [],
});

describe("a worker paid in many mints", () => {
  it("reads 33 earned mints as the 32 largest and a count of the rest instead of failing", async () => {
    const w = await world();
    stub.reputation = reputationWith(w.owner.address, earned);
    const read = await invoke(getReputation, { transport, relay: undefined, agent: undefined, claims: claimsOf() }, { worker: w.owner.address });
    expect(read.ok, JSON.stringify(read)).toBe(true);
    const value = (read as { value: Record<string, unknown> }).value;
    const largest = [...earned].reverse().slice(0, 32).map(({ mint, amount }) => ({ mint, amount: amount.toString() }));
    for (const field of ["earned", "held", "backed"]) {
      expect([field, value[field], value[`${field}_more`]]).toEqual([field, largest, 1]);
    }
    stub.reputation = reputationWith(w.owner.address, earned.slice(0, 32));
    const fits = await invoke(getReputation, { transport, relay: undefined, agent: undefined, claims: claimsOf() }, { worker: w.owner.address });
    expect(fits.ok).toBe(true);
    const shown = (fits as { value: Record<string, unknown> }).value;
    expect([shown["earned"], "earned_more" in shown]).toEqual([earned.slice(0, 32).reverse().map(({ mint, amount }) => ({ mint, amount: amount.toString() })), false]);
  });

  it("keeps SOL and TEST earnings ahead of junk mints with larger raw amounts", async () => {
    const w = await world();
    const junk = earned.map(({ mint }, i) => ({ mint, amount: 10n ** 18n + BigInt(i) }));
    const real = [
      { mint: DEVNET_TEST_MINT, amount: 2n },
      { mint: NATIVE_MINT, amount: 1n },
    ];
    stub.reputation = reputationWith(w.owner.address, [...junk, ...real]);
    const read = await invoke(getReputation, { transport, relay: undefined, agent: undefined, claims: claimsOf() }, { worker: w.owner.address });
    expect(read.ok, JSON.stringify(read)).toBe(true);
    const value = (read as { value: Record<string, unknown> }).value;
    const shown = value["earned"] as { mint: Address; amount: string }[];
    expect(shown.slice(0, 2).map(({ mint }) => mint).sort()).toEqual([DEVNET_TEST_MINT, NATIVE_MINT].sort());
    expect(shown.slice(2).map(({ mint }) => mint)).toEqual([...junk].reverse().slice(0, 30).map(({ mint }) => mint));
    expect(value["earned_more"]).toBe(3);
  });
});
