import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { judgeRoot, removeCopy } from "./artifact.js";
import { endedState, MEMORY_EVENTS, MEMORY_PROCS, removeContainer } from "./check-process.js";
import { nodeSeed, wireArgs } from "./host-judge.js";
import { type InterruptSignal, JudgeRefused, SIGNAL_EXIT } from "./judge-errors.js";
import { CASE_OOM_SCORE, NODE_CASE, NODE_LAUNCHER, NODE_READY, NODE_UNCOUNTED, NODE_UNLOCKED, NODE_UNMETERED, NODE_UNPROBED, UNPREPARED } from "./node-runner.js";
import { type Box, containerName, dockerEnv, megabytesOf, SANDBOX_NOFILE, SANDBOX_PIDS, SANDBOX_USER, shareable } from "./sandbox.js";
import { type CaseClock, caseMemory, caseTiming, caseUnsettled, containerOutcome, deadlineOf, ENGINE_FAULT, faultOf, type Limits, type MemoryRise, pinnedLauncherEnd, ranPastBudget, type Stop, starvedCase, type Timing } from "./verdict-model.js";
import { type CaseResult, type Cases, DIAGNOSTIC_BYTES, OUTPUT_BYTES, type Primitive, stoppedTally, type Tallied, tallied } from "./viper.js";

export const NODE_ENGINE = "node-docker";
export const NODE_ROOT = "/judge";
export const NODE_RUNNER = "runner";
export const NODE_CASE_MS = 5_000;
export const NODE_SAMPLE_MS = 10;
export const NODE_BOOT_MS = 2_000;
export const CLOCK_TICKS = 100;
export const NODE_SETTLE_MS = 2_000;
export const NODE_HEAP_FACTOR = 1;
export const NODE_LAUNCHER_USER = "0:0";
export const NODE_CAPABILITIES = ["SETUID", "SETGID", "KILL", "SYS_RESOURCE"] as const;
export const NODE_SYSCTLS = ["kernel.shmmni=0", "kernel.msgmni=0", "kernel.sem=0 0 0 0", "fs.mqueue.queues_max=0"] as const;

export type NodeJudged = { engine: typeof NODE_ENGINE; image: string; path: string } & Tallied;
export type NodeRun = { judged: NodeJudged; cleanup: string | undefined };

const SEARCHABLE = 0o755;
const [CASE_UID, CASE_GID] = SANDBOX_USER.split(":").map(Number);
const LINE_BYTES = 2 * OUTPUT_BYTES;

export const nodeBudgetMs = (cases: Cases): number => cases.caseMs ?? NODE_CASE_MS;

export const nodeBackstopMs = (budgetMs: number, cpus: string): number => {
  const share = Number(cpus);
  return Math.ceil(NODE_BOOT_MS / share + 2 * budgetMs * (2 + 1 / share));
};

export const moduleName = (name: string): string => (name.endsWith(".mjs") ? name : `${name.replace(/\.[^.]*$/, "") || "delivery"}.mjs`);

export function nodeArgs(box: Box, name: string, source: string, directory: string): string[] {
  return [
    "run",
    "-i",
    "--init",
    "--name",
    name,
    "--network",
    "none",
    "--read-only",
    "--cap-drop",
    "ALL",
    ...NODE_CAPABILITIES.flatMap((capability) => ["--cap-add", capability]),
    "--security-opt",
    "no-new-privileges",
    "--user",
    NODE_LAUNCHER_USER,
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
    ...NODE_SYSCTLS.flatMap((sysctl) => ["--sysctl", sysctl]),
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

type Answer = { token: string; out: string; code: number | null; signal?: string | null; timedOut: boolean; over: boolean; failed?: string; oomBefore?: unknown; oomAfter?: unknown; settled?: unknown; clock?: unknown };

const STOPPERS: readonly unknown[] = [null, "budget", "backstop"];

const spanOf = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null);

export function clockOf(value: unknown): (CaseClock & { metered: boolean }) | null {
  if (value === null || typeof value !== "object") return null;
  const { started, metered, usedMs, idleMs, stoppedBy } = value as Record<string, unknown>;
  const used = spanOf(usedMs);
  const idle = spanOf(idleMs);
  if (typeof started !== "boolean" || typeof metered !== "boolean" || used === null || idle === null || !STOPPERS.includes(stoppedBy)) return null;
  return { started, metered, usedMs: used, idleMs: idle, stoppedBy: stoppedBy as CaseClock["stoppedBy"] };
}

const countOf = (value: unknown): number | null => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null);

const eventsOf = (value: unknown): MemoryRise | null => {
  if (value === null || typeof value !== "object") return null;
  const { oom, oomKill } = value as Record<string, unknown>;
  const counted = { oom: countOf(oom), oomKill: countOf(oomKill) };
  return counted.oom === null || counted.oomKill === null ? null : { oom: counted.oom, oomKill: counted.oomKill };
};

