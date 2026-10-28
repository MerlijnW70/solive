import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ENGINE_ERROR_LIST } from "../src/internal.js";

type IdlError = { code: number; name: string; msg?: string };

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const idl = JSON.parse(read("../generated/idl.json")) as { errors: IdlError[] };
const CODEGEN = read("../scripts/codegen.mjs");
const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const CI = readFileSync(join(ROOT, "scripts/ci.sh"), "utf8");

describe("the generated engine error table", () => {
  it("names every engine error of the IDL with its code, in order, and its message or its name in words", () => {
    expect(ENGINE_ERROR_LIST.map(({ code, name }) => [code, name])).toEqual(idl.errors.map(({ code, name }) => [code, name]));
    for (const [i, { msg, name }] of idl.errors.entries()) {
      expect(ENGINE_ERROR_LIST[i]?.message).toBe(msg ?? name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase());
    }
    expect(ENGINE_ERROR_LIST.find(({ name }) => name === "DivideByZero")?.message).toBe("divide by zero");
  });

  it("is written by the codegen into generated, which the ci drift check covers", () => {
    expect(CODEGEN).toContain('new URL("../generated/engine-errors.ts", import.meta.url)');
    expect(CI).toMatch(/^git diff --exit-code -- .*\bpackages\/core\/generated\b/m);
  });

  it("is plain data that imports nothing", () => {
    expect(read("../generated/engine-errors.ts")).not.toMatch(/^import /m);
  });
});
