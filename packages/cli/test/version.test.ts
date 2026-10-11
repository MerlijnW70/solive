import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse, UsageError } from "../src/args.js";
import { run } from "../src/commands.js";
import { VERSION } from "../src/version.js";
import { runtime } from "./harness.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const PACKAGES = ["packages/cli/package.json", "packages/core/package.json", "packages/solver/package.json"];
const CRATES = [
  "programs/intent_engine/Cargo.toml",
  "crates/intent-core/Cargo.toml",
  "tests/proofs/Cargo.toml",
  "tests/relay/Cargo.toml",
  "tests/svm/Cargo.toml",
];

describe("the version", () => {
  it("is the one every package and crate declares", () => {
    const declared = [
      ...PACKAGES.map((p) => [p, (JSON.parse(read(p)) as { version: string }).version]),
      ...CRATES.map((p) => [p, /^version = "([^"]+)"$/m.exec(read(p))?.[1]]),
    ];
    expect(declared).toEqual([...PACKAGES, ...CRATES].map((p) => [p, VERSION]));
  });

  it("covers every crate in the workspace", () => {
    const members = /members\s*=\s*\[([^\]]*)\]/.exec(read("Cargo.toml"))?.[1] ?? "";
    const globs = [...members.matchAll(/"([^"]+)\/\*"/g)].map((m) => m[1] ?? "");
    expect(globs.sort()).toEqual(["crates", "programs", "tests"]);
    const found = globs
      .flatMap((dir) => readdirSync(join(ROOT, dir)).map((name) => `${dir}/${name}/Cargo.toml`))
      .filter((manifest) => existsSync(join(ROOT, manifest)));
    expect(found.sort()).toEqual([...CRATES].sort());
  });

  it("prints with --version or version, and takes nothing but --output", async () => {
    expect(parse(["--version"])).toEqual({ name: "version" });
    expect(parse(["version"])).toEqual({ name: "version" });
    expect(() => parse(["version", "--url", "devnet"])).toThrow(UsageError);
    expect(() => parse(["show", "config", "--version"])).toThrow(UsageError);
    expect(() => parse(["version", "extra"])).toThrow("version takes no arguments but --output");
    expect(parse(["--version", "--output", "text"])).toEqual({ name: "version" });
    expect(await run({ name: "version" }, runtime({}))).toEqual({ version: VERSION });
  });
});
