import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { judgeRoot, removeCopy } from "./artifact.js";
import { endedState, oomKills, removeContainer } from "./check-process.js";
import { nodeSeed, wireArgs } from "./host-judge.js";
import { type InterruptSignal, SIGNAL_EXIT } from "./judge-errors.js";
import { NODE_CASE, NODE_LAUNCHER, NODE_READY } from "./node-runner.js";
import { type Box, containerName, dockerEnv, megabytesOf, SANDBOX_NOFILE, SANDBOX_PIDS, SANDBOX_USER, shareable } from "./sandbox.js";
import { caseOutcome, containerOutcome, deadlineOf, faultOf, type Limits, type Stop } from "./verdict-model.js";
import { type CaseResult, type Cases, DIAGNOSTIC_BYTES, OUTPUT_BYTES, type Primitive, stoppedTally, type Tallied, tallied } from "./viper.js";

export const NODE_ENGINE = "node-docker";
export const NODE_ROOT = "/judge";
export const NODE_RUNNER = "runner";
export const NODE_CASE_MS = 5_000;
export const NODE_HEAP_FACTOR = 1;

export type NodeJudged = { engine: typeof NODE_ENGINE; image: string; path: string } & Tallied;
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
    SIGUSR1_FLAG,
    posix.join(NODE_ROOT, NODE_RUNNER, "launch.mjs"),
    posix.join(NODE_ROOT, NODE_RUNNER, "case.mjs"),
  ];
}

type Answer = { token: string; out: string; code: number | null; signal?: string | null; timedOut: boolean; over: boolean; failed?: string };

const ENGINE = "the plain Node engine";

export const OUT_OF_TURN = "the case wrote into the plain Node engine's own channel, out of turn";

export const TOO_LONG = "the case wrote into the plain Node engine's own channel more than it can read";

export const PROTOCOL_BROKEN = "a case broke the plain Node engine's channel, so the cases after it were not run";

export const SIGUSR1_FLAG = "--disable-sigusr1";

export const sigusr1Unsupported = (diagnostic: string): string =>
  `the Node in the plain Node image does not accept ${SIGUSR1_FLAG}, which keeps a case from opening the launcher's debugger, so no case was run; pass a --sandbox-image with Node 22.14 or later (${diagnostic})`;

export const NODE_DEADLINE = "the judgement's --timeout ran out before the plain Node engine finished every case";

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

type Staged = { root: string; mount: string; directory: string; path: string };

