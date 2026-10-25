import { spawn } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { JudgeRefused } from "./judge-errors.js";
import { Wtf8Refused, wtf8Decode, wtf8Encode } from "./wtf8.js";

export const VIPER_WASM_SHA256 = "bebc4c2115bc34cd6a44fa5e4046db8afb2ec89221a3fb656d4b562482dd7bb2";
export const VIPER_ENGINE_COMMIT = "d2bccdb8f77f78bddf07fad22ec76bfedbfbbf0f";
export const CASES_FENCE = "judge-cases";
export const DEFAULT_STEPS = 10_000_000;
export const DEFAULT_HEAP = 64 * 1024 * 1024;
export const MAX_STEPS = 1_000_000_000;
export const MAX_HEAP = 256 * 1024 * 1024;
export const MAX_CASES = 10_000;
export const MAX_ARGUMENTS = 64;
export const OUTPUT_BYTES = 8 * 1024 * 1024;
export const DIAGNOSTIC_BYTES = 64 * 1024;
export const REPORTED_FAILURES = 20;
export const CLOCK_FROM = Date.UTC(2020, 0, 1);
export const CLOCK_TO = Date.UTC(2030, 0, 1);
export const SEED_LIMIT = 2 ** 48;
export const MAX_DRAW_SLOTS = 100_000;

export type Primitive = null | boolean | number | string;
export type Case = { args: Primitive[]; expected: Primitive };
export type Draw = { count: number; generator: string; checker: string; k: number };
export type Cases = { steps: number; heap: number; seed: number | undefined; clock: number | undefined; cases: Case[]; draw?: Draw };
export type Run = { seed: number; clock: number };
export type CaseVerdict = "pass" | "wrong" | "not-primitive" | "threw" | "stopped" | "no-module" | "engine" | "crashed";
export type CaseResult = { verdict: CaseVerdict; detail?: Primitive };
export type Failure = { case: number; verdict: CaseVerdict; detail?: Primitive };
export type Judged = { total: number; passed: number; failures: Failure[]; seed: number; clock: number };

const VERDICTS: readonly CaseVerdict[] = ["pass", "wrong", "not-primitive", "threw", "stopped", "no-module", "engine"];
const WIRE_VERSION = 1;

export const casesMissing = (count: number): string =>
  `--sandbox viper judges the cases in the spec, which must hold exactly one \`\`\`${CASES_FENCE} block of JSON; it holds ${count}`;

const refuse = (why: string): never => {
  throw new JudgeRefused(`the spec's ${CASES_FENCE} block ${why}; nothing was run or paid`);
};

export const isPrimitive = (value: unknown): value is Primitive =>
  value === null || typeof value === "boolean" || typeof value === "string" || (typeof value === "number" && Number.isFinite(value));

const LONE_SURROGATE = /\p{Cs}/u;

export const utf8Exact = (value: Primitive): boolean => typeof value !== "string" || !LONE_SURROGATE.test(value);

export const notUtf8 = "a string with a lone surrogate, which UTF-8 cannot carry, so the engines would not all receive it as written";

function bounded(value: unknown, name: string, fallback: number, max: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
    return refuse(`has ${name} ${JSON.stringify(value)}, which is not a whole number from 0 to ${max}`);
  }
  return value;
}

function counted(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    return refuse(`has a draw ${name} ${JSON.stringify(value)}, which is not a whole number from ${min} to ${max}`);
  }
  return value;
}

function sourceOf(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    return refuse(`has a draw ${name} that is not the source of a module`);
  }
  if (!utf8Exact(value)) {
    return refuse(`has a draw ${name} that holds ${notUtf8}`);
  }
  return value;
}

function drawOf(value: unknown): Draw {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return refuse("has a draw that is not a JSON object");
  }
  const fields = value as Record<string, unknown>;
  const unknown = Object.keys(fields).find((key) => !["count", "generator", "checker", "k"].includes(key));
  if (unknown !== undefined) {
    return refuse(`has a draw field ${JSON.stringify(unknown)} it does not know`);
  }
  return {
    count: counted(fields["count"], "count", 1, MAX_CASES),
    generator: sourceOf(fields["generator"], "generator"),
    checker: sourceOf(fields["checker"], "checker"),
    k: counted(fields["k"], "k", 1, MAX_DRAW_SLOTS),
  };
}

