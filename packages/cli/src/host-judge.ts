import { spawn } from "node:child_process";
import { caseTiming, contendedCase, deadlineOf, failedOf, faultOf, ranPastBudget, type Stop, starvedCase } from "./verdict-model.js";
import { type CaseResult, type Cases, deadlineMissed, DIAGNOSTIC_BYTES, moduleText, OUTPUT_BYTES, permissionFlag, type Primitive, runOf, stoppedTally, type Tallied, tallied } from "./viper.js";

export const HOST_ENGINE = "node-vm";
export const HOST_CALL_MS = 2_000;
export const HOST_BACKSTOP_FACTOR = 5;
export const hostDetail = (cases: number): number => Math.max(16, Math.floor(OUTPUT_BYTES / (8 * Math.max(1, cases))));
export const HOST_VERDICTS: readonly string[] = ["pass", "wrong", "not-primitive", "threw", "stopped", "no-module"];
export const V8_SEEDS = 2_147_483_647;
export const UNBLOCKABLE_EXIT = 71;

export const nodeSeed = (seed: number): number => 1 + (seed % V8_SEEDS);

export const hostBudgetMs = (cases: Cases): number => cases.caseMs ?? HOST_CALL_MS;

export const hostBackstopMs = (budgetMs: number): number => budgetMs * HOST_BACKSTOP_FACTOR;

export type HostJudged = { engine: typeof HOST_ENGINE } & Tallied;
export type WireArgs = { json: string; zeros: number[] };
export type HostAnswer = CaseResult & { usedMs: number; otherShare: number };

export const wireArgs = (args: readonly Primitive[]): WireArgs => ({ json: JSON.stringify(args), zeros: args.flatMap((arg, at) => (Object.is(arg, -0) ? [at] : [])) });

