import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { climbs, ENGINE_FALLBACK, escapesIn, escapesOf, FALLBACK, missesRootExport } from "./package-copy-scan.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const UP = "." + ".";
const FAR = [UP, UP, UP].join("/");
const J = "jo" + "in";
const BT = String.fromCharCode(96);
const flagged = (depthFile: string, text: string) => escapesIn("/p", depthFile, text).map((e) => e.line);

describe("tests stay runnable from a copy of their package", () => {
  it("no config, setup or test file climbs out of its package without the root fallback", () => {
    const escapes = escapesOf(ROOT).map((e) => `${e.file.slice(ROOT.length + 1)}:${e.line}: ${e.text}`);
    expect(escapes).toEqual([]);
  });

  it("counts the levels of a literal and of a joined argument list", () => {
    expect(climbs(`new URL("${FAR}/docs/x.md", import.meta.url)`)).toBe(3);
    expect(climbs(`new URL("${UP}/package.json", import.meta.url)`)).toBe(1);
    expect(climbs(`${J}(HERE, "${UP}", "${UP}", "${UP}")`)).toBe(3);
    expect(climbs(`${J}(HERE, "${UP}")`)).toBe(1);
    expect(climbs(`import { a } from "${FAR}/scripts/a.mjs";`)).toBe(3);
    expect(climbs(`"x/${FAR}/evil"`)).toBe(0);
  });

  it("adds the levels of every argument of a join, not only the largest", () => {
    const text = `${J}(H, "${UP}", "${UP}/${UP}")`;
    expect(climbs(text)).toBe(3);
    expect(flagged("/p/test/sub/a.ts", text)).toEqual([1]);
    expect(flagged("/p/test/sub/sub/a.ts", text)).toEqual([]);
  });

  it("nets the levels of arguments that are not next to each other", () => {
    const text = `${J}(H, "${UP}", "x", "${UP}", "${UP}")`;
    expect(climbs(text)).toBe(2);
    expect(flagged("/p/test/a.ts", text)).toEqual([1]);
    expect(flagged("/p/test/sub/a.ts", text)).toEqual([]);
    expect(climbs(`${J}(H, "${UP}", "x")`)).toBe(1);
  });

  it("reads backtick arguments", () => {
    const text = `${J}(H, ${BT}${UP}${BT}, ${BT}${UP}${BT})`;
    expect(climbs(text)).toBe(2);
    expect(flagged("/p/test/a.ts", text)).toEqual([1]);
  });

  it("reads a join call written over several lines and names the line it starts on", () => {
    const text = `const a = 1;\nconst b = ${J}(\n  H,\n  "${UP}",\n  "${UP}",\n);`;
    expect(flagged("/p/test/a.ts", text)).toEqual([2]);
  });

  it("depth inside the package decides what climbs out", () => {
    const line = `const p = new URL("${UP}/${UP}/x", import.meta.url);`;
    expect(escapesIn("/p", "/p/test/a.ts", line)).toHaveLength(1);
    expect(escapesIn("/p", "/p/test/sub/a.ts", line)).toHaveLength(0);
    expect(escapesIn("/p", "/p/vitest.setup.ts", `new URL("${UP}/x", import.meta.url)`)).toHaveLength(1);
  });

  it("a climbing literal is allowed only as the operand of the fallback", () => {
    const kept = `const ROOT = process.env["${FALLBACK}"] ?? new URL("${FAR}", import.meta.url);`;
    expect(flagged("/p/test/a.ts", kept)).toEqual([]);
    const engine = `const so = process.env["${ENGINE_FALLBACK}"] ??\n  new URL("${FAR}/target/x.so", import.meta.url);`;
    expect(flagged("/p/test/a.ts", engine)).toEqual([]);
    const joinedKept = `const r = process.env["${FALLBACK}"] ?? ${J}(H, "${UP}", "${UP}", "${UP}");`;
    expect(flagged("/p/test/a.ts", joinedKept)).toEqual([]);
  });

  it("naming the root on one line does not excuse a climbing path on another", () => {
    const bypass = `const ROOT = process.env["${FALLBACK}"] ?? base;\nreadFileSync(new URL("${FAR}/docs/x.md", import.meta.url));`;
    expect(flagged("/p/test/a.ts", bypass)).toEqual([2]);
    const same = `const a = process.env["${FALLBACK}"] ?? base, b = new URL("${FAR}/x", import.meta.url);`;
    expect(flagged("/p/test/a.ts", same)).toEqual([1]);
    const afterFallback = `const so = process.env["${ENGINE_FALLBACK}"] ??\n  base;\nnew URL("${FAR}/x", import.meta.url);`;
    expect(flagged("/p/test/a.ts", afterFallback)).toEqual([3]);
  });

  it("reports file and line", () => {
    const bad = `\nconst ROOT = new URL("${FAR}", import.meta.url);`;
    expect(escapesIn("/p", "/p/test/a.ts", bad)).toEqual([{ file: "/p/test/a.ts", line: 2, text: bad.trim() }]);
  });

  it("a type-only import is erased at run time and is not a path", () => {
    expect(flagged("/p/test/a.ts", `import type { A } from "${FAR}/scripts/a.mjs";`)).toEqual([]);
    expect(flagged("/p/test/a.ts", `import { A } from "${FAR}/scripts/a.mjs";`)).toEqual([1]);
  });

  it("a test script that takes the repo root must export it", () => {
    const takes = '#!/usr/bin/env bash\nif [[ -n "${1:-}" ]]; then\n  export INTENT_ENGINE_SO="$1/x"\nfi\n';
    expect(missesRootExport(takes)).toBe(true);
    expect(missesRootExport(takes.replace("fi\n", '  export INTENT_ENGINE_ROOT="$1"\nfi\n'))).toBe(false);
    expect(missesRootExport("#!/usr/bin/env bash\necho hi\n")).toBe(false);
  });
});
