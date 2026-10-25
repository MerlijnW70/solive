import { describe, expect, it } from "vitest";
import { type Beacon, judgeDraw, unreported } from "../src/draw.js";
import { type Cases, DEFAULT_HEAP, DEFAULT_STEPS, type Draw, judgeViper, pinnedWasm } from "../src/viper.js";

const ANSWERS = ["NaN", "Infinity", "-Infinity", '"a" + String.fromCharCode(0xd800)', "7", '"ok"', "String.fromCharCode(0xfffd)", "String.fromCharCode(0xdc00, 0xd800)"];
const DELIVERY = `export default (n) => [${ANSWERS.join(", ")}][n];\n`;
const GENERATOR = `export default (seed, count) => Array.from({ length: count }, (_, n) => [n]);`;
const SEED = "cd".repeat(32);

const bytes = (text: string) => new TextEncoder().encode(text);

async function judged(checker: string) {
  const draw: Draw = { count: ANSWERS.length, generator: GENERATOR, checker, k: 1 };
  const cases: Cases = { steps: DEFAULT_STEPS, heap: DEFAULT_HEAP, seed: undefined, clock: undefined, cases: [], draw };
  const beacon = { slot: 3n, blockhash: "hash", seed: SEED, draw } as Beacon;
  return judgeDraw(await pinnedWasm(), bytes(DELIVERY), cases, beacon, () => 30, { seed: 1, clock: 0 });
}

describe("drawn answers ViperJS returns", () => {
  it("fails NaN, Infinity, -Infinity and strings ViperJS could not report exactly, and checks the finite number and the plain string", async () => {
    const changed = { verdict: "not-primitive", detail: `the answer holds ${unreported}` };
    expect(await judged("export default () => true;")).toStrictEqual({
      slot: 3,
      blockhash: "hash",
      seed: SEED,
      total: ANSWERS.length,
      passed: 2,
      failures: [
        { case: 0, verdict: "not-primitive", detail: "the answer NaN is not a finite JSON number" },
        { case: 1, verdict: "not-primitive", detail: "the answer Infinity is not a finite JSON number" },
        { case: 2, verdict: "not-primitive", detail: "the answer -Infinity is not a finite JSON number" },
        { case: 3, ...changed },
        { case: 6, ...changed },
        { case: 7, ...changed },
      ],
    });
  }, 60_000);

  it("cannot be confirmed by a rerun, since ViperJS's own comparison takes a lone surrogate for U+FFFD", async () => {
    const lone = { steps: DEFAULT_STEPS, heap: DEFAULT_HEAP, seed: 1, clock: 0, cases: [{ args: [], expected: String.fromCharCode(0xfffd) }] };
    expect(await judgeViper(await pinnedWasm(), bytes("export default () => String.fromCharCode(0xd800);"), lone, 30)).toMatchObject({ passed: 1, failures: [] });
  }, 60_000);

  it("hands the checker the finite number and the plain string exactly as the delivery returned them", async () => {
    const strict = "export default ([n], answer) => (n === 4 ? answer === 7 : n === 5 ? answer === \"ok\" : false);";
    const judgement = await judged(strict);
    expect(judgement.passed).toBe(2);
    expect(judgement.failures.map((failure) => failure.case)).toStrictEqual([0, 1, 2, 3, 6, 7]);
  }, 60_000);
});
