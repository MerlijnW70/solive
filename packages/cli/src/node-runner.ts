export const NODE_LAUNCHER = `
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const caseFile = process.argv[2];
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let config;
const sweep = () => {
  try {
    process.kill(-1, "SIGKILL");
  } catch {}
};
const runCase = (token, json, zeros) =>
  new Promise((done) => {
    const child = spawn(process.execPath, ["--random-seed=" + config.seed, caseFile], { stdio: ["pipe", "pipe", "ignore"] });
    const out = [];
    let bytes = 0;
    let over = false;
    let timedOut = false;
    let code = null;
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
    child.once("exit", (exitCode) => {
      clearTimeout(timer);
      code = exitCode;
      sweep();
    });
    child.once("error", () => {
      clearTimeout(timer);
      sweep();
      done({ token, out: "", code: null, timedOut, over });
    });
    child.once("close", () => {
      done({ token, out: over ? "" : Buffer.concat(out).toString("base64"), code, timedOut, over });
    });
  });
for await (const line of lines) {
  const message = JSON.parse(line);
  if (config === undefined) {
    config = message;
    continue;
  }
  const result = await runCase(message.token, message.json, message.zeros);
  sweep();
  process.stdout.write(JSON.stringify(result) + "\\n");
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
