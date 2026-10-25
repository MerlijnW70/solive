import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../../..", import.meta.url));
const TABLE = readFileSync(join(ROOT, "docs/maintainers/catalog-incidents.md"), "utf8");
const PACKAGES = ["core", "client", "cli", "solver", "multisig"];
const RUST_ROOTS = ["tests/svm/tests/", "crates/intent-core/tests/"];
const HELIUS = "https://helius.dev/blog/solana-hacks";
const CERTIK = "https://www.certik.com/blog/2022-solana-exploits-overview";
const PROVING = ["rust", "kani", "ts", "fuzz", "ci"];

const INVENTORY: Record<string, string[]> = {
  "Application exploit": [
    "Solend auth bypass",
    "Wormhole",
    "Cashio",
    "Crema Finance",
    "Audius governance",
    "Nirvana Finance",
    "Slope wallet",
    "OptiFi",
    "Mango Markets",
    "UXD Protocol",
    "Tulip Protocol",
    "Save (Solend) oracle",
    "Raydium",
    "Cypher Protocol",
    "SVT Token",
    "Synthetify DAO",
    "Thunder Terminal",
    "Aurory SyncSpace",
    "Saga DAO",
    "Solareum",
    "io.net",
    "Pump.fun",
    "Banana Gun",
    "DEXX",
    "NoOnes",
    "Loopscale",
  ],
  "Supply chain attack": ["Parcl front end", "Web3.js"],
  "Core protocol vulnerability": ["Turbine bug", "Durable nonce bug", "Duplicate block bug", "Turbine failure", "JIT cache bug", "ELF address alignment"],
  "Network-level attack": ["Grape IDO", "Candy Machine", "Jito DDoS", "Phantom DDoS"],
  "Exit scam": ["SolFire", "COPE", "Big Daddy Ape Club", "Doodled Dragons"],
  "Attack class": ["Private key compromise", "Code vulnerability", "Exit scams"],
  Checklist: ["Do your own research", "Review audits", "Assess centralization", "KYC badge", "Follow security alerts"],
};

type Row = { id: string; kind: string; incident: string; source: string; pattern: string; where: string; applies: string; evidence: string };

const rows = (text: string): Row[] =>
  text
    .split("\n")
    .filter((line) => /^\| *CI-\d+/.test(line))
    .map((line) => {
      const cells = line.split(" | ").map((c) => c.replace(/^\| */, "").replace(/ *\|$/, "").trim());
      expect(cells, line).toHaveLength(8);
      const [id = "", kind = "", incident = "", source = "", pattern = "", where = "", applies = "", evidence = ""] = cells;
      return { id, kind, incident, source, pattern, where, applies, evidence };
    });

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

const kani = filesUnder(join(ROOT, "tests/proofs"), ".rs").map((f) => readFileSync(f, "utf8")).join("\n");
const testSources = new Map(PACKAGES.map((pkg) => [pkg, filesUnder(join(ROOT, "packages", pkg, "test"), ".ts").map((f) => readFileSync(f, "utf8")).join("\n")]));
const threats = new Set([...readFileSync(join(ROOT, "docs/maintainers/threat-model.md"), "utf8").matchAll(/^\| (T-\d+) \|/gm)].map((m) => m[1] ?? ""));

function missing(artefact: string, jobs: Set<string>, sources: Map<string, string>): string | undefined {
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
      return new RegExp(`#\\[test\\]\\s*fn ${name}\\s*\\(`).test(readFileSync(path, "utf8")) ? undefined : "no such test fn";
    }
    case "kani":
      return /^[a-z0-9_]+$/.test(value) && new RegExp(`#\\[kani::proof\\](?:\\s*#\\[[^\\]]*\\])*\\s*fn ${value}\\s*\\(`).test(kani) ? undefined : "no such kani harness";
    case "ts": {
      const [pkg = "", ...rest] = parts;
      const title = rest.join(":");
      const source = sources.get(pkg);
      if (source === undefined || title === "") {
        return "malformed ts artefact";
      }
      return new RegExp(`\\b(?:it|test)(?:\\.\\w+)?\\(\\s*"${escape(title)}"`).test(source) ? undefined : "no test with that title";
    }
    case "fuzz":
      return /^[a-z0-9_]+$/.test(value) && existsSync(join(ROOT, "crates/intent-core/fuzz/fuzz_targets", `${value}.rs`)) ? undefined : "no such fuzz target";
    case "ci":
      return jobs.has(value) ? undefined : "no such ci job";
    case "file":
      return value !== "" && !value.includes("..") && existsSync(join(ROOT, value)) ? undefined : "no such file";
    case "threat":
      return threats.has(value) ? undefined : "no such threat model row";
    default:
      return "unknown artefact form";
  }
}

