import { spawnSync } from "node:child_process";
import { randomInt } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const RANDOM_INPUTS = 24;
const TIMEOUT_MS = 10_000;
const SPACES = [" ", " ", " ", "\t", "\n", "\r", "\v", "\f", " ", " ", " ", " ", " ", " ", " ", " ", "　", "﻿"];
const LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.,;!?-'éüß中";

const artifact = process.env["ARTIFACT_PATH"];
if (!artifact) {
  console.error("ARTIFACT_PATH is not set");
  process.exit(2);
}
const spec = process.env["SPEC_PATH"] ?? fileURLToPath(new URL("SPEC.md", import.meta.url));
const rows = [...readFileSync(spec, "utf8").matchAll(/^\| `("(?:[^"\\]|\\.)*")` \| (\d+) \|$/gm)].map((m) => [JSON.parse(m[1]), Number(m[2])]);
if (rows.length === 0) {
  console.error(`no rows in the table of ${spec}`);
  process.exit(2);
}

function pick(chars) {
  return chars[randomInt(chars.length)];
}

function run(min, max, chars) {
  let text = "";
  for (let i = randomInt(min, max + 1); i > 0; i -= 1) {
    text += pick(chars);
  }
  return text;
}

function randomText() {
  const words = randomInt(5, 13);
  let text = run(0, 3, SPACES);
  for (let i = 0; i < words; i += 1) {
    text += run(1, 8, LETTERS);
    text += i === words - 1 ? run(0, 3, SPACES) : run(1, 3, SPACES);
  }
  return text;
}

const inputs = [...rows];
for (let i = 0; i < RANDOM_INPUTS; i += 1) {
  const text = randomText();
  inputs.push([text, (text.match(/\S+/g) ?? []).length]);
}

const path = resolve(artifact);
const file = statSync(path).isDirectory() ? join(path, "wordcount.mjs") : path;
const child = `
const count = (await import(${JSON.stringify(pathToFileURL(file).href)})).default;
let data = "";
for await (const chunk of process.stdin) data += chunk;
const results = JSON.parse(data).map((text) => {
  if (typeof count !== "function") return "no default export function";
  try {
    const got = count(text);
    return typeof got === "number" ? got : String(got);
  } catch (error) {
    return \`a thrown \${String(error)}\`;
  }
});
process.stdout.write(JSON.stringify(results) + "\\n");
`;
const result = spawnSync(process.execPath, ["--input-type=module", "--eval", child], {
  input: JSON.stringify(inputs.map(([text]) => text)),
  encoding: "utf8",
  env: { PATH: process.env["PATH"] ?? "" },
  timeout: TIMEOUT_MS,
  killSignal: "SIGKILL",
  maxBuffer: 1 << 20,
});

function refuse(reason) {
  console.error(reason);
  process.exit(1);
}

if (result.error?.code === "ETIMEDOUT" || result.signal !== null) {
  refuse(`the delivery did not finish within ${TIMEOUT_MS / 1000} s`);
}
if (result.error) {
  refuse(`the delivery could not run: ${String(result.error)}`);
}
if (result.status !== 0) {
  refuse(`the delivery exited with code ${result.status}: ${result.stderr.trim()}`);
}
if (result.stderr !== "") {
  refuse(`the delivery printed to stderr: ${result.stderr.trim()}`);
}
const lines = result.stdout.split("\n");
if (lines.length !== 2 || lines[1] !== "") {
  refuse("the delivery printed output of its own");
}
let counts;
try {
  counts = JSON.parse(lines[0]);
} catch {
  refuse("the delivery printed output of its own");
}
if (!Array.isArray(counts) || counts.length !== inputs.length) {
  refuse("the delivery printed output of its own");
}
if (counts.every((got) => got === "no default export function")) {
  refuse(`${file} has no default export function`);
}
let failed = 0;
inputs.forEach(([text, expected], index) => {
  const got = counts[index];
  if (got !== expected) {
    failed += 1;
    console.error(`count(${JSON.stringify(text)}) returned ${String(got)}, expected ${expected}`);
  }
});
console.log(`${inputs.length - failed} of ${inputs.length} inputs hold`);
process.exit(failed === 0 ? 0 : 1);
