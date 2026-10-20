import { describe, expect, it } from "vitest";
import { least, most } from "../src/amounts.js";

const U64_MAX = 2n ** 64n - 1n;

describe("amount bounds", () => {
  it("takes the smaller of two amounts in either order", () => {
    expect([least(5n, 3n), least(3n, 5n), least(4n, 4n), least(0n, 9n), least(9n, 0n)]).toEqual([3n, 3n, 4n, 0n, 0n]);
    expect([least(U64_MAX, U64_MAX - 1n), least(U64_MAX - 1n, U64_MAX)]).toEqual([U64_MAX - 1n, U64_MAX - 1n]);
    expect([least(-2n, 0n), least(0n, -2n)]).toEqual([-2n, -2n]);
  });

  it("takes the larger of two amounts in either order", () => {
    expect([most(5n, 3n), most(3n, 5n), most(4n, 4n), most(0n, 9n), most(9n, 0n)]).toEqual([5n, 5n, 4n, 9n, 9n]);
    expect([most(U64_MAX, U64_MAX - 1n), most(U64_MAX - 1n, U64_MAX)]).toEqual([U64_MAX, U64_MAX]);
    expect([most(-2n, 0n), most(0n, -2n)]).toEqual([0n, 0n]);
  });
});
