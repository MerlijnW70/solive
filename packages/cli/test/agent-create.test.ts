import { describe, expect, it } from "vitest";
import { WARN_ATTESTOR, WARN_LONG_LIVED, WARN_LONG_SUBMIT, WARN_RECEIVER, WARN_RELAYER_FEE } from "@intent-engine/core/internal";
import { expiryOf, MAX_EXPIRES_IN, MIN_EXPIRES_IN, termsInput, termsOutput, WARN_SCALED } from "../src/agent/create.js";
import { WARN_REPLACES_DELEGATE } from "../src/agent/owner.js";
import { InvalidInput } from "../src/agent/schema.js";

const NOW = 1_700_000_000n;

function issues(run: () => unknown) {
  try {
    run();
  } catch (error) {
    if (error instanceof InvalidInput) {
      return error.issues;
    }
    throw error;
  }
  throw new Error("expected invalid input");
}

describe("intent expiry", () => {
  it("takes exactly one of an absolute expiry or a lifetime from now", () => {
    expect(expiryOf({ expires_at: NOW + 90n }, NOW)).toBe(NOW + 90n);
    expect(expiryOf({ expires_in: 90 }, NOW)).toBe(NOW + 90n);
    expect(expiryOf({ expires_in: MAX_EXPIRES_IN }, NOW)).toBe(NOW + BigInt(MAX_EXPIRES_IN));
    const both = [{ path: "expires_at", message: "give exactly one of expires_at or expires_in" }];
    expect(issues(() => expiryOf({ expires_at: NOW + 90n, expires_in: 90 }, NOW))).toEqual(both);
    expect(issues(() => expiryOf({}, NOW))).toEqual(both);
  });

  it("allows lifetimes from one minute to one year and nothing outside them", () => {
    expect([MIN_EXPIRES_IN, MAX_EXPIRES_IN]).toEqual([60, 31_536_000]);
    const lifetime = termsInput.expires_in.optional;
    for (const ok of [MIN_EXPIRES_IN, MIN_EXPIRES_IN + 1, MAX_EXPIRES_IN - 1, MAX_EXPIRES_IN]) {
      expect(lifetime.read(ok, "expires_in")).toBe(ok);
    }
    for (const bad of [MIN_EXPIRES_IN - 1, 0, -1, MAX_EXPIRES_IN + 1, 1.5]) {
      expect(issues(() => lifetime.read(bad, "expires_in")).map((i) => i.path)).toEqual(["expires_in"]);
    }
  });
});

describe("intent warnings", () => {
  it("leave room for every warning terms can raise at once, so none is lost to the output limit", () => {
    const every = [WARN_ATTESTOR, WARN_LONG_LIVED, WARN_SCALED, WARN_RECEIVER, WARN_LONG_SUBMIT, WARN_RELAYER_FEE, WARN_REPLACES_DELEGATE];
    expect(new Set(every).size).toBe(every.length);
    expect(termsOutput.warnings.json["maxItems"]).toBe(16);
    expect(termsOutput.warnings.read(every, "warnings")).toEqual(every);
  });
});

