import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../../..", import.meta.url));
const WORKFLOWS = join(ROOT, ".github/workflows");
const ACTIONS = join(ROOT, ".github/actions");
const COMPROMISED: [string, string[]][] = [["@solana/web3.js", ["1.95.6", "1.95.7"]]];

const read = (path: string) => readFileSync(path, "utf8");
const workflows = () => readdirSync(WORKFLOWS).filter((f) => f.endsWith(".yml")).map((f) => ({ name: f, text: read(join(WORKFLOWS, f)) }));
const localActions = () =>
  readdirSync(ACTIONS, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => readdirSync(join(ACTIONS, entry.name)).filter((f) => /^action\.ya?ml$/.test(f)).map((f) => ({ name: `actions/${entry.name}/${f}`, text: read(join(ACTIONS, entry.name, f)) })));
const usesLines = (name: string, text: string) =>
  text.split("\n").filter((line) => /^\s*-?\s*uses:/.test(line)).map((line) => ({ name, line: line.trim() }));
const unpinned = (uses: { name: string; line: string }[]) =>
  uses.filter(({ line }) => !/uses: ([\w.-]+\/[\w./-]+@[0-9a-f]{40}|\.\/\.github\/actions\/[\w-]+)$/.test(line));
const scripts = () => readdirSync(join(ROOT, "scripts")).filter((f) => f.endsWith(".sh")).map((f) => ({ name: f, text: read(join(ROOT, "scripts", f)) }));

const resolved = (lock: string) =>
  new Set([...lock.slice(lock.indexOf("\npackages:")).matchAll(/^ {2}'?((?:@[^/@\s]+\/)?[^@\s']+)@([^(:'\s]+)/gm)].map((m) => `${m[1]}@${m[2]}`));

describe("CAT incident supply chain: Web3.js, OptiFi and the release pipeline", () => {
  it("CAT Web3.js: the lockfile resolves no release known to ship key-stealing code, and every install is frozen to it", () => {
    const lock = read(join(ROOT, "pnpm-lock.yaml"));
    const packages = resolved(lock);
    expect(packages.size).toBeGreaterThan(100);
    expect(packages.has("@codama/cli@1.6.3")).toBe(true);
    const bad = COMPROMISED.flatMap(([name, versions]) => versions.map((v) => `${name}@${v}`)).filter((p) => packages.has(p));
    expect(bad).toEqual([]);
    expect([...packages].filter((p) => p.startsWith("@solana/web3.js@"))).toEqual([]);
    expect(resolved(`\npackages:\n\n  '@solana/web3.js@1.95.6':\n    resolution: {}\n`).has("@solana/web3.js@1.95.6")).toBe(true);
    const installs = [...workflows(), ...scripts()].flatMap(({ name, text }) =>
      text.split("\n").filter((line) => /\bpnpm install\b/.test(line)).map((line) => ({ name, line: line.trim() })),
    );
    expect(installs.length).toBeGreaterThan(3);
    expect(installs.filter(({ line }) => !line.includes("--frozen-lockfile"))).toEqual([]);
  });

  it("CAT supply chain: every action in every workflow is pinned to a full commit, not a tag that can move", () => {
    const uses = [...workflows(), ...localActions()].flatMap(({ name, text }) => usesLines(name, text));
    expect(uses.length).toBeGreaterThan(5);
    expect(localActions().map(({ name }) => name)).toContain("actions/agave/action.yml");
    expect(unpinned(uses)).toEqual([]);
  });

  it("the pin check refuses a tag, a branch and a missing hash, in a workflow or inside a local action", () => {
    const bad = [
      usesLines("actions/x/action.yml", "runs:\n  steps:\n    - uses: actions/checkout@v4\n"),
      usesLines("actions/x/action.yml", "runs:\n  steps:\n    - uses: actions/checkout@main\n"),
      usesLines("workflows/y.yml", "    steps:\n      - uses: actions/checkout\n"),
      usesLines("actions/x/action.yml", "    - uses: ./.github/actions/x/../../../evil\n"),
    ].flat();
    expect(unpinned(bad)).toHaveLength(4);
    const good = usesLines("actions/x/action.yml", `    - uses: actions/checkout@${"a".repeat(40)}\n    - uses: ./.github/actions/agave\n`);
    expect(unpinned(good)).toEqual([]);
  });

  it("CAT OptiFi: no script or workflow runs a program close; the only mention tells an operator how to reclaim a stray buffer", () => {
    const mentions = [...workflows(), ...scripts()].flatMap(({ name, text }) =>
      text.split("\n").filter((line) => /program close/.test(line)).map((line) => ({ name, line: line.trim() })),
    );
    expect(mentions.map((m) => m.name)).toEqual(["deploy.sh"]);
    expect(mentions.filter(({ line }) => !/^echo "refusing: .*reclaim its rent with solana program close \$buffer" >&2$/.test(line))).toEqual([]);
  });
});
