import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { callOf, claim, claimedBy, claimsOf, MAX_PENDING_PER_OWNER } from "../src/agent/claims.js";
import { AgentRefusal } from "../src/agent/problems.js";

const OWNER = "11111111111111111111111111111112" as Address;
const OTHER = "SysvarC1ock11111111111111111111111111111111" as Address;
const NOW = 1_000n;

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof AgentRefusal ? error.problem.code : String(error);
  }
  return "ok";
}

describe("nonce claims", () => {
  it("hold at most a fixed number of pending requests per owner, so nobody can tie up an owner's window", () => {
    expect(MAX_PENDING_PER_OWNER).toBe(16);
    const claims = claimsOf();
    const call = callOf();
    for (let n = 0n; n < BigInt(MAX_PENDING_PER_OWNER); n++) {
      claim(claims, call, OWNER, n, NOW + 86_400n, NOW);
    }
    expect(claimedBy(claims, OWNER, NOW).size).toBe(MAX_PENDING_PER_OWNER);
    expect(codeOf(() => claim(claims, call, OWNER, 99n, NOW + 60n, NOW))).toBe("TooManyPending");
    expect(codeOf(() => claim(claims, call, OWNER, 3n, NOW + 60n, NOW))).toBe("NoncePromised");
    expect(codeOf(() => claim(claims, call, OTHER, 99n, NOW + 60n, NOW))).toBe("ok");
    const undone = callOf();
    const fresh = claimsOf();
    for (let n = 0n; n < BigInt(MAX_PENDING_PER_OWNER) - 1n; n++) {
      claim(fresh, undone, OWNER, n, NOW + 60n, NOW);
    }
    const last = callOf();
    claim(fresh, last, OWNER, 50n, NOW + 60n, NOW);
    expect(codeOf(() => claim(fresh, callOf(), OWNER, 51n, NOW + 60n, NOW))).toBe("TooManyPending");
    for (const undo of last.undo) {
      undo();
    }
    expect(codeOf(() => claim(fresh, callOf(), OWNER, 51n, NOW + 60n, NOW))).toBe("ok");
  });

  it("free a slot as soon as a claim expires, and keep one until its last second", () => {
    const claims = claimsOf();
    const call = callOf();
    for (let n = 0n; n < BigInt(MAX_PENDING_PER_OWNER); n++) {
      claim(claims, call, OWNER, n, n === 0n ? NOW + 10n : NOW + 600n, NOW);
    }
    expect(codeOf(() => claim(claims, call, OWNER, 99n, NOW + 60n, NOW + 10n))).toBe("TooManyPending");
    expect(claimedBy(claims, OWNER, NOW + 10n).has(0n)).toBe(true);
    expect(codeOf(() => claim(claims, call, OWNER, 99n, NOW + 60n, NOW + 11n))).toBe("ok");
    expect(claimedBy(claims, OWNER, NOW + 11n).has(0n)).toBe(false);
  });

  it("stale claims are pruned for every owner", () => {
    const claims = claimsOf();
    const call = callOf();
    claim(claims, call, OWNER, 1n, NOW + 10n, NOW);
    claim(claims, call, OWNER, 2n, NOW + 600n, NOW);
    claim(claims, call, OTHER, 1n, NOW + 10n, NOW);
    expect([...claims.held.keys()]).toEqual([OWNER, OTHER]);
    claimedBy(claims, OWNER, NOW + 11n);
    expect([...claims.held.keys()]).toEqual([OWNER]);
    expect([...(claims.held.get(OWNER)?.keys() ?? [])]).toEqual([2n]);
    claim(claims, call, OTHER, 3n, NOW + 700n, NOW + 601n);
    expect([...claims.held.keys()]).toEqual([OTHER]);
    expect([...(claims.held.get(OTHER)?.keys() ?? [])]).toEqual([3n]);
  });
});
