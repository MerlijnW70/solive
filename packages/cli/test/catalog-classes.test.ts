import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const CATALOG = readFileSync(join(ROOT, "docs/maintainers/catalog-classes.md"), "utf8");
const PACKAGES = ["core", "client", "cli", "solver", "multisig"];
const RUST_ROOTS = ["tests/svm/tests/", "crates/intent-core/tests/"];
const SOURCES = [
  "https://github.com/coral-xyz/sealevel-attacks",
  "https://solana.com/developers/courses/program-security/",
  "https://helius.dev/blog/a-hitchhikers-guide-to-solana-program-security",
];
const EVERY_INSTRUCTION = ["Signer authorization", "Account data matching", "Owner checks", "Type cosplay", "Arbitrary CPI"];
const SEALEVEL = [
  "0-signer-authorization",
  "1-account-data-matching",
  "2-owner-checks",
  "3-type-cosplay",
  "4-initialization",
  "5-arbitrary-cpi",
  "6-duplicate-mutable-accounts",
  "7-bump-seed-canonicalization",
  "8-pda-sharing",
  "9-closing-accounts",
  "10-sysvar-address-checking",
];
const COURSE = [
  "signer-auth",
  "owner-checks",
  "account-data-matching",
  "reinitialization-attacks",
  "duplicate-mutable-accounts",
  "type-cosplay",
  "arbitrary-cpi",
  "bump-seed-canonicalization",
  "closing-accounts",
  "pda-sharing",
];
const HELIUS = [
  "Account data matching",
  "Account data reallocation",
  "Account reloading",
  "Arbitrary CPI",
  "Authority transfer functionality",
  "Bump seed canonicalization",
  "Closing accounts",
  "Duplicate mutable accounts",
  "Frontrunning",
  "Insecure initialization",
  "Multiplication after division",
  "Saturating arithmetic",
  "Rounding errors",
  "Owner checks",
  "Read-only accounts",
  "Signer authorization",
  "Overflow and underflow",
  "Casting",
  "PDA sharing",
  "Remaining accounts",
  "Unsafe Rust",
  "Panics and error management",
  "Seed collisions",
  "Type cosplay",
  "Logic bugs",
  "Data validation flaws",
  "Rust-specific issues",
  "Access control vulnerabilities",
  "Arithmetic and precision errors",
  "Cross-program invocation issues",
  "PDA misuse",
  "Input validation and access control checks",
  "Safe Rust",
  "Security best practices",
  "Code review and automated tools",
  "Third-party audit",
  "Bug bounty",
];

type Row = { id: string; cls: string; source: string; instruction: string; applies: string; reason: string; evidence: string };

const section = (title: string) => {
  const start = CATALOG.indexOf(`\n## ${title}\n`);
  expect(start, title).toBeGreaterThan(-1);
  const rest = CATALOG.slice(start + title.length + 5);
  const end = rest.indexOf("\n## ");
  return end === -1 ? rest : rest.slice(0, end);
};

const classes = () =>
  [...section("Classes").matchAll(/^- \*\*([^*]+)\*\*: (.+)$/gm)].map((m) => ({ title: m[1] ?? "", links: m[2] ?? "" }));

