import { spawn } from "node:child_process";
import { JudgeRefused } from "./judge-errors.js";
import {
  type CaseResult,
  type Cases,
  deadlineMissed,
  DIAGNOSTIC_BYTES,
  type Failure,
  OUTPUT_BYTES,
  permissionFlag,
  REPORTED_FAILURES,
  runOf,
  stoppedAll,
} from "./viper.js";

export const HOST_ENGINE = "node-vm";
export const HOST_CALL_MS = 2_000;
export const V8_SEEDS = 2_147_483_647;

export const nodeSeed = (seed: number): number => 1 + (seed % V8_SEEDS);

export type HostJudged = { engine: typeof HOST_ENGINE; total: number; passed: number; failures: Failure[] };

export const HOST_RUNNER = `
import vm from "node:vm";
process.on("unhandledRejection", () => undefined);
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const { source, cases, callMs } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const out = (results) => process.stdout.write(JSON.stringify(results));
const all = (verdict, detail) => out(cases.map(() => (detail === undefined ? { verdict } : { verdict, detail })));
const context = vm.createContext(vm.constants.DONT_CONTEXTIFY, { codeGeneration: { strings: false, wasm: false } });
let fn;
try {
  const module = new vm.SourceTextModule(source, { context, identifier: "delivery.mjs" });
  await module.link(() => {
    throw new Error("the delivery imports a module");
  });
  await module.evaluate({ timeout: callMs });
  fn = module.namespace.default;
} catch (error) {
  all("no-module", String(error && error.message ? error.message : error).slice(0, 256));
  process.exit(0);
}
if (typeof fn !== "function") {
  all("no-module", "the delivery has no default export function");
  process.exit(0);
}
context.__call = fn;
const primitive = (v) => v === null || typeof v === "boolean" || typeof v === "number" || typeof v === "string";
const same = (a, b) => a === b || (typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b));
const results = cases.map((c) => {
  context.__json = JSON.stringify(c.args);
  let got;
  try {
    got = vm.runInContext("__call(...JSON.parse(__json))", context, { timeout: callMs });
  } catch (error) {
    const stopped = error && error.code === "ERR_SCRIPT_EXECUTION_TIMEOUT";
    return stopped ? { verdict: "stopped" } : { verdict: "threw", detail: String(error && error.message ? error.message : error).slice(0, 256) };
  }
  if (!primitive(got)) return { verdict: "not-primitive" };
  return same(got, c.expected) ? { verdict: "pass" } : { verdict: "wrong", detail: got };
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

function summarized(results: CaseResult[]): HostJudged {
  const failures = results.flatMap((result, index) => (result.verdict === "pass" ? [] : [{ case: index, ...result }]));
  return { engine: HOST_ENGINE, total: results.length, passed: results.length - failures.length, failures: failures.slice(0, REPORTED_FAILURES) };
}

function failedAll(cases: Cases, verdict: Failure["verdict"], detail: string): HostJudged {
  return { engine: HOST_ENGINE, total: cases.cases.length, passed: 0, failures: [{ case: 0, verdict, detail }] };
}

export async function judgeHost(source: Uint8Array, cases: Cases, timeoutSeconds: number, seed: number = runOf(cases).seed): Promise<HostJudged> {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch {
    throw new JudgeRefused("--artifact is not UTF-8 text, so it is not a module the judge can run; nothing was paid");
  }
  if (timeoutSeconds <= 0) return { engine: HOST_ENGINE, ...stoppedAll(cases.cases.length, deadlineMissed("the host engine", timeoutSeconds)) };
  const ran = await runHost(JSON.stringify({ source: text, cases: cases.cases, callMs: HOST_CALL_MS }), timeoutSeconds, seed);
  if (ran.timedOut) return { engine: HOST_ENGINE, ...stoppedAll(cases.cases.length, deadlineMissed("the host engine", timeoutSeconds)) };
  if (ran.exitCode !== 0) {
    return failedAll(cases, "crashed", `the host engine ended with exit code ${ran.exitCode}: ${ran.diagnostic.trim().slice(0, 256)}`);
  }
  let results: unknown;
  try {
    results = JSON.parse(ran.output);
  } catch {
    return failedAll(cases, "crashed", "the host engine wrote no readable verdict");
  }
  if (!Array.isArray(results) || results.length !== cases.cases.length) {
    return failedAll(cases, "crashed", "the host engine judged a different number of cases");
  }
  return summarized(results as CaseResult[]);
}
