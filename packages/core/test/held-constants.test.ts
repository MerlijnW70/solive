import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { HELD_CLAIM_SECS, heldClaimableUntil, WITHHELD_ROLES, withheldRole } from "../src/internal.js";

const source = (rel: string): string => readFileSync(fileURLToPath(new URL(`../../../programs/intent_engine/src/${rel}`, import.meta.url)), "utf8");

describe("held share and withheld fee constants", () => {
  it("keeps a held share claimable for the year the program gives it after the escrow expires", () => {
    expect(source("state.rs")).toContain("pub const HELD_CLAIM_SECS: i64 = 365 * 86_400;");
    expect(HELD_CLAIM_SECS).toBe(365n * 86_400n);
    expect(heldClaimableUntil({ expiresAt: 100n })).toBe(100n + HELD_CLAIM_SECS);
  });

  it("names every withheld fee role the program emits, the protocol fee included", () => {
    const events = source("events.rs");
    for (const [role, name] of Object.entries(WITHHELD_ROLES)) {
      expect(events).toContain(`pub const WITHHELD_${name.toUpperCase()}: u8 = ${role};`);
      expect(withheldRole(Number(role))).toBe(name);
    }
    expect(withheldRole(5)).toBe("protocol");
    expect(withheldRole(0)).toBe("unknown");
    expect(withheldRole(6)).toBe("unknown");
  });
});
