import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const MODEL = readFileSync(join(ROOT, "docs/maintainers/threat-model.md"), "utf8");
const STATUSES = ["mitigated", "partial", "open"];
const PACKAGES = ["core", "client", "cli", "solver", "multisig"];
const RUST_ROOTS = ["tests/svm/tests/", "crates/intent-core/tests/"];
const OPEN_WEAKNESSES = [
  "published by hand with a token, without provenance",
  "role keys (filler, judge, wallet) are files on one machine",
];

type Row = { id: string; actor: string; asset: string; attack: string; impact: string; status: string; evidence: string };

const section = (title: string) => {
  const start = MODEL.indexOf(`\n## ${title}\n`);
  expect(start, title).toBeGreaterThan(-1);
  const rest = MODEL.slice(start + title.length + 5);
  const end = rest.indexOf("\n## ");
  return end === -1 ? rest : rest.slice(0, end);
};

const rows = (): Row[] =>
  MODEL.split("\n")
    .filter((line) => /^\| *T-\d+/.test(line))
    .map((line) => {
      const cells = line.split("|").slice(1, -1).map((c) => c.trim());
      expect(cells, line).toHaveLength(7);
      const [id = "", actor = "", asset = "", attack = "", impact = "", status = "", evidence = ""] = cells;
      return { id, actor, asset, attack, impact, status, evidence };
    });

const bulletNames = (text: string) => [...text.matchAll(/^- \*\*([^*]+)\*\*: /gm)].map((m) => m[1] ?? "");

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const filesUnder = (dir: string, ending: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? filesUnder(join(dir, e.name), ending) : e.name.endsWith(ending) ? [join(dir, e.name)] : [],
      )
    : [];

const ciJobs = () => {
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");
  return new Set([...ci.slice(ci.indexOf("\njobs:")).matchAll(/^ {2}([\w-]+):$/gm)].map((m) => m[1] ?? ""));
};

const kaniSources = () => filesUnder(join(ROOT, "tests/proofs"), ".rs").map((f) => readFileSync(f, "utf8")).join("\n");

const testSources = new Map(
  PACKAGES.map((pkg) => [pkg, filesUnder(join(ROOT, "packages", pkg, "test"), ".ts").map((f) => readFileSync(f, "utf8")).join("\n")]),
);

function missing(artefact: string, jobs: Set<string>, kani: string): string | undefined {
  const [kind = "", ...parts] = artefact.split(":");
  const value = parts.join(":");
  switch (kind) {
    case "rust": {
      const [file = "", name = ""] = value.split("::");
      if (!RUST_ROOTS.some((root) => file.startsWith(root)) || !file.endsWith(".rs") || !/^[a-z0-9_]+$/.test(name)) {
        return "malformed rust artefact";
      }
      const path = join(ROOT, file);
      if (!existsSync(path)) {
        return "no such file";
      }
      return new RegExp(`\\bfn ${name}\\s*\\(`).test(readFileSync(path, "utf8")) ? undefined : "no such fn";
    }
    case "kani":
      return /^[a-z0-9_]+$/.test(value) && new RegExp(`#\\[kani::proof\\](?:\\s*#\\[[^\\]]*\\])*\\s*fn ${value}\\s*\\(`).test(kani)
        ? undefined
        : "no such kani harness";
    case "ts": {
      const [pkg = "", ...rest] = parts;
      const title = rest.join(":");
      const source = testSources.get(pkg);
      if (source === undefined || title === "") {
        return "malformed ts artefact";
      }
      return new RegExp(`\\b(?:it|test)(?:\\.\\w+)?\\(\\s*"${escape(title)}"`).test(source) ? undefined : "no test with that title";
    }
    case "fuzz":
      return /^[a-z0-9_]+$/.test(value) && existsSync(join(ROOT, "crates/intent-core/fuzz/fuzz_targets", `${value}.rs`)) ? undefined : "no such fuzz target";
    case "ci":
      return jobs.has(value) ? undefined : "no such ci job";
    default:
      return "unknown artefact form";
  }
}

describe("threat model", () => {
  it("every threat model claim cites evidence that exists", () => {
    const all = rows();
    expect(all.length).toBeGreaterThanOrEqual(25);
    expect(new Set(all.map((r) => r.id)).size).toBe(all.length);
    const assets = new Set(bulletNames(section("Assets")));
    const jobs = ciJobs();
    const kani = kaniSources();
    const problems: string[] = [];
    for (const row of all) {
      if (!/^T-\d+$/.test(row.id)) {
        problems.push(`${row.id}: bad id`);
      }
      for (const [field, value] of Object.entries(row)) {
        if (value === "") {
          problems.push(`${row.id}: empty ${field}`);
        }
      }
      if (!STATUSES.includes(row.status)) {
        problems.push(`${row.id}: status ${row.status}`);
      }
      if (!assets.has(row.asset)) {
        problems.push(`${row.id}: asset ${row.asset} is not listed`);
      }
      const artefacts = [...row.evidence.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");
      if (row.status === "open") {
        if (!row.evidence.startsWith("Planned: ")) {
          problems.push(`${row.id}: an open row names its planned control first`);
        }
      } else if (artefacts.length === 0) {
        problems.push(`${row.id}: ${row.status} without evidence`);
      }
      for (const artefact of artefacts) {
        const why = missing(artefact, jobs, kani);
        if (why !== undefined) {
          problems.push(`${row.id}: ${artefact}: ${why}`);
        }
      }
    }
    expect(problems).toEqual([]);
    expect(MODEL).toContain("](../../SECURITY.md)");
    expect(MODEL).toContain("](operations.md)");
    expect(readFileSync(join(ROOT, "SECURITY.md"), "utf8")).toContain("](docs/maintainers/threat-model.md)");
  });

  it("the threat model covers every actor and every known open weakness", () => {
    const all = rows();
    const actors = bulletNames(section("Actors and their powers"));
    expect(actors).toEqual([
      "owner",
      "solver",
      "worker",
      "judge",
      "relayer",
      "agent",
      "partner",
      "cranker",
      "admin",
      "guardian",
      "RPC node",
      "supply chain",
      "anyone",
    ]);
    expect(actors.filter((actor) => !all.some((r) => r.actor === actor))).toEqual([]);
    expect(all.filter((r) => !actors.includes(r.actor)).map((r) => r.id)).toEqual([]);
    const open = all.filter((r) => r.status === "open");
    expect(OPEN_WEAKNESSES.filter((weakness) => !open.some((r) => r.attack.toLowerCase().includes(weakness.toLowerCase())))).toEqual([]);
    const ranked = [...section("Open, in order").matchAll(/T-\d+/g)].map((m) => m[0]);
    expect(new Set(ranked).size).toBe(ranked.length);
    expect([...ranked].sort()).toEqual(open.map((r) => r.id).sort());
  });
});
