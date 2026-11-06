import { spawn } from "node:child_process";
import { JudgeRefused } from "./judge-errors.js";
import { deadlineOf, faultOf, type Stop } from "./verdict-model.js";
import { type CaseResult, type Cases, deadlineMissed, DIAGNOSTIC_BYTES, OUTPUT_BYTES, permissionFlag, type Primitive, runOf, stoppedTally, type Tallied, tallied } from "./viper.js";

export const HOST_ENGINE = "node-vm";
export const HOST_CALL_MS = 2_000;
export const hostDetail = (cases: number): number => Math.max(16, Math.floor(OUTPUT_BYTES / (8 * Math.max(1, cases))));
export const HOST_VERDICTS: readonly string[] = ["pass", "wrong", "not-primitive", "threw", "stopped", "no-module"];
export const V8_SEEDS = 2_147_483_647;

export const nodeSeed = (seed: number): number => 1 + (seed % V8_SEEDS);

export type HostJudged = { engine: typeof HOST_ENGINE } & Tallied;
export type WireArgs = { json: string; zeros: number[] };

export const wireArgs = (args: readonly Primitive[]): WireArgs => ({ json: JSON.stringify(args), zeros: args.flatMap((arg, at) => (Object.is(arg, -0) ? [at] : [])) });

export const HOST_RUNNER = `
import vm from "node:vm";
import { writeSync } from "node:fs";
import { types } from "node:util";
process.on("unhandledRejection", () => undefined);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const { source, cases, callMs, detail } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const said = Math.min(256, detail);
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
const all = (verdict, detail) => out(cases.map(() => (detail === undefined ? { verdict } : { verdict, detail })));
const context = vm.createContext(vm.constants.DONT_CONTEXTIFY, { codeGeneration: { strings: false, wasm: false } });
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
    const text = vm.runInContext("__describe()", context, { timeout: callMs, displayErrors: false });
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
try {
  const module = new vm.SourceTextModule(source, { context, identifier: "delivery.mjs" });
  await module.link(() => {
    throw new Error("the delivery imports a module");
  });
  process.once("exit", () => {
    if (loading && write(cases.map(() => ({ verdict: "no-module", detail: "the module's top-level code never finished loading" })))) process.exitCode = 0;
  });
  await module.evaluate({ timeout: callMs });
  loading = false;
  fn = module.namespace.default;
} catch (error) {
  loading = false;
  const ended = failed(error);
  if (ended.verdict === "stopped") all("stopped");
  all("no-module", ended.detail);
}
if (typeof fn !== "function") {
  all("no-module", "the delivery has no default export function");
}
give(fn);
const primitive = (v) => v === null || typeof v === "boolean" || typeof v === "number" || typeof v === "string";
const same = (a, b) => a === b || (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b));
const results = cases.map((c) => {
  if (!put("__call", call) || !put("__json", c.json)) return { verdict: "threw", detail: "the delivery locked the judge out of its global object" };
  let got;
  try {
    got = vm.runInContext("__call(__json, " + JSON.stringify(c.zeros) + ")", context, { timeout: callMs, displayErrors: false });
  } catch (error) {
    return failed(error);
  }
  if (!primitive(got)) return { verdict: "not-primitive" };
  return same(got, c.expected) ? { verdict: "pass" } : { verdict: "wrong", detail: typeof got === "string" ? got.slice(0, detail) : got };
});
out(results);
`;

type HostRan = { output: string; exitCode: number | null; timedOut: boolean; diagnostic: string };

function runHost(input: string, timeoutSeconds: number, seed: number): Promise<HostRan> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [permissionFlag(), `--random-seed=${nodeSeed(seed)}`, "--experimental-vm-modules", "--no-warnings", "--input-type=module", "-e", HOST_RUNNER], {
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

const stoppedHost = (total: number, stop: Stop): HostJudged => ({ engine: HOST_ENGINE, ...stoppedTally(total, stop) });

const readable = (result: unknown): result is CaseResult =>
  typeof result === "object" && result !== null && HOST_VERDICTS.includes((result as { verdict?: unknown }).verdict as string);

export async function judgeHost(source: Uint8Array, cases: Cases, timeoutSeconds: number, seed: number = runOf(cases).seed): Promise<HostJudged> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch {
    throw new JudgeRefused("--artifact is not UTF-8 text, so it is not a module the judge can run; nothing was paid");
  }
  const total = cases.cases.length;
  if (timeoutSeconds <= 0) return stoppedHost(total, deadlineOf(deadlineMissed(HOST, timeoutSeconds), total));
  const input = JSON.stringify({ source: text, cases: cases.cases.map((c) => ({ ...wireArgs(c.args), expected: c.expected })), callMs: HOST_CALL_MS, detail: hostDetail(total) });
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
  if (!Array.isArray(results) || results.length !== total) {
    return stoppedHost(total, faultOf(`${HOST} judged a different number of cases`, total));
  }
  if (!results.every(readable)) {
    return stoppedHost(total, faultOf(`${HOST} answered a verdict it does not have`, total));
  }
  return { engine: HOST_ENGINE, ...tallied(results) };
}