const rows = (): Row[] =>
  CATALOG.split("\n")
    .filter((line) => /^\| *C-\d+/.test(line))
    .map((line) => {
      const cells = line.split("|").slice(1, -1).map((c) => c.trim());
      expect(cells, line).toHaveLength(7);
      const [id = "", cls = "", source = "", instruction = "", applies = "", reason = "", evidence = ""] = cells;
      return { id, cls, source, instruction: instruction.replace(/`/g, ""), applies, reason, evidence };
    });

const instructions = () => {
  const lib = readFileSync(join(ROOT, "programs/intent_engine/src/lib.rs"), "utf8");
  return [...lib.slice(lib.indexOf("pub mod intent_engine")).matchAll(/pub fn ([a-z_]+)\(/g)].map((m) => m[1] ?? "");
};

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

const catalogTests = () =>
  readdirSync(join(ROOT, "tests/svm/tests"))
    .filter((name) => /^catalog_class_[a-z_]+\.rs$/.test(name))
    .flatMap((name) =>
      [...readFileSync(join(ROOT, "tests/svm/tests", name), "utf8").matchAll(/#\[test\]\s*fn ([a-z0-9_]+)\s*\(/g)].map(
        (m) => `rust:tests/svm/tests/${name}::${m[1] ?? ""}`,
      ),
    );

const slug = (title: string) => title.toLowerCase().replace(/[^a-z0-9]+/g, "_");

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
    case "file":
      return !value.startsWith("/") && !value.includes("..") && existsSync(join(ROOT, value)) ? undefined : "no such file";
    default:
      return "unknown artefact form";
  }
}

describe("vulnerability class catalog", () => {
  it("every row cites evidence that exists, or a file and mechanism that rule the class out", () => {
    const all = rows();
    const titles = new Set(classes().map((c) => c.title));
    const known = new Set(instructions());
    const jobs = ciJobs();
    const kani = kaniSources();
    const problems: string[] = [];
    expect(new Set(all.map((r) => r.id)).size).toBe(all.length);
    for (const row of all) {
      if (!titles.has(row.cls)) {
        problems.push(`${row.id}: class ${row.cls} is not listed`);
      }
      if (!SOURCES.some((url) => row.source.includes(`](${url}`))) {
        problems.push(`${row.id}: source is not one of the catalogued sources`);
      }
      if (!known.has(row.instruction) && row.instruction !== "every instruction" && row.instruction !== "every other instruction") {
        problems.push(`${row.id}: ${row.instruction} is not an instruction`);
      }
      if (row.reason === "") {
        problems.push(`${row.id}: empty reason`);
      }
      const artefacts = [...row.evidence.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");
      if (row.applies === "yes") {
        if (artefacts.length === 0) {
          problems.push(`${row.id}: applies without evidence`);
        }
      } else if (row.applies === "no") {
        const paths = [...row.reason.matchAll(/`([^`\s]+\/[^`\s]*|Cargo\.toml)`/g)].map((m) => m[1] ?? "");
        if (!paths.some((p) => existsSync(join(ROOT, p)))) {
          problems.push(`${row.id}: does not apply without naming a file in our code`);
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

  it("covers every class and checklist item of the sources and every instruction", () => {
    const listed = classes();
    const links = listed.map((c) => c.links).join("\n");
    expect(SEALEVEL.filter((dir) => !links.includes(`sealevel-attacks/tree/master/programs/${dir})`))).toEqual([]);
    expect(COURSE.filter((lesson) => !links.includes(`program-security/${lesson})`))).toEqual([]);
    expect(HELIUS.filter((title) => !listed.some((c) => c.title === title && c.links.includes("helius.dev")))).toEqual([]);
    const all = rows();
    expect(listed.map((c) => c.title).filter((title) => !all.some((r) => r.cls === title))).toEqual([]);
    const known = instructions();
    expect(known.length).toBeGreaterThanOrEqual(50);
    expect(known.filter((ix) => !all.some((r) => r.instruction === ix))).toEqual([]);
    for (const title of EVERY_INSTRUCTION) {
      expect(known.filter((ix) => !all.some((r) => r.cls === title && r.instruction === ix)), title).toEqual([]);
    }
    for (const { title } of listed) {
      const own = all.filter((r) => r.cls === title);
      const whole = own.some((r) => r.instruction.startsWith("every"));
      const each = known.every((ix) => own.some((r) => r.instruction === ix));
      expect(whole || each, title).toBe(true);
    }
  });

  it("cites every catalog test from the row named after its class and instruction", () => {
    const all = rows();
    const tests = catalogTests();
    expect(tests.length).toBeGreaterThan(0);
    const unnamed = tests.filter((test) => {
      const name = test.split("::")[1] ?? "";
      return !all.some((r) => name.startsWith(`${slug(r.cls)}_${r.instruction}_`) && r.evidence.includes(`\`${test}\``));
    });
    expect(unnamed).toEqual([]);
  });
});
