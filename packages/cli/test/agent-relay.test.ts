import { type Address, generateKeyPairSigner, type Signature } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { FailedOnChain, MaybeSent } from "@intent-engine/client";
import { failure } from "@intent-engine/client/internal";
import { BUDGET_WINDOW, budgetOf, release, reserve } from "../src/agent/budget.js";
import { AgentRefusal } from "../src/agent/problems.js";
import { admitRelay, RATE_WINDOW, relayOf } from "../src/agent/relay.js";
import { paying, refuseRepricing, repriced } from "../src/agent/signed.js";

const A = "11111111111111111111111111111112" as Address;
const B = "SysvarC1ock11111111111111111111111111111111" as Address;

function refused(run: () => unknown) {
  try {
    run();
  } catch (error) {
    if (error instanceof AgentRefusal) {
      return error.problem;
    }
    throw error;
  }
  throw new Error("expected a refusal");
}

const policy = { maxLamports: 100n, maxTtl: 60n, perHour: 2, hourlyLamports: 1_000n, fees: new Map() };

describe("spending budgets", () => {
  it("reserve spend within a sliding hour and release what was never spent", () => {
    expect(BUDGET_WINDOW).toBe(3_600n);
    const b = budgetOf(100n);
    const first = reserve(b, 60n, 1_000n);
    expect(refused(() => reserve(b, 41n, 1_000n))).toEqual({
      code: "BudgetExhausted",
      retryable: true,
      hint: "this key may spend 100 lamports per hour and has 40 left; this needs 41",
    });
    reserve(b, 40n, 1_000n);
    release(b, first);
    reserve(b, 60n, 1_001n);
    expect(refused(() => reserve(b, 41n, 4_600n)).code).toBe("BudgetExhausted");
    reserve(b, 100n, 4_601n);
    expect(b.spends).toHaveLength(1);
  });
});

describe("relay limits", () => {
  it("bound what one relay may cost the relayer and how long its intent may live", async () => {
    const relay = relayOf(await generateKeyPairSigner(), policy);
    expect([relay.recent.size, relay.budget.hourly]).toEqual([0, 1_000n]);
    admitRelay(relay, A, 100n, 100n, 1_060n, 1_000n);
    expect(refused(() => admitRelay(relay, A, 101n, 101n, 1_000n, 1_000n))).toEqual({
      code: "RelayTooCostly",
      retryable: false,
      hint: "relaying this intent costs 101 lamports in create fee, crank bounty and priority fee; this relayer pays at most 100",
    });
    expect(refused(() => admitRelay(relay, A, 0n, 0n, 1_061n, 1_000n))).toEqual({
      code: "RelayTooLong",
      retryable: false,
      hint: "this relayer only relays intents that expire within 60 seconds; sign one with an earlier expiry",
    });
  });

  it("limit relays per owner and in total, reserving before anything is sent", async () => {
    expect(RATE_WINDOW).toBe(3_600n);
    const relay = relayOf(await generateKeyPairSigner(), policy);
    admitRelay(relay, A, 0n, 300n, 1_000n, 1_000n);
    const second = admitRelay(relay, A, 0n, 300n, 1_000n, 1_000n);
    expect(refused(() => admitRelay(relay, A, 0n, 1n, 1_000n, 1_000n))).toEqual({
      code: "RelayRateLimited",
      retryable: true,
      hint: "this relayer relays at most 2 intents per owner per hour",
    });
    expect(refused(() => admitRelay(relay, B, 0n, 401n, 1_000n, 1_000n)).code).toBe("BudgetExhausted");
    second.cancel();
    expect(relay.recent.get(A)).toEqual([1_000n]);
    admitRelay(relay, B, 0n, 700n, 1_000n, 1_000n);
    expect(relay.budget.spends.map((s) => s.lamports)).toEqual([300n, 700n]);
    expect(refused(() => admitRelay(relay, A, 0n, 1n, 4_599n, 4_599n)).code).toBe("BudgetExhausted");
    admitRelay(relay, A, 0n, 1n, 4_600n, 4_600n);
    expect([...relay.recent]).toEqual([[A, [4_600n]]]);
    admitRelay(relay, B, 0n, 1n, 8_300n, 8_300n);
    expect([...relay.recent]).toEqual([[B, [8_300n]]]);
  });
});

describe("relay tickets", () => {
  it("release only their own admission, even after the window has already dropped it", async () => {
    const relay = relayOf(await generateKeyPairSigner(), policy);
    const early = admitRelay(relay, A, 1n, 10n, 30n, 0n);
    const late = RATE_WINDOW + 1n;
    admitRelay(relay, A, 1n, 10n, late + 30n, late);
    expect(relay.recent.get(A)).toEqual([late]);
    early.cancel();
    expect(relay.recent.get(A)).toEqual([late]);
    expect(relay.budget.spends.map((s) => s.at)).toEqual([late]);
    const kept = admitRelay(relay, B, 1n, 10n, late + 30n, late);
    kept.cancel();
    expect(relay.recent.get(B)).toEqual([]);
    expect(relay.budget.spends.map((s) => s.at)).toEqual([late]);
  });
});


describe("relayer payment accounting", () => {
  it("refuses a relay whose priority fee rose past what was admitted, and not one that stayed equal", () => {
    expect(() => refuseRepricing(100n, 100n)).not.toThrow();
    expect(() => refuseRepricing(100n, 99n)).not.toThrow();
    expect(() => refuseRepricing(100n, 101n)).toThrow(new AgentRefusal("RelayTooCostly", repriced(100n, 101n)));
  });

  it("counts a send as paid when it lands or may have been charged, not when it was never delivered", async () => {
    const sent = { any: false };
    await expect(paying(sent, Promise.resolve("sig"))).resolves.toBe("sig");
    expect(sent.any).toBe(true);
    const charged = { any: false };
    await expect(paying(charged, Promise.reject(new FailedOnChain("landed and failed", failure("1".repeat(64) as Signature, null))))).rejects.toThrow("landed and failed");
    expect(charged.any).toBe(true);
    const unsure = { any: false };
    await expect(paying(unsure, Promise.reject(new MaybeSent("1".repeat(64) as Signature, 9n, "may have landed")))).rejects.toThrow("may have landed");
    expect(unsure.any).toBe(true);
    const dropped = { any: false };
    await expect(paying(dropped, Promise.reject(new Error("rejected")))).rejects.toThrow("rejected");
    expect(dropped.any).toBe(false);
  });
});
