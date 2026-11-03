import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { SANDBOX_IMAGE } from "../src/sandbox.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  "timeout-minutes"?: number;
  env?: Record<string, string>;
  with?: Record<string, string>;
}
interface Job {
  steps: Step[];
  "timeout-minutes"?: number;
  "continue-on-error"?: boolean;
}
const workflow = (name: string) => parse(read(`.github/workflows/${name}`)) as { jobs: Record<string, Job> };
const workflowNames = readdirSync(join(ROOT, ".github/workflows")).filter((name) => name.endsWith(".yml"));
const runsOf = (job: Job) => job.steps.map((step) => step.run ?? "");
const indexOfRun = (job: Job, pattern: RegExp) => job.steps.findIndex((step) => pattern.test(step.run ?? ""));
const indexOfUses = (job: Job, prefix: string) => job.steps.findIndex((step) => (step.uses ?? "").startsWith(prefix));

const run = (command: string, args: string[], env: Record<string, string>) =>
  new Promise<{ code: number; out: string; err: string }>((resolve) => {
    execFile(command, args, { env: { PATH: process.env["PATH"] ?? "", ...env } }, (error, out, err) => {
      resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : 1, out: out.trim(), err: err.trim() });
    });
  });

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const base58 = (bytes: Uint8Array) => {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let text = "";
  while (n > 0n) {
    text = ALPHABET[Number(n % 58n)] + text;
    n /= 58n;
  }
  return text;
};

