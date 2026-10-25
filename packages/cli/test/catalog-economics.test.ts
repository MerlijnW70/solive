import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const CATALOG = readFileSync(join(ROOT, "docs/maintainers/catalog-economics.md"), "utf8");
const QUILL = "https://www.quillaudits.com/research/solana-audit-checklist";
const HELIUS = "https://helius.dev/blog/a-hitchhikers-guide-to-solana-program-security";
const PACKAGES = ["core", "client", "cli", "solver", "multisig"];
const RUST_ROOTS = ["tests/svm/tests/", "crates/intent-core/tests/"];
const NEW_TEST_FILES = [/^crates\/intent-core\/tests\/catalog_[a-z0-9_]+\.rs$/, /^tests\/svm\/tests\/catalog_econ_[a-z0-9_]+\.rs$/];

const ITEMS: Record<string, string[]> = {
  [QUILL]: [
    "Specs and invariants",
    "Account structure",
    "Attacker mindset: steal funds",
    "Attacker mindset: freeze the program",
    "Attacker mindset: misdirect funds",
    "Attacker mindset: alter critical state",
    "Attacker mindset: push a malicious upgrade",
    "Attacker mindset: exploit pricing",
    "Attacker mindset: claim excess refunds",
    "Attacker mindset: mint more tokens than allowed",
    "SPL reference comparison",
    "Local validator and cargo audit",
    "Separation of concerns and dead code",
    "Account types, sizes and discriminators",
    "Serialization safety",
    "Compute budget",
    "Missing ownership check",
    "Missing signer check",
    "Account confusion",
    "Arbitrary signed program invocation",
    "Integer overflow and underflow",
    "PDA seed collisions",
    "Rent exemption bypass",
    "Sysvar tampering",
    "Reentrancy and CPI depth",
    "Unsafe Rust blocks",
    "Outdated dependencies and CVEs",
    "Redundant code",
    "Best practices: assertions and error propagation",
    "Best practices: multisig for upgrades and timelocks",
    "Zero-knowledge proof verification",
    "Cross-chain bridge risks",
    "Logic verification against specs",
    "Contract-specific issues: AMM slippage",
    "Contract-specific issues: governance vote dilution",
    "Economic attacks: flash loans",
    "Economic attacks: oracle manipulation",
    "Economic attacks: sandwich attacks",
    "DoS: unbounded loops",
    "DoS: excessive account creation",
    "DoS: compute-heavy operations",
    "Front-running and MEV",
    "Unsafe upgrade designs",
    "Parallel execution races",
    "CPI ordering",
    "Account resize abuse",
    "Rug-pull mechanisms and backdoors",
    "Flash loan resistance",
    "Oracle security: freshness and source validation",
    "Upgradeability risks",
    "Unit and integration tests",
    "Simulation on a local validator or devnet",
    "Penetration testing",
    "Invariant monitoring and bounty programs",
    "Economic-related logic errors",
  ],
  [HELIUS]: [
    "Account Data Matching",
    "Account Data Reallocation",
    "Account Reloading",
    "Arbitrary CPI",
    "Authority Transfer Functionality",
    "Bump Seed Canonicalization",
    "Closing Accounts",
    "Duplicate Mutable Accounts",
    "Frontrunning",
    "Insecure Initialization",
    "Loss of Precision: rounding direction",
    "Loss of Precision: multiplication after division",
    "Loss of Precision: saturating arithmetic",
    "Missing Ownership Check",
    "Missing Signer Check",
    "Overflow and Underflow",
    "PDA Sharing",
    "Remaining Accounts",
    "Rust-Specific Errors",
    "Seed Collisions",
    "Type Cosplay",
  ],
};

const PATHS = [
  "fills",
  "splits",
  "fees",
  "partner cuts",
  "judge fees",
  "stakes",
  "rent",
  "refunds",
  "announcements",
  "mint caps",
  "epochs",
  "attested releases",
];

type Row = { id: string; source: string; item: string; path: string; applies: string; evidence: string };