export const HOST_RUNNER = `
import vm from "node:vm";
import { writeSync } from "node:fs";
import { cpus } from "node:os";
import { types } from "node:util";
process.on("unhandledRejection", () => undefined);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const { source, cases, budgetMs, backstopMs, detail } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const said = Math.min(256, detail);
const cpuNow = process.cpuUsage.bind(process);
const used = (from) => {
  const at = cpuNow(from);
  return (at.user + at.system) / 1000;
};
const hostBusy = () => {
  const all = cpus();
  return { busy: all.reduce((sum, one) => sum + one.times.user + one.times.nice + one.times.sys + one.times.irq, 0), count: all.length, at: performance.now() };
};
const others = (host, usedMs) => {
  const now = hostBusy();
  const wall = now.at - host.at;
  return wall > 0 && now.count > 0 ? Math.max(0, now.busy - host.busy - usedMs) / (wall * now.count) : 0;
};
const write = (results) => {
  const bytes = Buffer.from(JSON.stringify(results), "utf8");
  let at = 0;
  while (at < bytes.length) {
    try {
      at += writeSync(1, bytes, at, bytes.length - at);
    } catch (error) {
      if (!error || error.code !== "EAGAIN") return false;
    }
  }
  return true;
};
const out = (results) => process.exit(write(results) ? 0 : 70);
const all = (verdict, detail, usedMs, otherShare) => out(cases.map(() => (detail === undefined ? { verdict, usedMs, otherShare } : { verdict, detail, usedMs, otherShare })));
const context = vm.createContext(vm.constants.DONT_CONTEXTIFY, { codeGeneration: { strings: false, wasm: false }, microtaskMode: "afterEvaluate" });
if (vm.runInContext("Reflect.deleteProperty(Atomics, 'wait') && typeof Atomics.wait === 'undefined'", context) !== true) process.exit(${UNBLOCKABLE_EXIT});
const put = (name, value) => {
  try {
    Object.defineProperty(context, name, { value, writable: true, configurable: true, enumerable: false });
    return true;
  } catch {
    return false;
  }
};
const describer = vm.runInContext(
  "(() => { const own = globalThis; const drop = Reflect.deleteProperty; return () => { const error = own.__error; drop(own, '__error'); drop(own, '__describe'); try { const text = String(error && error.message ? error.message : error); return typeof text === 'string' ? text : 'a value that is not an Error'; } catch { return 'a value that is not an Error'; } }; })()",
  context,
  { displayErrors: false },
);
const timedOut = (error) => types.isNativeError(error) && Object.getOwnPropertyDescriptor(error, "code")?.value === "ERR_SCRIPT_EXECUTION_TIMEOUT";
const describe = (error) => {
  if (!put("__error", error) || !put("__describe", describer)) return "a value that is not an Error";
  try {
    const text = vm.runInContext("__describe()", context, { timeout: backstopMs, displayErrors: false });
    return typeof text === "string" ? text.slice(0, said) : "a value that is not an Error";
  } catch (failed) {
    return timedOut(failed) ? null : "a value that is not an Error";
  }
};
const failed = (error) => {
  if (timedOut(error)) return { verdict: "stopped" };
  const text = describe(error);
  return text === null ? { verdict: "stopped" } : { verdict: "threw", detail: text };
};
const host = vm.runInContext(
  "(() => { const parse = JSON.parse; const apply = Reflect.apply; const drop = Reflect.deleteProperty; const own = globalThis; let delivered; return { give: (fn) => { delivered = fn; }, call: (json, zeros) => { drop(own, '__call'); drop(own, '__json'); const args = parse(json); for (let at = 0; at < zeros.length; at += 1) args[zeros[at]] = -0; return apply(delivered, undefined, args); } }; })()",
  context,
);
const give = host.give;
const call = host.call;
let fn;
let loading = true;
const loadFrom = cpuNow();
const loadHost = hostBusy();
try {
  const module = new vm.SourceTextModule(source, { context, identifier: "delivery.mjs" });
  await module.link(() => {
    throw new Error("the delivery imports a module");
  });
  process.once("beforeExit", () => {
    if (loading) all("no-module", "the module's top-level code never finished loading", used(loadFrom), others(loadHost, used(loadFrom)));
  });
  await module.evaluate({ timeout: backstopMs });
  loading = false;
  fn = module.namespace.default;
} catch (error) {
  loading = false;
  const ended = failed(error);
  all(ended.verdict === "stopped" ? "stopped" : "no-module", ended.verdict === "stopped" ? undefined : ended.detail, used(loadFrom), others(loadHost, used(loadFrom)));
}
const loadMs = used(loadFrom);
const loadOthers = others(loadHost, loadMs);
if (loadMs >= budgetMs) all("stopped", undefined, loadMs, loadOthers);
if (typeof fn !== "function") {
  all("no-module", "the delivery has no default export function", loadMs, loadOthers);
}
give(fn);
const primitive = (v) => v === null || typeof v === "boolean" || typeof v === "number" || typeof v === "string";
const same = (a, b) => a === b || (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b));
const judgeOne = (c) => {
  if (!put("__call", call) || !put("__json", c.json)) return { verdict: "threw", detail: "the delivery locked the judge out of its global object" };
  let got;
  try {
    got = vm.runInContext("__call(__json, " + JSON.stringify(c.zeros) + ")", context, { timeout: backstopMs, displayErrors: false });
  } catch (error) {
    return failed(error);
  }
  if (!primitive(got)) return { verdict: "not-primitive" };
  return same(got, c.expected) ? { verdict: "pass" } : { verdict: "wrong", detail: typeof got === "string" ? got.slice(0, detail) : got };
};
const results = [];
for (const c of cases) {
  const from = cpuNow();
  const host = hostBusy();
  const result = judgeOne(c);
  const usedMs = used(from);
  results.push({ ...result, usedMs, otherShare: others(host, usedMs) });
  if (result.verdict === "stopped" || usedMs >= budgetMs) break;
}
out(results);
`;

type HostRan = { output: string; exitCode: number | null; timedOut: boolean; diagnostic: string };

export const hostArgs = (seed: number): string[] => [permissionFlag(), `--random-seed=${nodeSeed(seed)}`, "--experimental-vm-modules", "--no-warnings", "--input-type=module", "-e", HOST_RUNNER];