async function chain(body: Buffer) {
  const dataAddress = new Uint8Array(32).fill(7);
  const dataKey = base58(dataAddress);
  const program = Buffer.concat([Buffer.from([2, 0, 0, 0]), dataAddress]);
  const data = Buffer.concat([Buffer.from([3, 0, 0, 0]), Buffer.alloc(41), body]);
  let hits = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      hits++;
      const asked = (JSON.parse(Buffer.concat(chunks).toString()) as { params: [string] }).params[0];
      const account = asked === dataKey ? data : program;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { value: { data: [account.toString("base64"), "base64"] } } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, hits: () => hits, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

describe("the program fixtures", () => {
  const fetchScript = join(ROOT, "scripts/fetch-program.sh");
  const body = Buffer.from("a pinned program body");
  const pinned = sha256(body);
  const program = "SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf";

  it("fetch once, then come from the cache without asking the node, and the cache is checked against the hash", async () => {
    const cache = mkdtempSync(join(tmpdir(), "fixtures-"));
    const node = await chain(body);
    try {
      const first = await run("bash", [fetchScript, program, pinned, "fixture.so", node.url], { XDG_CACHE_HOME: cache });
      expect(first).toMatchObject({ code: 0, out: join(cache, "solive-fixtures/fixture.so") });
      expect(readFileSync(first.out)).toEqual(body);
      const asked = node.hits();
      expect(asked).toBeGreaterThan(0);
      const second = await run("bash", [fetchScript, program, pinned, "fixture.so", "http://127.0.0.1:1"], { XDG_CACHE_HOME: cache });
      expect(second).toMatchObject({ code: 0, out: first.out });
      expect(node.hits()).toBe(asked);
      writeFileSync(first.out, "tampered");
      const third = await run("bash", [fetchScript, program, pinned, "fixture.so", node.url], { XDG_CACHE_HOME: cache });
      expect(third.code).toBe(0);
      expect(readFileSync(first.out)).toEqual(body);
      expect(node.hits()).toBeGreaterThan(asked);
    } finally {
      await node.close();
    }
  });

  it("refuse a program that hashes to something else and keep nothing of it", async () => {
    const cache = mkdtempSync(join(tmpdir(), "fixtures-"));
    const node = await chain(body);
    try {
      const wrong = "0".repeat(64);
      const refused = await run("bash", [fetchScript, program, wrong, "fixture.so", node.url], { XDG_CACHE_HOME: cache });
      expect(refused.code).toBe(1);
      expect(refused.err).toContain(`hashes to ${pinned}, not the pinned ${wrong}`);
      expect(readdirSync(join(cache, "solive-fixtures"))).toEqual([]);
    } finally {
      await node.close();
    }
  });

  it("are cached by every job that runs them, under the path and a key the pinned scripts decide", () => {
    expect(read("scripts/fetch-program.sh")).toContain('dir="${XDG_CACHE_HOME:-$HOME/.cache}/solive-fixtures"');
    expect(read("scripts/ts-test.sh")).toContain("bash scripts/fetch-squads.sh");
    expect(read("scripts/ts-test.sh")).toContain("bash scripts/fetch-program-metadata.sh");
    const keyed = readdirSync(join(ROOT, "scripts")).filter((name) => /^fetch-.*\.sh$/.test(name));
    expect(keyed).toEqual(expect.arrayContaining(["fetch-squads.sh", "fetch-program-metadata.sh", "fetch-program.sh"]));
    let covered = 0;
    for (const name of workflowNames) {
      for (const [id, job] of Object.entries(workflow(name).jobs)) {
        const needs = runsOf(job).findIndex((text) => /scripts\/(ci|ts-test)\.sh/.test(text));
        if (needs < 0) continue;
        const cache = job.steps.findIndex((step) => (step.uses ?? "").startsWith("actions/cache@"));
        expect(cache, `${name} ${id} caches the fixtures`).toBeGreaterThanOrEqual(0);
        expect(cache).toBeLessThan(needs);
        expect(job.steps[cache]?.with).toEqual({
          path: "~/.cache/solive-fixtures",
          key: "solive-fixtures-${{ hashFiles('scripts/fetch-*.sh') }}",
        });
        covered++;
      }
    }
    expect(covered).toBe(3);
  });
});

describe("the agave pin", () => {
  const action = parse(read(".github/actions/agave/action.yml")) as { runs: { steps: Step[] } };

  it("is written once, in a pinned download that is checked against its hash", () => {
    const env = action.runs.steps[0]?.env ?? {};
    expect(env["AGAVE_VERSION"]).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(env["AGAVE_SHA256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(action.runs.steps[0]?.run).toContain("sha256sum --check --strict");
    for (const name of workflowNames) {
      expect(read(`.github/workflows/${name}`), name).not.toMatch(/AGAVE_|anza-xyz\/agave|solana-release/);
    }
  });

  it("is used by every job that runs a Solana tool, before the first one", () => {
    let used = 0;
    for (const name of workflowNames) {
      for (const [id, job] of Object.entries(workflow(name).jobs)) {
        const tool = indexOfRun(job, /scripts\/(ci|sbf|validator-test|faucet)\.sh/);
        const agave = indexOfUses(job, "./.github/actions/agave");
        if (tool < 0) {
          expect(agave, `${name} ${id} installs agave it never uses`).toBe(-1);
          continue;
        }
        expect(agave, `${name} ${id} installs agave`).toBeGreaterThanOrEqual(0);
        expect(agave).toBeLessThan(tool);
        used++;
      }
    }
    expect(used).toBe(4);
  });
});

describe("the docs", () => {
  const manifest = JSON.parse(read("package.json")) as { scripts: Record<string, string>; devDependencies: Record<string, string> };

  it("build from a locked vitepress, in CI and for Pages", () => {
    const version = manifest.devDependencies["vitepress"] ?? "";
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(read("pnpm-lock.yaml")).toContain(`vitepress@${version}`);
    expect(manifest.scripts["docs:build"]).toBe("vitepress build docs");
    for (const name of workflowNames) expect(read(`.github/workflows/${name}`), name).not.toMatch(/vitepress@|vitepress build/);
    for (const [file, id] of [["docs.yml", "build"], ["ci.yml", "docs"]] as const) {
      const job = workflow(file).jobs[id] as Job;
      const runs = runsOf(job).filter((text) => text !== "");
      expect(runs).toEqual(["pnpm install --frozen-lockfile", "pnpm run docs:build"]);
    }
  });
});

describe("outside services", () => {
  const ci = workflow("ci.yml");

  it("pull the judge image by the digest the code pins, after a login when the secrets exist, and retry", () => {
    const check = ci.jobs["check"] as Job;
    const pull = check.steps.findIndex((step) => (step.run ?? "").includes("docker pull"));
    const login = check.steps.findIndex((step) => (step.run ?? "").includes("docker login"));
    expect(login).toBeGreaterThanOrEqual(0);
    expect(login).toBeLessThan(pull);
    expect(check.steps[login]?.if).toBe("env.DOCKERHUB_USER != ''");
    expect(check.steps[login]?.run).toContain("--password-stdin");
    const text = check.steps[pull]?.run ?? "";
    expect(text).toContain(`image=${SANDBOX_IMAGE}`);
    expect(text).toContain('docker pull "$image" && exit 0');
    expect(text.match(/node:22/g)).toHaveLength(1);
  });

  it("leave the merge gate for the newest-kit probe, which runs as its own job that cannot fail the run", () => {
    const probes = Object.entries(ci.jobs).filter(([, job]) => runsOf(job).some((text) => text.includes("pack-test.sh newest")));
    expect(probes.map(([id]) => id)).toEqual(["newest-kit"]);
    expect(probes[0]?.[1]["continue-on-error"]).toBe(true);
    const packing = Object.entries(ci.jobs).filter(([, job]) => runsOf(job).some((text) => text.includes("scripts/pack-test.sh")));
    expect(packing.map(([id, job]) => [id, runsOf(job).filter((text) => text.includes("pack-test.sh"))])).toEqual([
      ["check", ["bash scripts/pack-test.sh pinned"]],
      ["newest-kit", ["bash scripts/pack-test.sh newest"]],
    ]);
  });

  it("asks the registry for the newest kit only in newest mode", () => {
    const dir = mkdtempSync(join(tmpdir(), "pack-"));
    const log = join(dir, "calls.log");
    writeFileSync(log, "");
    for (const [name, body] of Object.entries({ npm: `echo '["8.1.0"]'`, pnpm: "exit 1" })) {
      writeFileSync(join(dir, name), `#!/usr/bin/env bash\necho "${name} $*" >> "${log}"\n${body}\n`);
      chmodSync(join(dir, name), 0o755);
    }
    const pack = (args: string[]) => {
      writeFileSync(log, "");
      const result = spawnSync("bash", [join(ROOT, "scripts/pack-test.sh"), ...args], {
        encoding: "utf8",
        env: { PATH: `${dir}:${process.env["PATH"] ?? ""}`, HOME: dir },
      });
      return { code: result.status, err: result.stderr, calls: readFileSync(log, "utf8").trim().split("\n").filter((line) => line !== "") };
    };
    const pinned = pack([]);
    expect(pinned.calls.some((call) => call.startsWith("npm view"))).toBe(false);
    expect(pinned.calls[0]).toMatch(/^pnpm --filter @intent-engine\/core build/);
    expect(pack(["pinned"]).calls.some((call) => call.startsWith("npm view"))).toBe(false);
    const newest = pack(["newest"]);
    expect(newest.calls[0]).toMatch(/^npm view @solana\/kit@\S+ version --json$/);
    expect(newest.calls[1]).toMatch(/^pnpm --filter/);
    const unknown = pack(["latest"]);
    expect(unknown).toMatchObject({ code: 2, calls: [] });
    expect(unknown.err).toContain("usage: pack-test.sh [pinned|newest]");
  });
});

function repoWith(files: Record<string, string>, scripts: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "gate-"));
  mkdirSync(join(dir, "scripts"));
  for (const script of scripts) copyFileSync(join(ROOT, "scripts", script), join(dir, "scripts", script));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const git = (...args: string[]) => spawnSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  git("add", "-f", "-A");
  return dir;
}
const gate = (dir: string, script: string) => {
  const result = spawnSync("bash", [join(dir, "scripts", script)], { cwd: dir, encoding: "utf8" });
  return { code: result.status, out: result.stdout + result.stderr };
};

const BANS_BASE: Record<string, string> = Object.fromEntries(
  [
    "programs/intent_engine/src/instructions/create_intent_by_agent.rs",
    "programs/intent_engine/src/instructions/create_intent_signed.rs",
    "programs/intent_engine/src/policy.rs",
    "programs/intent_engine/src/state.rs",
  ].map((path) => [path, "const _: &[u8] = DELEGATE_SEED"]),
);

describe("the rule gates", () => {
  it("refuse a comment in every source kind and pass clean files", () => {
    for (const [path, text] of [
      ["a.mts", "// say why\nexport const a = 1;\n"],
      ["a.js", "// say why\nconst a = 1;\n"],
      ["a.cjs", "/* say why */\nconst a = 1;\n"],
      ["a.css", "/* say why */\nbody { margin: 0; }\n"],
      ["a.mjs", `export const a = 1; ${"/".repeat(2)} say why
`],
    ] as const) {
      const run = gate(repoWith({ [path]: text }, ["comments.sh"]), "comments.sh");
      expect(run.code, path).toBe(1);
      expect(run.out).toContain(`${path}:`);
    }
    const clean = repoWith({ "a.mts": "export const a = 1;\n", "a.js": "const a = 1;\n", "a.css": "body { margin: 0; }\n" }, ["comments.sh"]);
    expect(gate(clean, "comments.sh").code).toBe(0);
  });

  it("refuse a source file over the line limit and pass one at the limit", () => {
    const lines = (count: number) => "export const a = 1;\n".repeat(count);
    const over = gate(repoWith({ "big.ts": lines(511), "small.ts": lines(3) }, ["sizes.sh"]), "sizes.sh");
    expect(over.code).toBe(1);
    expect(over.out).toContain("big.ts has 511 lines, over the limit of 510");
    expect(over.out).not.toContain("small.ts");
    for (const path of ["a.mts", "a.js", "a.css"]) {
      expect(gate(repoWith({ [path]: lines(600) }, ["sizes.sh"]), "sizes.sh").code, path).toBe(1);
    }
    expect(gate(repoWith({ "edge.ts": lines(510) }, ["sizes.sh"]), "sizes.sh").code).toBe(0);
    expect(gate(repoWith({ "gen/generated/x.ts": lines(900), "types.d.ts": lines(900) }, ["sizes.sh"]), "sizes.sh").code).toBe(0);
  });

  it("run in the lint", () => {
    const lint = read("scripts/lint.sh");
    expect(lint).toContain("bash scripts/comments.sh");
    expect(lint).toContain("bash scripts/sizes.sh");
  });

  it("refuse the private tool's name in any case, as a word or a file name, in a tracked file or as a tracked file's name", () => {
    const bare = ["no", "ha"].join("");
    const name = bare + ".yaml";
    const ban = (files: Record<string, string>) => gate(repoWith({ ...BANS_BASE, ...files }, ["bans.sh"]), "bans.sh");
    const old = `add it to the \`sources:\` list of your worktree's copy of \`packages/core/${name}\`, or the hook refuses`;
    const named = ban({ "examples/jobs/x/SPEC.md": old });
    expect(named.code).toBe(1);
    expect(named.out).toContain("examples/jobs/x/SPEC.md:1:");
    for (const [path, text] of [
      ["packages/core/" + name, "sources: []\n"],
      ["packages/core/" + bare.toUpperCase() + ".YML", "sources: []\n"],
      ["notes/" + bare + ".txt", "x\n"],
      ["a.md", `see ${name.toUpperCase()} here\n`],
      ["b.md", `the ${bare[0]?.toUpperCase()}${bare.slice(1)} tool\n`],
      ["c.md", `${bare.toUpperCase()}\n`],
      ["d.md", `(${bare})\n`],
    ] as const) {
      expect(ban({ [path]: text }).code, path).toBe(1);
    }
    const legitimate = [`noHash${bare}s`, `${bare.slice(0, 2)}Hash`, `an${bare}p`, `${bare}ve`, "nohash and Nohai"];
    expect(ban({ "e.ts": legitimate.map((word) => `const ${word.replace(/\W/g, "_")} = 1;`).join("\n") + "\nconst noHash = 1;\n" }).code).toBe(0);
    const reworded = "add it to the package's source list file in your worktree, or the hook refuses";
    expect(ban({ "examples/jobs/x/SPEC.md": reworded }).code).toBe(0);
  });

  it("keep the tool's name out of the three specs and out of the ban itself", () => {
    const joined = ["no", "ha"].join("");
    expect(read("scripts/bans.sh")).not.toContain(joined);
    for (const spec of ["delivery-core-ts", "core-v4-builders", "sealed-delivery-v4"]) {
      const text = read(`examples/jobs/${spec}/SPEC.md`);
      expect(text).not.toContain(joined);
      expect(text).toContain("the package's source list file");
    }
  });
});

describe("the scripts", () => {
  it("are each named by another tracked file, and the compute-unit rebaseline by its gate and its doc", () => {
    const tracked = spawnSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).stdout.split("\n").filter((path) => path !== "");
    const others = tracked.filter((path) => !path.startsWith("examples/jobs/") && path !== "pnpm-lock.yaml" && path !== "packages/cli/test/ci-steady.test.ts" && existsSync(join(ROOT, path)));
    const texts = new Map(others.map((path) => [path, readFileSync(join(ROOT, path), "latin1")]));
    const orphans = tracked
      .filter((path) => path.startsWith("scripts/") && existsSync(join(ROOT, path)))
      .filter((path) => {
        const base = path.slice("scripts/".length);
        return ![...texts].some(([other, text]) => other !== path && text.includes(base));
      });
    expect(orphans).toEqual([]);
    expect(existsSync(join(ROOT, "scripts/compile.sh"))).toBe(false);
    expect(read("tests/svm/src/cu.rs")).toContain("run bash scripts/cu-rebaseline.sh");
    expect(read("docs/maintainers/operations.md")).toContain("`bash scripts/cu-rebaseline.sh`");
  });
});
