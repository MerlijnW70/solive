export const NODE_READY = '"ready"';

export const NODE_UNCOUNTED = '"uncounted"';

export const SAME_UID = "the plain Node launcher runs under the uid its cases would run under, so a case could reach it, and no case was run";

export const NODE_LAUNCHER = `
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const caseFile = process.argv[2];
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let config;
const sweep = () => {
  try {
    process.kill(-1, "SIGKILL");
  } catch {}
};
const others = () => {
  try {
    return readFileSync(config.procs, "utf8").split("\\n").filter((pid) => pid !== "" && pid !== "1" && pid !== String(process.pid)).length;
  } catch {
    return null;
  }
};
const settle = async () => {
  const until = performance.now() + config.settleMs;
  for (;;) {
    sweep();
    const left = others();
    if (left === 0) return true;
    if (left === null || performance.now() >= until) return false;
    await new Promise((done) => setTimeout(done, 5));
  }
};
const oomCount = () => {
  try {
    const found = /^oom_kill (\\d{1,15})$/m.exec(readFileSync(config.events, "utf8"));
    return found === null ? null : Number(found[1]);
  } catch {
    return null;
  }
};
const runCase = (token, json, zeros) =>
  new Promise((done) => {
    const child = spawn(process.execPath, ["--disable-sigusr1", "--max-old-space-size=" + config.heapMb, "--random-seed=" + config.seed, caseFile], { stdio: ["pipe", "pipe", "ignore"], uid: config.uid, gid: config.gid, detached: true });
    const out = [];
    let bytes = 0;
    let over = false;
    let timedOut = false;
    let code = null;
    let signal = null;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, config.caseMs);
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > config.outputBytes) {
        over = true;
        child.kill("SIGKILL");
        return;
      }
      if (!over) out.push(chunk);
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(JSON.stringify({ token, json, zeros, path: config.path }));
    child.once("exit", (exitCode, endedBy) => {
      clearTimeout(timer);
      code = exitCode;
      signal = endedBy;
      sweep();
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      sweep();
      done({ token, out: "", code: null, signal: null, timedOut, over, failed: String(error && error.message ? error.message : error) });
    });
    child.once("close", () => {
      done({ token, out: over ? "" : Buffer.concat(out).toString("base64"), code, signal, timedOut, over });
    });
  });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (config === undefined) {
    config = message;
    if (process.getuid() === config.uid || process.getgid() === config.gid) {
      process.stderr.write(${JSON.stringify(SAME_UID)} + "\\n");
      process.exit(78);
    }
    if (config.pinned === true && oomCount() === null) {
      process.stdout.write(${JSON.stringify(NODE_UNCOUNTED)} + "\\n");
      process.exit(0);
    }
    process.stdout.write(${JSON.stringify(NODE_READY)} + "\\n");
    continue;
  }
  const oomBefore = oomCount();
  const result = await runCase(message.token, message.json, message.zeros);
  const settled = await settle();
  process.stdout.write(JSON.stringify({ ...result, oomBefore, oomAfter: oomCount(), settled }) + "\\n");
}
`;

export const NODE_CASE = `
import { readFileSync, writeSync } from "node:fs";
import { pathToFileURL } from "node:url";
const write = writeSync;
const from = Buffer.from;
const stringify = JSON.stringify;
const apply = Reflect.apply;
const exit = process.exit.bind(process);
const input = JSON.parse(readFileSync(0, "utf8"));
const token = "" + input.token;
const args = JSON.parse("" + input.json);
const zeros = input.zeros;
for (let at = 0; at < zeros.length; at += 1) args[zeros[at]] = -0;
const url = pathToFileURL("" + input.path).href;
const put = (text) => {
  const bytes = from(text, "utf8");
  let at = 0;
  while (at < bytes.length) {
    try {
      at += write(1, bytes, at, bytes.length - at);
    } catch (error) {
      if (error === null || typeof error !== "object" || error.code !== "EAGAIN") exit(70);
    }
  }
};
const say = (verdict, kind, value) => {
  put("\\n" + token + "[" + stringify(verdict) + "," + stringify(kind) + "," + stringify(value) + "]" + token + "\\n");
  exit(0);
};
const describe = (error) => {
  try {
    const message = error !== null && typeof error === "object" ? error.message : error;
    return typeof message === "string" ? message : "a value that is not an Error";
  } catch {
    return "a value that is not an Error";
  }
};
let fn;
try {
  fn = (await import(url)).default;
} catch (error) {
  say("no-module", "string", describe(error));
}
if (typeof fn !== "function") say("no-module", "string", "the delivery has no default export function");
let got;
let threw = false;
let reason = "";
try {
  got = apply(fn, undefined, args);
} catch (error) {
  threw = true;
  reason = describe(error);
}
if (threw) say("threw", "string", reason);
const kind = got === null ? "null" : typeof got;
if (kind === "string") say("answer", kind, got);
if (kind === "number" || kind === "boolean") say("answer", kind, "" + got);
if (kind === "null") say("answer", kind, null);
say("not-primitive", kind, null);
`;
