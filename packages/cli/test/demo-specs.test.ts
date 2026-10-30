import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isMemoUrl, PRODUCT_REPOSITORY } from "@intent-engine/core/internal";
import { DEMO_BASE_URL, DEMO_SPECS, demoSpecUrl, JOB_PROMPTS, MARKET_GUIDE, MARKET_LINES } from "../src/agent/mcp.js";
import { judgeHost } from "../src/host-judge.js";
import { casesOf, judgeViper, pinnedWasm } from "../src/viper.js";

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const DEMO_DIR = join(ROOT, "examples", "demo");
const TIMEOUT = 60;

const WRONG: Record<string, string> = {
  fizzbuzz: 'export default (n) => (n % 15 === 0 ? "FizzBuzz" : n % 3 === 0 ? "Buzz" : n % 5 === 0 ? "Fizz" : String(n));\n',
  palindrome: 'export default (text) => { const kept = text.toLowerCase().replace(/[^a-z0-9]/g, ""); return kept === kept.split("").reverse().join(""); };\n',
  "reverse-words": 'export default (text) => text.split(" ").reverse().join(" ");\n',
};

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const bytes = (text: string) => new TextEncoder().encode(text);

const demoNames = async () =>
  (await readdir(DEMO_DIR, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

const prompt = (name: string) => JOB_PROMPTS.find((one) => one.name === name)?.text ?? "";

describe("the demo specs", () => {
  it("lists at least three demo specs, each in examples/demo with its sha256 and a raw repository url that fits the memo url rule", async () => {
    const names = await demoNames();
    expect(names.length).toBeGreaterThanOrEqual(3);
    expect(DEMO_SPECS.map(({ name }) => name)).toEqual(names);
    expect(DEMO_BASE_URL).toBe(`${PRODUCT_REPOSITORY.replace("https://github.com/", "https://raw.githubusercontent.com/")}/main/examples/demo`);
    for (const { name, sha256: pinned } of DEMO_SPECS) {
      expect([name, sha256(await readFile(join(DEMO_DIR, name, "SPEC.md")))]).toEqual([name, pinned]);
      expect([name, isMemoUrl(demoSpecUrl(name)), demoSpecUrl(name)]).toEqual([name, true, `${DEMO_BASE_URL}/${name}/SPEC.md`]);
    }
  });

  for (const name of Object.keys(WRONG)) {
    it(`${name}: its judge cases pass its own solution in ViperJS and the host engine and fail a wrong one`, async () => {
      const spec = await readFile(join(DEMO_DIR, name, "SPEC.md"));
      const cases = casesOf(spec);
      expect(cases.cases.length).toBeGreaterThan(5);
      const solution = await readFile(join(DEMO_DIR, name, "solution.mjs"));
      const wasm = await pinnedWasm();
      const total = cases.cases.length;
      expect(await judgeViper(wasm, solution, cases, TIMEOUT)).toMatchObject({ total, passed: total, failures: [] });
      expect(await judgeHost(solution, cases, TIMEOUT)).toMatchObject({ total, passed: total, failures: [] });
      const wrong = bytes(WRONG[name] ?? "");
      expect((await judgeViper(wasm, wrong, cases, TIMEOUT)).failures.length).toBeGreaterThan(0);
      expect((await judgeHost(wrong, cases, TIMEOUT)).failures.length).toBeGreaterThan(0);
    }, 120_000);
  }

  it("has a wrong solution in this test for every demo", async () => {
    expect(Object.keys(WRONG).sort()).toEqual(await demoNames());
  });
});

describe("the demo hire path in the guide and prompts", () => {
  it("offers every demo spec in one line of the guide, with its url, its sha256 and the hirer's own wallet as judge", () => {
    const line = MARKET_LINES.find((one) => one.includes("demo worker")) ?? "";
    expect(line).toContain("plain words");
    expect(line).toContain("own wallet as judge");
    for (const { name, task, sha256: pinned } of DEMO_SPECS) {
      expect(line).toContain(`${name} (${task}): spec_url ${demoSpecUrl(name)}, spec_hash ${pinned}`);
    }
  });

  it("names wallet_judge_work for a demo job and Docker only for a spec that needs a container", () => {
    for (const text of [MARKET_GUIDE, prompt("hire"), prompt("judge")]) {
      expect(text).toMatch(/solive_wallet_judge_work for a demo job|demo job, or one JavaScript module whose spec has a judge-cases block, with solive_wallet_judge_work|demo job or one JavaScript module whose spec has a judge-cases block with solive_wallet_judge_work/);
      expect(text).toContain("judge --sandbox docker only when");
      expect(text).toContain("needs a container");
    }
  });

  it("tells the hire prompt to offer a demo when the user has no spec, in plain words, pinned by its hash, with the user's wallet as judge", () => {
    const hire = prompt("hire");
    for (const point of ["If I have no spec, offer me the demo jobs", "in plain words", "pin it by its spec_hash and spec_url", "my own wallet"]) {
      expect([point, hire.includes(point)]).toEqual([point, true]);
    }
  });
});
