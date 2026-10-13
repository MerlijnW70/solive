import { describe, expect, it } from "vitest";
import { IntentCoreError, splitN } from "../src/index.js";

describe("splitN", () => {
  it("conserve the whole amount and route the remainder to the heaviest weight", () => {
    expect(splitN(10n, [5000, 5000])).toEqual([5n, 5n]);
    expect(splitN(1n, [5000, 5000])).toEqual([1n, 0n]);
    expect(splitN(1n, [4000, 6000])).toEqual([0n, 1n]);
    expect(splitN(7n, [3333, 3333, 3334])).toEqual([2n, 2n, 3n]);
  });

  it("break ties for the remainder towards the lowest index", () => {
    expect(splitN(1n, [5000, 5000])).toEqual([1n, 0n]);
  });

  it("reject an empty split, too many recipients, or weights that are not 10000", () => {
    expect(() => splitN(1n, [])).toThrow(new IntentCoreError("InvalidParams"));
    expect(() => splitN(1n, new Array(17).fill(588))).toThrow(new IntentCoreError("InvalidParams"));
    expect(() => splitN(1n, [5000, 4999])).toThrow(new IntentCoreError("InvalidParams"));
    expect(() => splitN(1n, [10001])).toThrow(new IntentCoreError("InvalidParams"));
  });

  it("reject a negative or non-integer weight even when the rest would sum to 10000", () => {
    expect(() => splitN(1n, [-1, 10001])).toThrow(new IntentCoreError("InvalidParams"));
    expect(() => splitN(1n, [5000.5, 4999.5])).toThrow(new IntentCoreError("InvalidParams"));
  });

  it("reject an amount outside the u64 range the program settles", () => {
    expect(() => splitN(-1n, [10000])).toThrow(new IntentCoreError("Overflow"));
    expect(() => splitN((1n << 64n), [10000])).toThrow(new IntentCoreError("Overflow"));
  });
});
