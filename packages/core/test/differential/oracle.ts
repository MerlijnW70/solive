import { register } from "node:module";
import { createInterface } from "node:readline";

register("./hooks.ts", import.meta.url);

const { answer } = await import("./pairs.js");

let pending: string[] = [];
let scheduled = false;

const flush = () => {
  scheduled = false;
  const out = pending.join("");
  pending = [];
  process.stdout.write(out);
};

createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY }).on("line", (line) => {
  pending.push(`${answer(line)}\n`);
  if (!scheduled) {
    scheduled = true;
    setImmediate(flush);
  }
});