async function stage(source: Uint8Array, name: string): Promise<Staged> {
  const root = await judgeRoot("judge-node-", true);
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

type Conversed = { results: CaseResult[]; stop?: Stop };

function converse(args: readonly string[], name: string, staged: Staged, cases: Cases, seed: number, limits: Limits): Promise<Conversed> {
  return new Promise((done) => {
    const env = dockerEnv(process.env);
    const child = spawn("docker", args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const results: CaseResult[] = [];
    let buffered = "";
    let diagnostic = "";
    let token = "";
    let ended: Stop | undefined;
    let killing: Promise<void> = Promise.resolve();
    let settling: Promise<void> = Promise.resolve();
    let known: number | null = null;
    let ready = false;
    const left = () => cases.cases.length - results.length;
    const kill = (why: Stop) => {
      ended ??= why;
      killing = removeContainer(name, env).then(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      });
    };
    const handlers = (Object.keys(SIGNAL_EXIT) as InterruptSignal[]).map((signal) => {
      const handler = () => {
        kill(faultOf(`${signal} stopped the judge`, left()));
      };
      process.on(signal, handler);
      return [signal, handler] as const;
    });
    const timer = setTimeout(() => kill(deadlineOf(NODE_DEADLINE, left())), limits.seconds * 1000);
    const tampered = (detail: string) => {
      if (left() > 0) results.push({ verdict: "crashed", detail });
      token = "";
      kill(faultOf(PROTOCOL_BROKEN, left()));
    };
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
    const begin = async () => {
      known = await oomKills(name, env);
      if (ended === undefined) next();
    };
    const answered = (line: string) => {
      if (!ready) {
        if (line === NODE_READY) {
          ready = true;
          settling = begin();
        } else {
          kill(faultOf(`${ENGINE} wrote ${JSON.stringify(line.slice(0, 64))} before it was ready`, left()));
        }
        return;
      }
      let answer: Answer | undefined;
      try {
        answer = JSON.parse(line) as Answer;
      } catch {
        answer = undefined;
      }
      if (token === "" || answer === undefined || answer.token !== token) {
        tampered(OUT_OF_TURN);
        return;
      }
      if (typeof answer.failed === "string") {
        kill(faultOf(`${ENGINE} could not start a case: ${answer.failed.slice(0, 256)}`, left()));
        return;
      }
      const sent = token;
      token = "";
      settling = settle(answer, sent);
    };
    const settle = async (answer: Answer, sent: string) => {
      const verdict = caseVerdict(answer, sent, cases.cases[results.length]?.expected ?? null);
      const end = { signal: answer.signal ?? null, stoppedByJudge: answer.timedOut || answer.over };
      const counted = verdict.verdict !== "pass" && end.signal === "SIGKILL" && !end.stoppedByJudge;
      const before = known;
      if (counted) known = await oomKills(name, env);
      if (ended !== undefined) return;
      const oomKilled = !counted || before === null || known === null ? null : known - before;
      const memory = counted ? caseOutcome({ ...end, oomKills: oomKilled }, limits) : undefined;
      if (memory?.outcome === "infra") {
        kill(faultOf(memory.reason, left()));
        return;
      }
      results.push(memory?.outcome === "fail" ? { verdict: "crashed", detail: memory.reason } : verdict);
      next();
    };
    const ranOut = async (exitCode: number | null): Promise<Stop> => {
      if (!ready && diagnostic.includes(SIGUSR1_FLAG)) return faultOf(sigusr1Unsupported(diagnostic.trim().slice(0, 256)), left());
      const inspected = await endedState(name, env);
      const ruled = inspected.state === null ? undefined : containerOutcome({ deadline: false, state: inspected.state }, limits);
      return faultOf(ruled?.outcome === "infra" ? ruled.reason : `${ENGINE} ended with exit code ${exitCode} before it answered every case: ${diagnostic.trim().slice(0, 256)}`, left());
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
      if (buffered.length > LINE_BYTES && ended === undefined) tampered(TOO_LONG);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (diagnostic.length < DIAGNOSTIC_BYTES) diagnostic += chunk.slice(0, DIAGNOSTIC_BYTES - diagnostic.length);
    });
    child.stdin.on("error", () => undefined);
    const finish = (exitCode: number | null) => {
      clearTimeout(timer);
      void settling.then(() => killing).finally(async () => {
        for (const [signal, handler] of handlers) process.removeListener(signal, handler);
        const stop = left() === 0 ? undefined : (ended ?? (await ranOut(exitCode)));
        done(stop === undefined ? { results } : { results, stop: { ...stop, unfinished: left() } });
      });
    };
    child.once("error", (error) => {
      diagnostic = error.message;
      finish(null);
    });
    child.once("close", finish);
    send({ seed: nodeSeed(seed), heapMb: NODE_HEAP_FACTOR * megabytesOf(limits.memory), caseMs: NODE_CASE_MS, outputBytes: OUTPUT_BYTES, path: staged.path });
  });
}

export async function judgeNode(box: Box, source: Uint8Array, name: string, cases: Cases, seed: number, timeoutSeconds: number): Promise<NodeRun> {
  const total = cases.cases.length;
  const stopped = (path: string, stop: Stop): NodeRun => ({ judged: { engine: NODE_ENGINE, image: box.image, path, ...stoppedTally(total, stop) }, cleanup: undefined });
  if (timeoutSeconds <= 0) {
    return stopped("", deadlineOf(NODE_DEADLINE, total));
  }
  let staged: Staged;
  try {
    staged = await stage(source, name);
  } catch (error) {
    return stopped("", faultOf(`${ENGINE} could not stage the delivery: ${error instanceof Error ? error.message : String(error)}`, total));
  }
  const container = containerName();
  let conversed: Conversed = { results: [] };
  let cleanup: string | undefined;
  try {
    conversed = await converse(nodeArgs(box, container, staged.mount, staged.directory), container, staged, cases, seed, { seconds: timeoutSeconds, memory: box.memory });
  } finally {
    await removeContainer(container, dockerEnv(process.env));
    cleanup = await removeCopy(staged.root);
  }
  return { judged: { engine: NODE_ENGINE, image: box.image, path: staged.path, ...tallied(conversed.results, total, conversed.stop) }, cleanup };
}