export function riseOf(before: unknown, after: unknown): MemoryRise | null {
  const first = eventsOf(before);
  const last = eventsOf(after);
  if (first === null || last === null || last.oom < first.oom || last.oomKill < first.oomKill) return null;
  return { oom: last.oom - first.oom, oomKill: last.oomKill - first.oomKill };
}

const ENGINE = "the plain Node engine";

export const OUT_OF_TURN = "the case wrote into the plain Node engine's own channel, out of turn";

export const TOO_LONG = "the case wrote into the plain Node engine's own channel more than it can read";

export const PROTOCOL_BROKEN = "a case broke the plain Node engine's channel, so the cases after it were not run";

export const SIGUSR1_FLAG = "--disable-sigusr1";

export const sigusr1Unsupported = (diagnostic: string): string =>
  `the Node in the plain Node image does not accept ${SIGUSR1_FLAG}, which keeps a case from opening the launcher's debugger, so no case was run; pass a --sandbox-image with Node 22.14 or later (${diagnostic})`;

export const memoryUncounted = (memory: string): string =>
  `the spec's judge-cases block pins node_memory ${memory}, and the plain Node launcher cannot read the out-of-memory count in ${MEMORY_EVENTS} that a cgroup v2 host gives each container, so a case killed for memory could not fail as the pin says; judge it on a host where sandbox doctor reports memory_pin true; no plain Node case was run and nothing was paid`;

export const memoryUnlocked = (memory: string): string =>
  `the spec's judge-cases block pins node_memory ${memory}, and in this host's containers a plain Node case could lower its out-of-memory score below ${CASE_OOM_SCORE}, so the kernel could kill the launcher instead of the case and a case killed for memory could not fail as the pin says; judge it on a host whose Docker runs as root; no plain Node case was run and nothing was paid`;

export const NODE_DEADLINE = "the judgement's --timeout ran out before the plain Node engine finished every case";

export const nodeUnmetered = "the plain Node launcher cannot read the CPU time and states of its cases' processes in /proc, so a case's budget could be measured only on the judge's wall clock, which the judge's CPU share and load decide; judge it on a host whose containers mount /proc; no plain Node case was run and nothing was paid";

export const CASE_UNMETERED = "the plain Node launcher could not read a case's CPU time in /proc, so whether the case kept to its budget is unknown, and this is no verdict on the work";

export const probeUnfinished = (probeMs: number): string =>
  `the plain Node launcher's probe case, which runs no delivery, did not finish within its ${probeMs} ms wall-clock backstop on this host, so whether a case could lower its out-of-memory score is unknown, and this is no verdict on the work`;

const same = (a: Primitive, b: Primitive) => a === b || (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b));

function valueOf(kind: unknown, value: unknown): { ok: true; value: Primitive } | { ok: false } {
  if (kind === "string" && typeof value === "string") return { ok: true, value };
  if (kind === "number" && typeof value === "string") return { ok: true, value: Number(value) };
  if (kind === "boolean" && (value === "true" || value === "false")) return { ok: true, value: value === "true" };
  if (kind === "null" && value === null) return { ok: true, value: null };
  return { ok: false };
}

