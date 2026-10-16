import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  type BoardView,
  buildSettleClaims,
  checkClaimant,
  checkClaimTerms,
  claimSlot,
  claimUntil,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  IntentCoreError,
  MAX_CLAIM_SECS,
  MAX_CLAIM_STAKE,
  stakeReceiverOnCancel,
  stakeReceiverOnRelease,
  stakeReceiverOnSettle,
} from "../src/index.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const NONE = "11111111111111111111111111111111" as Address;
const OWNER = "SysvarRent111111111111111111111111111111111" as Address;
const WORKER = "SysvarC1ock11111111111111111111111111111111" as Address;
const OTHER = "SysvarRecentB1ockHashes11111111111111111111" as Address;

const board = (worker: Address, until: bigint, droppedBy?: Address): BoardView => ({
  owner: OWNER,
  worker,
  until,
  held: 5n,
  ...(droppedBy === undefined ? {} : { droppedBy }),
});

function code(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (e) {
    if (e instanceof IntentCoreError) return e.code;
    throw e;
  }
}

describe("claim slot", () => {
  it("is free without a worker, held strictly before until, and lapsed from until on", () => {
    expect(claimSlot(board(NONE, 100n), 0n)).toEqual({ state: "free" });
    expect(claimSlot(board(NONE, 100n), 200n)).toEqual({ state: "free" });
    expect(claimSlot(board(WORKER, 100n), 99n)).toEqual({ state: "held", worker: WORKER, until: 100n });
    expect(claimSlot(board(WORKER, 100n), 100n)).toEqual({ state: "lapsed", worker: WORKER });
    expect(claimSlot(board(WORKER, 100n), 101n)).toEqual({ state: "lapsed", worker: WORKER });
  });
});

describe("claimant check", () => {
  it("refuses a held slot to anyone, and a dropped worker only until the cooldown ends", () => {
    expect(code(() => checkClaimant(board(WORKER, 100n), OTHER, 99n))).toBe("ClaimHeld");
    expect(code(() => checkClaimant(board(WORKER, 100n), WORKER, 99n))).toBe("ClaimHeld");
    expect(code(() => checkClaimant(board(WORKER, 100n), OTHER, 100n))).toBeNull();
    expect(code(() => checkClaimant(board(NONE, 100n, WORKER), WORKER, 99n))).toBe("ClaimCooldown");
    expect(code(() => checkClaimant(board(NONE, 100n, WORKER), WORKER, 100n))).toBeNull();
    expect(code(() => checkClaimant(board(NONE, 100n, WORKER), OTHER, 99n))).toBeNull();
    expect(code(() => checkClaimant(board(NONE, 100n, NONE), NONE, 99n))).toBeNull();
    expect(code(() => checkClaimant(board(NONE, 100n), WORKER, 99n))).toBeNull();
  });
});

describe("claim terms", () => {
  it("accept whole seconds from one up to the maximum and a stake up to its cap", () => {
    for (const secs of [1, 2, MAX_CLAIM_SECS - 1, MAX_CLAIM_SECS]) {
      expect(code(() => checkClaimTerms(secs, 0n))).toBeNull();
    }
    for (const stake of [0n, 1n, MAX_CLAIM_STAKE]) {
      expect(code(() => checkClaimTerms(60, stake))).toBeNull();
    }
  });

  it("refuse zero, fractional or too long claims and a stake below zero or above its cap", () => {
    for (const secs of [0, -1, 1.5, Number.NaN, MAX_CLAIM_SECS + 1]) {
      expect(code(() => checkClaimTerms(secs, 0n))).toBe("ClaimTerms");
    }
    for (const stake of [-1n, MAX_CLAIM_STAKE + 1n]) {
      expect(code(() => checkClaimTerms(60, stake))).toBe("ClaimTerms");
    }
  });
});

describe("claim until", () => {
  it("adds the claimed seconds to now when they fit the terms and the intent's lifetime", () => {
    expect(claimUntil(60, 1_000n, 1, 2_000n)).toBe(1_001n);
    expect(claimUntil(60, 1_000n, 60, 2_000n)).toBe(1_060n);
    expect(claimUntil(60, 1_000n, 60, 1_060n)).toBe(1_060n);
  });

  it("refuses seconds outside the terms and a claim that outlives the intent", () => {
    for (const secs of [0, -1, 1.5, 61]) {
      expect(code(() => claimUntil(60, 1_000n, secs, 2_000n))).toBe("ClaimTerms");
    }
    expect(code(() => claimUntil(60, 1_000n, 60, 1_059n))).toBe("ClaimTerms");
  });
});

describe("stake receiver", () => {
  const held = board(WORKER, 100n);
  const at = 50n;
  const lapsedAt = 100n;

  it("on release pays the worker it pays, refuses to pay past a held claim, and gives a lapsed stake to the owner", () => {
    expect(stakeReceiverOnRelease(board(NONE, 100n), at, [WORKER])).toBeNull();
    expect(stakeReceiverOnRelease(held, at, [WORKER])).toBe(WORKER);
    expect(stakeReceiverOnRelease(held, at, [OTHER, WORKER])).toBe(WORKER);
    expect(code(() => stakeReceiverOnRelease(held, at, [OTHER]))).toBe("ClaimHeld");
    expect(stakeReceiverOnRelease(held, lapsedAt, [WORKER])).toBe(WORKER);
    expect(stakeReceiverOnRelease(held, lapsedAt, [OTHER])).toBe(OWNER);
  });

  it("on cancel refunds a held stake to its worker and gives a lapsed one to the owner", () => {
    expect(stakeReceiverOnCancel(board(NONE, 100n), at)).toBeNull();
    expect(stakeReceiverOnCancel(held, at)).toBe(WORKER);
    expect(stakeReceiverOnCancel(held, lapsedAt)).toBe(OWNER);
  });

  it("on settle refuses a held claim while the escrow is open and otherwise mirrors cancel", () => {
    expect(stakeReceiverOnSettle(board(NONE, 100n), at, true)).toBeNull();
    expect(stakeReceiverOnSettle(board(NONE, 100n), at, false)).toBeNull();
    expect(code(() => stakeReceiverOnSettle(held, at, true))).toBe("ClaimHeld");
    expect(stakeReceiverOnSettle(held, at, false)).toBe(WORKER);
    expect(stakeReceiverOnSettle(held, lapsedAt, true)).toBe(OWNER);
    expect(stakeReceiverOnSettle(held, lapsedAt, false)).toBe(OWNER);
  });
});

describe("claim limits", () => {
  it("are the program's: a week of seconds and a hundred SOL of stake", () => {
    const rust = readFileSync(join(ROOT, "crates/intent-core/src/claim.rs"), "utf8");
    expect(rust).toContain("pub const MAX_CLAIM_SECS: u32 = 7 * 24 * 60 * 60;");
    expect(rust).toContain("pub const MAX_CLAIM_STAKE: u64 = 100_000_000_000;");
    expect(MAX_CLAIM_SECS).toBe(604_800);
    expect(MAX_CLAIM_STAKE).toBe(100_000_000_000n);
  });
});

describe("settle claims", () => {
  it("seats the worker only when given", async () => {
    const intent = "SysvarRecentB1ockHashes11111111111111111111" as Address;
    const given = await buildSettleClaims({ intent, owner: OWNER, worker: WORKER });
    const without = await buildSettleClaims({ intent, owner: OWNER });
    expect(given.accounts[3]?.address).toBe(WORKER);
    expect(without.accounts[3]?.address).toBe(INTENT_ENGINE_PROGRAM_ADDRESS);
    expect(given.accounts.length).toBe(without.accounts.length);
  });
});
