import { describe, expect, it } from "vitest";
import { type Beacon, judgeDraw } from "../src/draw.js";
import { type Cases, DEFAULT_HEAP, DEFAULT_STEPS, type Draw, judgeViper, notUtf8, pinnedWasm } from "../src/viper.js";

const ANSWERS = [
  "NaN",
  "Infinity",
  "-Infinity",
  '"a" + String.fromCharCode(0xd800)',
  "7",
  '"ok"',
  "String.fromCharCode(0xfffd)",
  "String.fromCharCode(0xdc00, 0xd800)",
  "String.fromCharCode(0xd800)",
  'String.fromCharCode(0xd800) + "x".repeat(250)',
  '"a" + String.fromCharCode(0xfffd) + "x".repeat(250)',
];
const DELIVERY = `export default (n) => [${ANSWERS.join(", ")}][n];\n`;
const GENERATOR = `export default (seed, count) => Array.from({ length: count }, (_, n) => [n]);`;
const SEED = "cd".repeat(32);
const REPLACEMENT = String.fromCharCode(0xfffd);
const LONE = String.fromCharCode(0xd800);

const bytes = (text: string) => new TextEncoder().encode(text);

async function judged(checker: string) {
  const draw: Draw = { count: ANSWERS.length, generator: GENERATOR, checker, k: 1 };
  const cases: Cases = { steps: DEFAULT_STEPS, heap: DEFAULT_HEAP, seed: undefined, clock: undefined, cases: [], draw };
  const beacon = { slot: 3n, blockhash: "hash", seed: SEED, draw } as Beacon;
  return judgeDraw(await pinnedWasm(), bytes(DELIVERY), cases, beacon, () => 30, { seed: 1, clock: 0 });
}

const published = async (delivery: string, expected: string) =>
  judgeViper(await pinnedWasm(), bytes(delivery), { steps: DEFAULT_STEPS, heap: DEFAULT_HEAP, seed: 1, clock: 0, cases: [{ args: [], expected }] }, 30);

describe("drawn answers ViperJS returns", () => {
  it("fails NaN, Infinity, -Infinity and strings with a lone surrogate, and checks the rest, U+FFFD included", async () => {
    const lone = { verdict: "not-primitive", detail: `the answer is ${notUtf8}` };
    expect(await judged("export default () => true;")).toStrictEqual({
      slot: 3,
      blockhash: "hash",
      seed: SEED,
      total: ANSWERS.length,
      passed: 4,
      failures: [
        { case: 0, verdict: "not-primitive", detail: "the answer NaN is not a finite JSON number" },
        { case: 1, verdict: "not-primitive", detail: "the answer Infinity is not a finite JSON number" },
        { case: 2, verdict: "not-primitive", detail: "the answer -Infinity is not a finite JSON number" },
        { case: 3, ...lone },
        { case: 7, ...lone },
        { case: 8, ...lone },
        { case: 9, ...lone },
      ],
    });
  }, 60_000);

  it("hands the checker every accepted answer exactly as the delivery returned it", async () => {
    const strict = `export default ([n], answer) => (n === 4 ? answer === 7 : n === 5 ? answer === "ok" : n === 6 ? answer === "\\ufffd" : n === 10 ? answer === "a\\ufffd" + "x".repeat(250) : false);`;
    const judgement = await judged(strict);
    expect(judgement.passed).toBe(4);
    expect(judgement.failures.map((failure) => failure.case)).toStrictEqual([0, 1, 2, 3, 7, 8, 9]);
  }, 60_000);
});

describe("published answers ViperJS returns", () => {
  it("passes U+FFFD against an expected U+FFFD", async () => {
    expect(await published("export default () => String.fromCharCode(0xfffd);", REPLACEMENT)).toMatchObject({ total: 1, passed: 1, failures: [] });
  }, 60_000);

  it("tells a lone surrogate from U+FFFD and reports it as the code unit it is", async () => {
    expect(await published("export default () => String.fromCharCode(0xd800);", REPLACEMENT)).toMatchObject({ passed: 0, failures: [{ case: 0, verdict: "wrong", detail: LONE }] });
  }, 60_000);
});
