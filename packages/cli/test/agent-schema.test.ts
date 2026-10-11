import { describe, expect, it } from "vitest";
import {
  account,
  ADDRESS_PATTERN,
  amount,
  AMOUNT_PATTERN,
  checked,
  choice,
  flag,
  integer,
  InvalidInput,
  list,
  nullable,
  object,
  optional,
  passThrough,
  type Schema,
  text,
  time,
  TIME_PATTERN,
  variants,
  VENDOR,
} from "../src/agent/schema.js";

const KEY = "11111111111111111111111111111112";

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

describe("agent schemas", () => {
  it("read scalars and describe them as JSON Schema", () => {
    expect(text("t").json).toEqual({ type: "string", description: "t" });
    expect(text().json).toEqual({ type: "string" });
    expect(text().read("x", "")).toBe("x");
    expect(issues(() => text().read(1, "a"))).toEqual([{ path: "a", message: "must be a string" }]);
    expect(flag().json).toEqual({ type: "boolean" });
    expect(flag().read(false, "")).toBe(false);
    expect(issues(() => flag().read("true", "f"))).toEqual([{ path: "f", message: "must be true or false" }]);
    expect(account().json).toEqual({ type: "string", pattern: ADDRESS_PATTERN });
    expect(account().read(KEY, "")).toBe(KEY);
    for (const bad of ["0OIl", 5, `${KEY}11`, "1".repeat(45)]) {
      expect(issues(() => account().read(bad, "k"))).toEqual([{ path: "k", message: "must be a base58 Solana address" }]);
    }
  });

  it("read u64 amounts only as canonical decimal strings", () => {
    expect(amount().json).toEqual({ type: "string", pattern: AMOUNT_PATTERN });
    expect(amount().read("0", "")).toBe(0n);
    expect(amount().read("18446744073709551615", "")).toBe(18_446_744_073_709_551_615n);
    expect(issues(() => amount().read("18446744073709551616", "a"))).toEqual([
      { path: "a", message: "must be at most 18446744073709551615" },
    ]);
    for (const bad of [5, "05", "-1", "1.5", "", "123456789012345678901", " 1"]) {
      expect(issues(() => amount().read(bad, "a")), String(bad)).toEqual([
        { path: "a", message: "must be a whole number of raw token units written as a decimal string" },
      ]);
    }
  });

  it("read signed i64 times", () => {
    expect(time().json).toEqual({ type: "string", pattern: TIME_PATTERN });
    expect(time().read("-5", "")).toBe(-5n);
    expect(time().read("9223372036854775807", "")).toBe(9_223_372_036_854_775_807n);
    expect(time().read("-9223372036854775808", "")).toBe(-9_223_372_036_854_775_808n);
    expect(issues(() => time().read("9223372036854775808", "t"))).toEqual([
      { path: "t", message: "must be from -9223372036854775808 to 9223372036854775807" },
    ]);
    expect(issues(() => time().read("-9223372036854775809", "t"))).toHaveLength(1);
    for (const bad of [1, "01", "-0x1", "1e3"]) {
      expect(issues(() => time().read(bad, "t"))).toEqual([
        { path: "t", message: "must be whole unix seconds written as a decimal string" },
      ]);
    }
  });

  it("read bounded integers and choices", () => {
    const i = integer(2, 4, "n");
    expect(i.json).toEqual({ type: "integer", minimum: 2, maximum: 4, description: "n" });
    expect([i.read(2, ""), i.read(4, "")]).toEqual([2, 4]);
    for (const bad of [1, 5, 2.5, "3", Number.MAX_SAFE_INTEGER + 2]) {
      expect(issues(() => i.read(bad, "n"))).toEqual([{ path: "n", message: "must be an integer from 2 to 4" }]);
    }
    const c = choice(["a", "b"]);
    expect(c.json).toEqual({ type: "string", enum: ["a", "b"] });
    expect(c.read("b", "")).toBe("b");
    expect(issues(() => c.read("c", "c"))).toEqual([{ path: "c", message: "must be one of a, b" }]);
    expect(issues(() => c.read(1, "c"))).toHaveLength(1);
  });

  it("read lists and nullable values with item paths", () => {
    const l = list(amount(), 2, "l");
    expect(l.json).toEqual({ type: "array", items: amount().json, minItems: 0, maxItems: 2, description: "l" });
    expect(l.read(["1", "2"], "")).toEqual([1n, 2n]);
    expect(issues(() => l.read(["1", "x"], "l"))[0]?.path).toBe("l.1");
    expect(issues(() => l.read(["1", "x"], ""))[0]?.path).toBe("1");
    expect(issues(() => l.read("1", "l"))).toEqual([{ path: "l", message: "must be a list" }]);
    expect(issues(() => l.read(["1", "2", "3"], "l"))).toEqual([{ path: "l", message: "must hold 0 to 2 items" }]);
    const some = list(amount(), 2, undefined, 1);
    expect(some.json).toEqual({ type: "array", items: amount().json, minItems: 1, maxItems: 2 });
    expect(issues(() => some.read([], "s"))).toEqual([{ path: "s", message: "must hold 1 to 2 items" }]);
    expect(some.read(["1"], "")).toEqual([1n]);
    const n = nullable(flag());
    expect(n.json).toEqual({ anyOf: [{ type: "boolean" }, { type: "null" }] });
    expect([n.read(null, ""), n.read(true, "")]).toEqual([null, true]);
    expect(issues(() => n.read(1, "n"))).toHaveLength(1);
  });

  it("read objects strictly, reporting every problem at once", () => {
    const o = object({ a: amount(), b: optional(flag()) }, "o");
    expect(o.json).toEqual({
      type: "object",
      properties: { a: amount().json, b: { type: "boolean" } },
      required: ["a"],
      additionalProperties: false,
      description: "o",
    });
    expect(o.read({ a: "1" }, "")).toEqual({ a: 1n });
    expect(o.read({ a: "1", b: undefined }, "")).toEqual({ a: 1n });
    expect(o.read({ a: "1", b: true }, "")).toEqual({ a: 1n, b: true });
    expect(issues(() => o.read({ b: 1, c: 2 }, "x"))).toEqual([
      { path: "x.c", message: "is not a known field" },
      { path: "x.a", message: "is required" },
      { path: "x.b", message: "must be true or false" },
    ]);
    for (const bad of [null, [], "o", 1]) {
      expect(issues(() => o.read(bad, "x"))).toEqual([{ path: "x", message: "must be an object" }]);
    }
    const boom: Schema<number> = {
      json: {},
      read: () => {
        throw new TypeError("boom");
      },
    };
    expect(() => object({ z: boom }).read({ z: 1 }, "")).toThrow(TypeError);
  });

  it("read tagged variants and publish them as oneOf", () => {
    const v = variants("kind", { one: object({ a: amount() }), two: object({ b: optional(flag()) }) }, "v");
    expect(v.json).toEqual({
      description: "v",
      oneOf: [
        {
          type: "object",
          properties: { kind: { const: "one" }, a: amount().json },
          required: ["kind", "a"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: { kind: { const: "two" }, b: { type: "boolean" } },
          required: ["kind"],
          additionalProperties: false,
        },
      ],
    });
    expect(v.read({ kind: "one", a: "3" }, "")).toEqual({ kind: "one", a: 3n });
    expect(v.read({ kind: "two" }, "")).toEqual({ kind: "two" });
    expect(issues(() => v.read({ kind: "one", b: true }, "o"))).toEqual([
      { path: "o.b", message: "is not a known field" },
      { path: "o.a", message: "is required" },
    ]);
    expect(issues(() => v.read({ kind: "three" }, "o"))).toEqual([{ path: "o.kind", message: "must be one of one, two" }]);
    expect(issues(() => v.read({ kind: 1 }, ""))).toEqual([{ path: "kind", message: "must be one of one, two" }]);
    expect(issues(() => v.read(null, "o"))).toEqual([{ path: "o", message: "must be an object" }]);
    expect(variants("k", { x: object({}) }).json).toEqual({
      oneOf: [{ type: "object", properties: { k: { const: "x" } }, required: ["k"], additionalProperties: false }],
    });
  });

  it("explain invalid input in one message", () => {
    expect(new InvalidInput([{ path: "", message: "root" }, { path: "a.b", message: "bad" }]).message).toBe("root; a.b: bad");
    expect(new InvalidInput([]).name).toBe("InvalidInput");
  });

  it("adapt to the Standard Schema contract", () => {
    const s = object({ a: amount() });
    const loose = passThrough(s.json)["~standard"];
    expect([loose.version, loose.vendor, VENDOR]).toEqual([1, "intent-engine", "intent-engine"]);
    expect(loose.validate({ anything: 1 })).toEqual({ value: { anything: 1 } });
    expect(loose.jsonSchema.input({})).toBe(s.json);
    expect(loose.jsonSchema.output({})).toBe(s.json);
    const strict = checked(s)["~standard"];
    expect([strict.version, strict.vendor]).toEqual([1, "intent-engine"]);
    expect(strict.validate({ a: "2" })).toEqual({ value: { a: 2n } });
    expect(strict.validate({ a: "x" })).toEqual({
      issues: [{ message: "must be a whole number of raw token units written as a decimal string", path: ["a"] }],
    });
    expect(checked(amount())["~standard"].validate(1)).toEqual({
      issues: [{ message: "must be a whole number of raw token units written as a decimal string" }],
    });
    expect(strict.jsonSchema.input({})).toBe(s.json);
    expect(strict.jsonSchema.output({})).toBe(s.json);
    const boom: Schema<number> = {
      json: {},
      read: () => {
        throw new TypeError("boom");
      },
    };
    expect(() => checked(boom)["~standard"].validate(1)).toThrow(TypeError);
  });
});