export function caseVerdict(answer: Answer, token: string, expected: Primitive, timing: Timing, budgetMs: number): CaseResult {
  if (answer.over) return { verdict: "crashed", detail: `the case wrote more than ${OUTPUT_BYTES} bytes` };
  if (timing === "over") return { verdict: "stopped", detail: ranPastBudget(budgetMs) };
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
  if (verdict === UNPREPARED) return { verdict: ENGINE_FAULT, detail: `${ENGINE} could not prepare a case: ${String(value).slice(0, 256)}` };
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

type Conversed = { results: CaseResult[]; stop?: Stop; refused?: string };

function converse(args: readonly string[], name: string, staged: Staged, cases: Cases, seed: number, limits: Limits, cpus: string): Promise<Conversed> {
  const budgetMs = nodeBudgetMs(cases);
  const backstopMs = nodeBackstopMs(budgetMs, cpus);
  return new Promise((done) => {
    const env = dockerEnv(process.env);
    const child = spawn("docker", args, { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const results: CaseResult[] = [];
    let buffered = "";
    let diagnostic = "";
    let token = "";
    let ended: Stop | undefined;
    let killing: Promise<void> = Promise.resolve();
    let unsettled = false;
    let ready = false;
    let refused: string | undefined;
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
    const answered = (line: string) => {
      if (!ready) {
        if (line === NODE_READY) {
          ready = true;
          next();
        } else if (line === NODE_UNMETERED) {
          refused = nodeUnmetered;
          kill(faultOf(refused, left()));
        } else if (line === NODE_UNPROBED && limits.pinned?.memory !== undefined) {
          kill(faultOf(probeUnfinished(backstopMs), left()));
        } else if ((line === NODE_UNCOUNTED || line === NODE_UNLOCKED) && limits.pinned?.memory !== undefined) {
          refused = (line === NODE_UNCOUNTED ? memoryUncounted : memoryUnlocked)(limits.pinned.memory);
          kill(faultOf(refused, left()));
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
      settle(answer, sent);
    };
    const settle = (answer: Answer, sent: string) => {
      const clock = clockOf(answer.clock);
      if (clock === null || !clock.metered) {
        kill(faultOf(CASE_UNMETERED, left()));
        return;
      }
      const timing = caseTiming(clock, budgetMs);
      if (!answer.over && timing === "starved") {
        kill(faultOf(starvedCase(ENGINE, budgetMs, backstopMs), left()));
        return;
      }
      const verdict = caseVerdict(answer, sent, cases.cases[results.length]?.expected ?? null, timing, budgetMs);
      const end = { signal: answer.signal ?? null, stoppedByJudge: answer.timedOut || answer.over, rise: riseOf(answer.oomBefore, answer.oomAfter) };
      const blurred = unsettled;
      unsettled = answer.settled === false;
      const charged = caseMemory(end, verdict.verdict === "pass", limits);
      const pinned = limits.pinned?.memory;
      const memory = blurred && pinned !== undefined && charged?.outcome === "fail" ? { outcome: "infra" as const, reason: caseUnsettled(pinned) } : charged;
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
      const pinned = limits.pinned?.memory;
      const state = inspected.state;
      const launcher = pinned === undefined || state === null ? undefined : pinnedLauncherEnd(state, pinned);
      if (launcher !== undefined && launcher.outcome !== "pass") {
        return faultOf(launcher.reason, left());
      }
      const ruled = inspected.state === null ? undefined : containerOutcome({ deadline: false, state: inspected.state }, { seconds: limits.seconds, memory: limits.memory });
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
      void killing.finally(async () => {
        for (const [signal, handler] of handlers) process.removeListener(signal, handler);
        const stop = left() === 0 ? undefined : (ended ?? (await ranOut(exitCode)));
        const counted = refused === undefined ? {} : { refused };
        done(stop === undefined ? { results, ...counted } : { results, stop: { ...stop, unfinished: left() }, ...counted });
      });
    };
    child.once("error", (error) => {
      diagnostic = error.message;
      finish(null);
    });
    child.once("close", finish);
    send({ seed: nodeSeed(seed), heapMb: NODE_HEAP_FACTOR * megabytesOf(limits.memory), caseMs: budgetMs, backstopMs, probeMs: backstopMs, sampleMs: NODE_SAMPLE_MS, clockTicks: CLOCK_TICKS, outputBytes: OUTPUT_BYTES, path: staged.path, uid: CASE_UID, gid: CASE_GID, events: MEMORY_EVENTS, procs: MEMORY_PROCS, settleMs: NODE_SETTLE_MS, pinned: limits.pinned?.memory !== undefined });
  });
}

export async function judgeNode(given: Box, source: Uint8Array, name: string, cases: Cases, seed: number, timeoutSeconds: number): Promise<NodeRun> {
  const box = { ...given, ...(cases.nodeMemory === undefined ? {} : { memory: cases.nodeMemory }), ...(cases.nodeCpus === undefined ? {} : { cpus: cases.nodeCpus }) };
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
    conversed = await converse(nodeArgs(box, container, staged.mount, staged.directory), container, staged, cases, seed, { seconds: timeoutSeconds, memory: box.memory, ...(cases.nodeMemory === undefined ? {} : { pinned: { seconds: timeoutSeconds, memory: cases.nodeMemory } }) }, box.cpus);
  } finally {
    await removeContainer(container, dockerEnv(process.env));
    cleanup = await removeCopy(staged.root);
  }
  if (conversed.refused !== undefined) {
    throw new JudgeRefused(cleanup === undefined ? conversed.refused : `${conversed.refused}; ${cleanup}`);
  }
  return { judged: { engine: NODE_ENGINE, image: box.image, path: staged.path, ...tallied(conversed.results, total, conversed.stop) }, cleanup };
}

export async function memoryPinHeld(given: Box, memory: string | undefined, timeoutSeconds: number): Promise<void> {
  if (memory === undefined) {
    return;
  }
  await nodeHostHeld(given, memory, timeoutSeconds);
}

export async function nodeHostHeld(given: Box, memory: string | undefined, timeoutSeconds: number): Promise<void> {
  const { cleanup } = await judgeNode(given, new Uint8Array(), "probe.mjs", { steps: 0, heap: 0, seed: undefined, clock: undefined, cases: [], ...(memory === undefined ? {} : { nodeMemory: memory }) }, 0, timeoutSeconds);
  if (cleanup !== undefined) {
    process.stderr.write(`warning: ${cleanup}\n`);
  }
}