const rows = (): Row[] =>
  CATALOG.split("\n")
    .filter((line) => /^\| *E-\d+/.test(line))
    .map((line) => {
      const cells = line.split(" | ").map((c) => c.replace(/^\|/, "").replace(/\|$/, "").trim());
      expect(cells, line).toHaveLength(6);
      const [id = "", source = "", item = "", path = "", applies = "", evidence = ""] = cells;
      return { id, source, item, path, applies, evidence };
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

const kaniSources = () => filesUnder(join(ROOT, "tests/proofs"), ".rs").map((f) => readFileSync(f, "utf8")).join("\n");

const testSources = new Map(
  PACKAGES.map((pkg) => [pkg, filesUnder(join(ROOT, "packages", pkg, "test"), ".ts").map((f) => readFileSync(f, "utf8")).join("\n")]),
);

const artefactsOf = (evidence: string) => [...evidence.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");

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

describe("catalog economics", () => {
  it("every row cites evidence that exists, and every row that does not apply names the code that rules it out", () => {
    const all = rows();
    expect(all.length).toBeGreaterThanOrEqual(100);
    expect(new Set(all.map((r) => r.id)).size).toBe(all.length);
    const jobs = ciJobs();
    const kani = kaniSources();
    const problems: string[] = [];
    for (const row of all) {
      if (!/^E-\d+$/.test(row.id)) {
        problems.push(`${row.id}: bad id`);
      }
      for (const [field, value] of Object.entries(row)) {
        if (value === "") {
          problems.push(`${row.id}: empty ${field}`);
        }
      }
      if (!row.source.includes(`](${QUILL})`) && !row.source.includes(`](${HELIUS})`)) {
        problems.push(`${row.id}: source links neither checklist`);
      }
      const artefacts = artefactsOf(row.evidence);
      if (row.applies === "yes") {
        if (artefacts.length === 0) {
          problems.push(`${row.id}: applies without evidence`);
        }
      } else if (row.applies.startsWith("no: ")) {
        const named = [...row.applies.matchAll(/\b((?:programs|crates|scripts|packages|tests)\/[\w./-]*\w|Cargo\.toml)\b/g)].map((m) => m[1] ?? "");
        if (named.length === 0) {
          problems.push(`${row.id}: does not apply without naming the code that rules it out`);
        }
        for (const file of named) {
          if (!existsSync(join(ROOT, file))) {
            problems.push(`${row.id}: names ${file}, which does not exist`);
          }
        }
      } else {
        problems.push(`${row.id}: applies is ${row.applies}`);
      }
      for (const artefact of artefacts) {
        const why = missing(artefact, jobs, kani);
        if (why !== undefined) {
          problems.push(`${row.id}: ${artefact}: ${why}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("every checklist item and every engine path has a row", () => {
    const all = rows();
    const uncovered = Object.entries(ITEMS).flatMap(([source, items]) =>
      items
        .filter((item) => !all.some((r) => r.source.includes(`](${source})`) && r.item.toLowerCase().includes(item.toLowerCase())))
        .map((item) => `${source}: ${item}`),
    );
    expect(uncovered).toEqual([]);
    expect(PATHS.filter((path) => !all.some((r) => r.path.includes(path)))).toEqual([]);
  });

  it("the new catalog tests the table cites live in the catalog test files", () => {
    const cited = rows()
      .flatMap((r) => artefactsOf(r.evidence))
      .filter((a) => a.startsWith("rust:"))
      .map((a) => a.slice("rust:".length).split("::"))
      .filter(([, name = ""]) => name.startsWith("catalog_"));
    expect(cited.length).toBeGreaterThan(0);
    expect(cited.filter(([file = ""]) => !NEW_TEST_FILES.some((pattern) => pattern.test(file)))).toEqual([]);
    const files = [...new Set(cited.map(([file = ""]) => file))];
    const declared = files.flatMap((f) =>
      [...readFileSync(join(ROOT, f), "utf8").matchAll(/\bfn (catalog_[a-z0-9_]+)\s*\(/g)].map((m) => m[1] ?? ""),
    );
    const names = new Set(cited.map(([, name = ""]) => name));
    expect(declared.filter((name) => !names.has(name))).toEqual([]);
  });
});
