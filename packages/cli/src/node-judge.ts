import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { removeCopy } from "./artifact.js";
import { removeContainer } from "./check-process.js";
import { nodeSeed, wireArgs } from "./host-judge.js";
import { type InterruptSignal, SIGNAL_EXIT } from "./judge-errors.js";
import { NODE_CASE, NODE_LAUNCHER } from "./node-runner.js";
import { type Box, containerName, dockerEnv, SANDBOX_NOFILE, SANDBOX_PIDS, SANDBOX_USER, shareable } from "./sandbox.js";
import { type CaseResult, type Cases, DIAGNOSTIC_BYTES, type Failure, OUTPUT_BYTES, type Primitive, REPORTED_FAILURES, stoppedAll } from "./viper.js";

export const NODE_ENGINE = "node-docker";
export const NODE_ROOT = "/judge";
export const NODE_RUNNER = "runner";
export const NODE_CASE_MS = 5_000;

export type NodeJudged = { engine: typeof NODE_ENGINE; image: string; path: string; total: number; passed: number; failures: Failure[] };
export type NodeRun = { judged: NodeJudged; cleanup: string | undefined };

const SEARCHABLE = 0o755;
const LINE_BYTES = 2 * OUTPUT_BYTES;

export const moduleName = (name: string): string => (name.endsWith(".mjs") ? name : `${name.replace(/\.[^.]*$/, "") || "delivery"}.mjs`);

export function nodeArgs(box: Box, name: string, source: string, directory: string): string[] {
  return [
    "run",
    "-i",
    "--name",
    name,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--user",
    SANDBOX_USER,
    "--pids-limit",
    String(SANDBOX_PIDS),
    "--memory",
    box.memory,
    "--memory-swap",
    box.memory,
    "--cpus",
    box.cpus,
    "--ipc",
    "none",
    "--cgroupns",
    "private",
    "--log-driver",
    "none",
    "--ulimit",
    `nofile=${SANDBOX_NOFILE}:${SANDBOX_NOFILE}`,
    "--ulimit",
    "core=0",
    "--mount",
    "type=tmpfs,target=/dev/mqueue,readonly",
    "--mount",
    `type=bind,source=${source},target=${NODE_ROOT},readonly`,
    "--workdir",
    directory,
    "--entrypoint",
    "node",
    box.image,
    posix.join(NODE_ROOT, NODE_RUNNER, "launch.mjs"),
    posix.join(NODE_ROOT, NODE_RUNNER, "case.mjs"),
  ];
}

type Answer = { token: string; out: string; code: number | null; timedOut: boolean; over: boolean };

const same = (a: Primitive, b: Primitive) => a === b || (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b));

function valueOf(kind: unknown, value: unknown): { ok: true; value: Primitive } | { ok: false } {
  if (kind === "string" && typeof value === "string") return { ok: true, value };
  if (kind === "number" && typeof value === "string") return { ok: true, value: Number(value) };
  if (kind === "boolean" && (value === "true" || value === "false")) return { ok: true, value: value === "true" };
  if (kind === "null" && value === null) return { ok: true, value: null };
  return { ok: false };
}

export function caseVerdict(answer: Answer, token: string, expected: Primitive): CaseResult {
  if (answer.over) return { verdict: "crashed", detail: `the case wrote more than ${OUTPUT_BYTES} bytes` };
  if (answer.timedOut) return { verdict: "stopped", detail: `the case gave no answer within ${NODE_CASE_MS} ms` };
  const parts = Buffer.from(answer.out, "base64").toString("utf8").split(token);
  if (parts.length !== 3) {
    return { verdict: "crashed", detail: parts.length < 3 ? "the case wrote no answer framed by its token" : "the case wrote more than one answer framed by its token" };
  }
  let body: unknown;
  try {
    body = JSON.parse(parts[1] ?? "");
  } catch {
    return { verdict: "crashed", detail: "the case wrote a framed answer that is not JSON" };
  }
  if (!Array.isArray(body) || body.length !== 3) return { verdict: "crashed", detail: "the case wrote a framed answer of the wrong shape" };
  const [verdict, kind, value] = body as [unknown, unknown, unknown];
  if (verdict === "not-primitive") return { verdict: "not-primitive" };
  if (verdict === "threw" || verdict === "no-module") return { verdict, detail: String(value).slice(0, 256) };
  const got = verdict === "answer" ? valueOf(kind, value) : { ok: false as const };
  if (!got.ok) return { verdict: "crashed", detail: "the case wrote a framed answer the judge does not know" };
  return same(got.value, expected) ? { verdict: "pass" } : { verdict: "wrong", detail: got.value };
}

function summarized(results: CaseResult[], image: string, path: string): NodeJudged {
  const failures = results.flatMap((result, index) => (result.verdict === "pass" ? [] : [{ case: index, ...result }]));
  return { engine: NODE_ENGINE, image, path, total: results.length, passed: results.length - failures.length, failures: failures.slice(0, REPORTED_FAILURES) };
}

