import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { boot, h, transport } from "./harness.js";

const OWN_LIFETIME = new Set(["svm", "saleRoot", "keypairs"]);

const dirty = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return [...value, "leftover"];
  }
  if (value instanceof Map) {
    return new Map([...value, ["leftover", 1]]);
  }
  switch (typeof value) {
    case "number":
      return value + 7;
    case "bigint":
      return value + 7n;
    case "boolean":
      return !value;
    case "string":
      return `${value}-leftover`;
    default:
      return value === null ? transport : { ...(value as object), leftover: "yes" };
  }
};

const snapshot = (): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(h)
      .filter(([key]) => !OWN_LIFETIME.has(key))
      .map(([key, value]) => [key, value instanceof Map ? [...value] : key === "env" ? { ...(value as object) } : value]),
  );

describe("the test harness", () => {
  it("harness boot resets every global", async () => {
    await boot();
    const pristine = snapshot();
    const { svm, saleRoot, env } = h;
    writeFileSync(join(saleRoot, "wallet.json.sales.json"), "[]");
    const held = h as Record<string, unknown>;
    const shared = new Set(["env", "files", "reads"]);
    const globals = Object.keys(h).filter((key) => !OWN_LIFETIME.has(key));
    expect(globals.length).toBeGreaterThan(30);
    for (const key of globals.filter((name) => !shared.has(name))) {
      held[key] = dirty(held[key]);
    }
    h.env["LEFTOVER"] = "yes";
    h.files.set("leftover.json", "[]");
    h.reads.set(transport as never, 3);
    const leftover = snapshot();
    for (const key of globals) {
      expect(leftover[key], key).not.toEqual(pristine[key]);
    }
    await boot();
    expect(snapshot()).toEqual(pristine);
    expect(h.env).toBe(env);
    expect(h.svm).not.toBe(svm);
    expect(h.saleRoot).not.toBe(saleRoot);
    expect(existsSync(saleRoot)).toBe(false);
    expect(existsSync(h.saleRoot)).toBe(true);
  });
});