export function casesOf(spec: Uint8Array): Cases {
  const text = new TextDecoder().decode(spec);
  const blocks = [...text.matchAll(new RegExp(`^\`\`\`${CASES_FENCE}[ \\t]*\\r?\\n([\\s\\S]*?)^\`\`\`[ \\t]*$`, "gm"))];
  if (blocks.length !== 1) {
    throw new JudgeRefused(casesMissing(blocks.length));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(blocks[0]?.[1] ?? "");
  } catch (error) {
    return refuse(`is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return refuse("is not a JSON object");
  }
  const fields = parsed as Record<string, unknown>;
  const unknown = Object.keys(fields).find((key) => !["steps", "heap", "seed", "clock", "cases", "draw"].includes(key));
  if (unknown !== undefined) {
    return refuse(`has a field ${JSON.stringify(unknown)} it does not know`);
  }
  const raw = fields["cases"];
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_CASES) {
    return refuse(`must list from 1 to ${MAX_CASES} cases`);
  }
  const cases = raw.map((item: unknown, index): Case => {
    const entry = typeof item === "object" && item !== null && !Array.isArray(item) ? (item as Record<string, unknown>) : undefined;
    const args = entry?.["args"];
    if (entry === undefined || Object.keys(entry).some((key) => key !== "args" && key !== "expected") || !("expected" in entry)) {
      return refuse(`has case ${index}, which is not an object of args and expected`);
    }
    if (!Array.isArray(args) || args.length > MAX_ARGUMENTS || !args.every(isPrimitive)) {
      return refuse(`has case ${index}, whose args are not a list of at most ${MAX_ARGUMENTS} JSON strings, numbers, booleans or nulls`);
    }
    if (!isPrimitive(entry["expected"])) {
      return refuse(`has case ${index}, whose expected answer is not a JSON string, number, boolean or null`);
    }
    if (!args.every(utf8Exact)) {
      return refuse(`has case ${index}, whose args hold ${notUtf8}`);
    }
    if (!utf8Exact(entry["expected"])) {
      return refuse(`has case ${index}, whose expected answer is ${notUtf8}`);
    }
    if (Object.is(entry["expected"], -0)) {
      return refuse(`has case ${index}, whose expected answer is negative zero, which the engines cannot tell from positive zero`);
    }
    return { args, expected: entry["expected"] };
  });
  return {
    steps: bounded(fields["steps"], "steps", DEFAULT_STEPS, MAX_STEPS),
    heap: bounded(fields["heap"], "heap", DEFAULT_HEAP, MAX_HEAP),
    seed: fields["seed"] === undefined ? undefined : bounded(fields["seed"], "seed", 1, Number.MAX_SAFE_INTEGER),
    clock: fields["clock"] === undefined ? undefined : bounded(fields["clock"], "clock", 0, 8.64e15),
    cases,
    ...(fields["draw"] === undefined ? {} : { draw: drawOf(fields["draw"]) }),
  };
}

class Writer {
  private readonly parts: Buffer[] = [];
  u32(n: number): this {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    this.parts.push(b);
    return this;
  }
  u64(n: number): this {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n));
    this.parts.push(b);
    return this;
  }
  f64(n: number): this {
    const b = Buffer.alloc(8);
    b.writeDoubleLE(n);
    this.parts.push(b);
    return this;
  }
  string(text: string): this {
    return this.sized(Buffer.from(text, "utf8"));
  }
  wtf8(text: string): this {
    return this.sized(wtf8Encode(text));
  }
  private sized(b: Buffer): this {
    this.u32(b.length);
    this.parts.push(b);
    return this;
  }
  byte(n: number): this {
    this.parts.push(Buffer.from([n]));
    return this;
  }
  value(v: Primitive): this {
    if (v === null) return this.byte(1);
    if (v === false) return this.byte(2);
    if (v === true) return this.byte(3);
    if (typeof v === "number") return this.byte(4).f64(v);
    return this.byte(5).wtf8(v);
  }
  bytes(): Buffer {
    return Buffer.concat(this.parts);
  }
}

export const runOf = (cases: Cases): Run => ({
  seed: cases.seed ?? randomInt(1, SEED_LIMIT),
  clock: cases.clock ?? randomInt(CLOCK_FROM, CLOCK_TO),
});

export function encodeInput(source: string, cases: Cases, run: Run): Buffer {
  const writer = new Writer().u32(WIRE_VERSION).u64(cases.steps).u64(cases.heap).u64(run.seed).f64(run.clock).string(source).u32(cases.cases.length);
  for (const item of cases.cases) {
    writer.u32(item.args.length);
    item.args.forEach((arg) => writer.value(arg));
    writer.value(item.expected);
  }
  return writer.bytes();
}

export function decodeOutput(bytes: Buffer, expected: number): CaseResult[] {
  let at = 0;
  const need = (count: number) => {
    if (at + count > bytes.length) throw new JudgeRefused("the viper judge answered a truncated verdict; nothing was paid");
  };
  const u8 = () => (need(1), bytes.readUInt8(at++));
  const u32 = () => (need(4), (at += 4), bytes.readUInt32LE(at - 4));
  const sized = () => {
    const length = u32();
    need(length);
    at += length;
    return bytes.subarray(at - length, at);
  };
  const string = () => sized().toString("utf8");
  const exact = () => {
    try {
      return wtf8Decode(sized());
    } catch (error) {
      throw new JudgeRefused(`the viper judge answered a string that is not WTF-8, with ${(error as Wtf8Refused).message}; nothing was paid`);
    }
  };
  const value = (): Primitive | undefined => {
    const tag = u8();
    if (tag === 4) {
      need(8);
      at += 8;
      return bytes.readDoubleLE(at - 8);
    }
    if (tag === 5) return exact();
    if (tag > 5) throw new JudgeRefused("the viper judge answered a value it does not have; nothing was paid");
    return [undefined, null, false, true][tag];
  };
  if (u32() !== WIRE_VERSION || u8() !== 0) {
    throw new JudgeRefused("the viper judge refused its own input; nothing was paid");
  }
  const count = u32();
  if (count !== expected) {
    throw new JudgeRefused(`the viper judge answered ${count} verdicts for ${expected} cases; nothing was paid`);
  }
  const results: CaseResult[] = [];
  for (let n = 0; n < count; n += 1) {
    const verdict = VERDICTS[u8()];
    if (verdict === undefined) throw new JudgeRefused("the viper judge answered a verdict it does not have; nothing was paid");
    const detail = verdict === "wrong" ? value() : verdict === "threw" || verdict === "no-module" ? string() : undefined;
    results.push(detail === undefined ? { verdict } : { verdict, detail });
  }
  if (at !== bytes.length) {
    throw new JudgeRefused("the viper judge answered more than its verdicts; nothing was paid");
  }
  return results;
}

export function stoppedAll(total: number, detail: string): { total: number; passed: number; failures: Failure[] } {
  const failures = Array.from({ length: Math.min(total, REPORTED_FAILURES) }, (_, index): Failure => (index === 0 ? { case: index, verdict: "stopped", detail } : { case: index, verdict: "stopped" }));
  return { total, passed: 0, failures };
}

export const deadlineMissed = (engine: string, timeoutSeconds: number): string =>
  `${engine} did not finish within the ${Math.round(timeoutSeconds * 1000)} ms left of the judgement's --timeout`;

export function summarize(results: CaseResult[], run: Run): Judged {
  const failures = results.flatMap((result, index) => (result.verdict === "pass" ? [] : [{ case: index, ...result }]));
  return { total: results.length, passed: results.length - failures.length, failures: failures.slice(0, REPORTED_FAILURES), ...run };
}

export function wasmPath(): string {
  const candidates = ["../assets/viperjs-judge.wasm", "../../assets/viperjs-judge.wasm"].map((relative) => fileURLToPath(new URL(relative, import.meta.url)));
  return candidates.find((path) => existsSync(path)) ?? (candidates[0] as string);
}

export async function pinnedWasm(path: string = wasmPath()): Promise<Buffer> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    throw new JudgeRefused(`the viper judge module ${path} is missing; reinstall the CLI. Nothing was run or paid`);
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== VIPER_WASM_SHA256) {
    throw new JudgeRefused(`the viper judge module ${path} has sha256 ${sha256}, not the pinned ${VIPER_WASM_SHA256}; nothing was run or paid`);
  }
  return bytes;
}

export const RUNNER = `
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const all = Buffer.concat(chunks);
const length = all.readUInt32LE(0);
const module = await WebAssembly.compile(all.subarray(4, 4 + length));
if (WebAssembly.Module.imports(module).length !== 0) process.exit(3);
const { exports } = await WebAssembly.instantiate(module, {});
const input = all.subarray(4 + length);
const at = exports.input(input.length);
new Uint8Array(exports.memory.buffer, at, input.length).set(input);
const produced = exports.run();
process.stdout.write(Buffer.from(new Uint8Array(exports.memory.buffer, exports.output(), produced)));
`;

export const permissionFlag = (): string => (process.allowedNodeEnvironmentFlags.has("--permission") ? "--permission" : "--experimental-permission");

export type Ran = { output: Buffer; exitCode: number | null; timedOut: boolean; diagnostic: string };

export function runViper(wasm: Buffer, input: Buffer, timeoutSeconds: number): Promise<Ran> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [permissionFlag(), "--input-type=module", "-e", RUNNER], { env: {}, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const out: Buffer[] = [];
    let outBytes = 0;
    let diagnostic = "";
    let timedOut = false;
    let over = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutSeconds * 1000);
    child.stdout.on("data", (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes > OUTPUT_BYTES) {
        over = true;
        child.kill("SIGKILL");
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (diagnostic.length < DIAGNOSTIC_BYTES) diagnostic += chunk.toString("utf8").slice(0, DIAGNOSTIC_BYTES - diagnostic.length);
    });
    child.stdin.on("error", () => undefined);
    const length = Buffer.alloc(4);
    length.writeUInt32LE(wasm.length);
    child.stdin.end(Buffer.concat([length, wasm, input]));
    child.once("error", (error) => {
      clearTimeout(timer);
      done({ output: Buffer.alloc(0), exitCode: null, timedOut, diagnostic: error.message });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      done({ output: over ? Buffer.alloc(0) : Buffer.concat(out), exitCode: over ? null : code, timedOut, diagnostic });
    });
  });
}

export function moduleText(source: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch {
    throw new JudgeRefused("--artifact is not UTF-8 text, so it is not a module the viper judge can run; nothing was paid");
  }
}

export async function judgeViper(wasm: Buffer, source: Uint8Array, cases: Cases, timeoutSeconds: number, run: Run = runOf(cases)): Promise<Judged> {
  const text = moduleText(source);
  if (timeoutSeconds <= 0) {
    return { ...stoppedAll(cases.cases.length, deadlineMissed("the viper judge", timeoutSeconds)), ...run };
  }
  const ran = await runViper(wasm, encodeInput(text, cases, run), timeoutSeconds);
  if (ran.timedOut) {
    return { ...stoppedAll(cases.cases.length, deadlineMissed("the viper judge", timeoutSeconds)), ...run };
  }
  if (ran.exitCode !== 0) {
    return { total: cases.cases.length, passed: 0, failures: [{ case: 0, verdict: "crashed", detail: `the judge process ended with exit code ${ran.exitCode}: ${ran.diagnostic.trim().slice(0, 256)}` }], ...run };
  }
  return summarize(decodeOutput(ran.output, cases.cases.length), run);
}