function runHost(input: string, timeoutSeconds: number, seed: number): Promise<HostRan> {
  return new Promise((done) => {
    const child = spawn(process.execPath, hostArgs(seed), {
      env: {},
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let output = "";
    let diagnostic = "";
    let timedOut = false;
    let over = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutSeconds * 1000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (output.length + chunk.length > OUTPUT_BYTES) {
        over = true;
        child.kill("SIGKILL");
        return;
      }
      output += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (diagnostic.length < DIAGNOSTIC_BYTES) diagnostic += chunk.toString("utf8").slice(0, DIAGNOSTIC_BYTES - diagnostic.length);
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
    child.once("error", (error) => {
      clearTimeout(timer);
      done({ output: "", exitCode: null, timedOut, diagnostic: error.message });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      done({ output: over ? "" : output, exitCode: over ? null : code, timedOut, diagnostic });
    });
  });
}

const HOST = "the host engine";

export const hostAfterFail = (index: number): string => `${HOST} ran no case after case ${index} used its budget, since the work had already failed`;

const stoppedHost = (total: number, stop: Stop): HostJudged => ({ engine: HOST_ENGINE, ...stoppedTally(total, stop) });

const readable = (result: unknown): result is HostAnswer =>
  typeof result === "object" &&
  result !== null &&
  HOST_VERDICTS.includes((result as { verdict?: unknown }).verdict as string) &&
  typeof (result as { usedMs?: unknown }).usedMs === "number" &&
  Number.isFinite((result as { usedMs: number }).usedMs) &&
  typeof (result as { otherShare?: unknown }).otherShare === "number" &&
  Number.isFinite((result as { otherShare: number }).otherShare);

export function hostTally(answers: readonly HostAnswer[], total: number, budgetMs: number): HostJudged {
  const backstopMs = hostBackstopMs(budgetMs);
  const results: CaseResult[] = [];
  for (const [index, answer] of answers.entries()) {
    const timing = caseTiming({ started: true, usedMs: answer.usedMs, idleMs: 0, ioMs: 0, otherShare: answer.otherShare, stoppedBy: answer.verdict === "stopped" ? "backstop" : null }, budgetMs);
    if (timing === "starved") {
      return { engine: HOST_ENGINE, ...tallied(results, total, faultOf(starvedCase(HOST, budgetMs, backstopMs), total - index)) };
    }
    const result: CaseResult = answer.detail === undefined ? { verdict: answer.verdict } : { verdict: answer.verdict, detail: answer.detail };
    if (timing === "band" && result.verdict === "pass") {
      return { engine: HOST_ENGINE, ...tallied(results, total, faultOf(contendedCase(HOST, budgetMs, answer.otherShare), total - index)) };
    }
    results.push(timing === "over" || (timing === "band" && result.verdict === "stopped") ? { verdict: "stopped", detail: ranPastBudget(budgetMs) } : result);
    if ((timing === "over" || timing === "band") && index + 1 < total) {
      return { engine: HOST_ENGINE, ...tallied(results, total, failedOf(hostAfterFail(index), total - index - 1)) };
    }
  }
  return results.length === total ? { engine: HOST_ENGINE, ...tallied(results) } : stoppedHost(total, faultOf(`${HOST} judged a different number of cases`, total));
}

export async function judgeHost(source: Uint8Array, cases: Cases, timeoutSeconds: number, seed: number = runOf(cases).seed): Promise<HostJudged> {
  const text = moduleText(source);
  const total = cases.cases.length;
  if (timeoutSeconds <= 0) return stoppedHost(total, deadlineOf(deadlineMissed(HOST, timeoutSeconds), total));
  const budgetMs = hostBudgetMs(cases);
  const input = JSON.stringify({ source: text, cases: cases.cases.map((c) => ({ ...wireArgs(c.args), expected: c.expected })), budgetMs, backstopMs: hostBackstopMs(budgetMs), detail: hostDetail(total) });
  const ran = await runHost(input, timeoutSeconds, seed);
  if (ran.timedOut) return stoppedHost(total, deadlineOf(deadlineMissed(HOST, timeoutSeconds), total));
  if (ran.exitCode !== 0) {
    return stoppedHost(total, faultOf(`${HOST} ended with exit code ${ran.exitCode} and no readable verdict: ${ran.diagnostic.trim().slice(0, 256)}`, total));
  }
  let results: unknown;
  try {
    results = JSON.parse(ran.output);
  } catch {
    return stoppedHost(total, faultOf(`${HOST} wrote no readable verdict`, total));
  }
  if (!Array.isArray(results) || results.length === 0 || results.length > total) {
    return stoppedHost(total, faultOf(`${HOST} judged a different number of cases`, total));
  }
  if (!results.every(readable)) {
    return stoppedHost(total, faultOf(`${HOST} answered a verdict it does not have`, total));
  }
  return hostTally(results, total, budgetMs);
}
