import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
const path = resolve(artifact);
const file = statSync(path).isDirectory() ? join(path, "wordcount.mjs") : path;
const count = (await import(pathToFileURL(file).href)).default;
if (typeof count !== "function") {
  console.error(`${file} has no default export function`);
  process.exit(1);
}
let failed = 0;
for (const [text, expected] of rows) {
  let got;
  try {
    got = count(text);
  } catch (error) {
    got = `a thrown ${String(error)}`;
  }
  if (got !== expected) {
    failed += 1;
    console.error(`count(${JSON.stringify(text)}) returned ${String(got)}, expected ${expected}`);
  }
}
console.log(`${rows.length - failed} of ${rows.length} rows hold`);
process.exit(failed === 0 ? 0 : 1);