type Staged = { root: string; mount: string; directory: string; path: string };

async function stage(source: Uint8Array, name: string): Promise<Staged> {
  const root = await mkdtemp(join(tmpdir(), "judge-node-"));
  const mount = join(root, "judge");
  const random = randomBytes(16).toString("hex");
  const file = moduleName(name);
  try {
    await mkdir(join(mount, NODE_RUNNER), { recursive: true });
    await mkdir(join(mount, random));
    await writeFile(join(mount, NODE_RUNNER, "launch.mjs"), NODE_LAUNCHER);
    await writeFile(join(mount, NODE_RUNNER, "case.mjs"), NODE_CASE);
    await writeFile(join(mount, random, file), source);
    await chmod(mount, SEARCHABLE);
    await shareable(mount);
  } catch (error) {
    await removeCopy(root);
    throw error;
  }
  return { root, mount, directory: posix.join(NODE_ROOT, random), path: posix.join(NODE_ROOT, random, file) };
}

function converse(args: readonly string[], name: string, staged: Staged, cases: Cases, seed: number, timeoutSeconds: number): Promise<CaseResult[]> {
  return new Promise((done) => {
    const env = dockerEnv(process.env);
    const child = spawn("docker", args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const results: CaseResult[] = [];
    let buffered = "";
    let diagnostic = "";
    let token = "";
    let ended: CaseResult | undefined;
    let killing: Promise<void> = Promise.resolve();
    const kill = (why: CaseResult) => {
      ended ??= why;
      killing = removeContainer(name, env).then(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      });
    };
    const handlers = (Object.keys(SIGNAL_EXIT) as InterruptSignal[]).map((signal) => {
      const handler = () => {
        kill({ verdict: "stopped", detail: `${signal} stopped the judge` });
      };
      process.on(signal, handler);
      return [signal, handler] as const;
    });
    const timer = setTimeout(() => kill({ verdict: "stopped", detail: "the judgement's --timeout ran out before this case finished" }), timeoutSeconds * 1000);
    const send = (message: unknown) => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const next = () => {
      if (results.length === cases.cases.length) {
        child.stdin.end();
        return;
      }
      token = randomBytes(32).toString("hex");
      send({ token, ...wireArgs(cases.cases[results.length]?.args ?? []) });
    };
    const answered = (line: string) => {
      let answer: Answer | undefined;
      try {
        answer = JSON.parse(line) as Answer;
      } catch {
        answer = undefined;
      }
      if (token === "" || answer === undefined || answer.token !== token) {
        kill({ verdict: "crashed", detail: "the plain Node engine answered out of turn" });
        return;
      }
      results.push(caseVerdict(answer, token, cases.cases[results.length]?.expected ?? null));
      token = "";
      next();
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffered += chunk;
      let at = buffered.indexOf("\n");
      while (at >= 0 && ended === undefined) {
        const line = buffered.slice(0, at);
        buffered = buffered.slice(at + 1);
        answered(line);
        at = buffered.indexOf("\n");
      }
      if (buffered.length > LINE_BYTES) kill({ verdict: "crashed", detail: "the plain Node engine wrote an answer too long to read" });
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (diagnostic.length < DIAGNOSTIC_BYTES) diagnostic += chunk.slice(0, DIAGNOSTIC_BYTES - diagnostic.length);
    });
    child.stdin.on("error", () => undefined);
    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      void killing.finally(() => {
        for (const [signal, handler] of handlers) process.removeListener(signal, handler);
        const rest = ended ?? { verdict: "crashed", detail: `the plain Node engine ended with exit code ${exitCode}: ${diagnostic.trim().slice(0, 256)}` };
        while (results.length < cases.cases.length) results.push(rest);
        done(results);
      });
    };
    child.once("error", (error) => {
      diagnostic = error.message;
      finish(null);
    });
    child.once("close", finish);
    send({ seed: nodeSeed(seed), caseMs: NODE_CASE_MS, outputBytes: OUTPUT_BYTES, path: staged.path });
    next();
  });
}

export async function judgeNode(box: Box, source: Uint8Array, name: string, cases: Cases, seed: number, timeoutSeconds: number): Promise<NodeRun> {
  if (timeoutSeconds <= 0) {
    const stopped = stoppedAll(cases.cases.length, "the judgement's --timeout ran out before the plain Node engine started");
    return { judged: { engine: NODE_ENGINE, image: box.image, path: "", ...stopped }, cleanup: undefined };
  }
  const staged = await stage(source, name);
  const container = containerName();
  let results: CaseResult[] = [];
  let cleanup: string | undefined;
  try {
    results = await converse(nodeArgs(box, container, staged.mount, staged.directory), container, staged, cases, seed, timeoutSeconds);
  } finally {
    await removeContainer(container, dockerEnv(process.env));
    cleanup = await removeCopy(staged.root);
  }
  return { judged: summarized(results, box.image, staged.path), cleanup };
}