const artefactsOf = (text: string) => [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");

function problemsOf(all: Row[], sources: Map<string, string>): string[] {
  const jobs = ciJobs();
  const problems: string[] = [];
  for (const row of all) {
    for (const [field, value] of Object.entries(row)) {
      if (value === "") {
        problems.push(`${row.id}: empty ${field}`);
      }
    }
    if (!row.source.includes(HELIUS) && !row.source.includes(CERTIK)) {
      problems.push(`${row.id}: the source names neither collection`);
    }
    const reason = artefactsOf(row.applies);
    const evidence = artefactsOf(row.evidence);
    if (row.applies.startsWith("yes: ")) {
      if (!evidence.some((a) => PROVING.includes(a.split(":")[0] ?? ""))) {
        problems.push(`${row.id}: applies without a test or check`);
      }
    } else if (row.applies.startsWith("no: ")) {
      if (!reason.some((a) => a.startsWith("file:"))) {
        problems.push(`${row.id}: does not apply without naming the file whose mechanism rules it out`);
      }
    } else {
      problems.push(`${row.id}: applies must start with yes: or no:`);
    }
    for (const artefact of [...reason, ...evidence]) {
      const why = missing(artefact, jobs, sources);
      if (why !== undefined) {
        problems.push(`${row.id}: ${artefact}: ${why}`);
      }
    }
  }
  return problems;
}

describe("CAT incident catalog citations", () => {
  it("CAT every row of the incident catalog cites evidence that exists", () => {
    const all = rows(TABLE);
    expect(all.map((r) => r.id)).toEqual(all.map((_, i) => `CI-${String(i + 1).padStart(2, "0")}`));
    expect(problemsOf(all, testSources)).toEqual([]);
    expect(TABLE).toContain("](threat-model.md)");
  });

  it("CAT the catalog has a row for every incident, class and checklist item in both sources, and no other", () => {
    const all = rows(TABLE);
    const listed = all.map((r) => `${r.kind}: ${r.incident}`);
    const expected = Object.entries(INVENTORY).flatMap(([kind, names]) => names.map((name) => `${kind}: ${name}`));
    expect([...listed].sort()).toEqual([...expected].sort());
    expect(all.filter((r) => r.source.includes(CERTIK)).map((r) => r.incident)).toEqual(
      expect.arrayContaining(["Wormhole", "Mango Markets", "Slope wallet", "Raydium", "Cashio", "Solend auth bypass", "OptiFi", "SolFire", "COPE"]),
    );
  });

  it("CAT every catalog test written for this table is cited by it", () => {
    const cited = new Set(rows(TABLE).flatMap((r) => artefactsOf(r.evidence)));
    const rust = readdirSync(join(ROOT, "tests/svm/tests"))
      .filter((f) => /^catalog_incident_\w+\.rs$/.test(f))
      .flatMap((f) => [...readFileSync(join(ROOT, "tests/svm/tests", f), "utf8").matchAll(/#\[test\]\s*fn (\w+)\s*\(/g)].map((m) => `rust:tests/svm/tests/${f}::${m[1] ?? ""}`));
    const ts = PACKAGES.flatMap((pkg) =>
      filesUnder(join(ROOT, "packages", pkg, "test", "catalog"), ".test.ts")
        .filter((f) => !f.endsWith("incident-citations.test.ts"))
        .flatMap((f) => [...readFileSync(f, "utf8").matchAll(/\bit\(\s*"(CAT [^"]+)"/g)].map((m) => `ts:${pkg}:${m[1] ?? ""}`)),
    );
    expect(rust.length).toBeGreaterThanOrEqual(10);
    expect(ts.length).toBeGreaterThanOrEqual(6);
    expect([...rust, ...ts].filter((a) => !cited.has(a))).toEqual([]);
  });

  it("CAT a renamed or missing test, file, job or threat row is reported", () => {
    const [first] = rows(TABLE).filter((r) => r.applies.startsWith("yes: ") && artefactsOf(r.evidence).some((a) => a.startsWith("rust:")));
    if (first === undefined) {
      throw new Error("no row cites a rust test");
    }
    const renamed = { ...first, evidence: first.evidence.replace(/`rust:([^`]+)::(\w+)`/, "`rust:$1::$2_renamed`") };
    expect(problemsOf([renamed], testSources).some((p) => p.includes("no such test fn"))).toBe(true);
    const blank = new Map(PACKAGES.map((pkg) => [pkg, ""]));
    const tsRow = rows(TABLE).find((r) => artefactsOf(r.evidence).some((a) => a.startsWith("ts:")));
    expect(tsRow).toBeDefined();
    expect(problemsOf(tsRow === undefined ? [] : [tsRow], blank).some((p) => p.includes("no test with that title"))).toBe(true);
    const base = { ...first, applies: "no: see `file:programs/intent_engine/src/absent.rs`", evidence: "`ci:nowhere`, `threat:T-0`" };
    expect(problemsOf([base], testSources)).toEqual([
      `${first.id}: file:programs/intent_engine/src/absent.rs: no such file`,
      `${first.id}: ci:nowhere: no such ci job`,
      `${first.id}: threat:T-0: no such threat model row`,
    ]);
    expect(problemsOf([{ ...first, applies: "no: it cannot happen", evidence: "" }], testSources)).toEqual([
      `${first.id}: empty evidence`,
      `${first.id}: does not apply without naming the file whose mechanism rules it out`,
    ]);
  });
});
