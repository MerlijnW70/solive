import { describe, expect, it } from "vitest";
import { CASES_FENCE, casesOf, MAX_CASES, MAX_DRAW_SLOTS, notUtf8 } from "../src/viper.js";

const CASES = [{ args: [1], expected: 1 }];
const GENERATOR = "export default (seed, count) => [];";
const CHECKER = "export default () => true;";

const spec = (block: object) => new TextEncoder().encode(`\`\`\`${CASES_FENCE}\n${JSON.stringify(block)}\n\`\`\`\n`);

const refusal = (why: string) => `the spec's ${CASES_FENCE} block ${why}; nothing was run or paid`;

describe("the draw block of a spec", () => {
  it("takes a draw count and k at both ends of their ranges", () => {
    for (const [count, k] of [
      [1, 1],
      [MAX_CASES, MAX_DRAW_SLOTS],
    ] as const) {
      expect(casesOf(spec({ cases: CASES, draw: { count, generator: GENERATOR, checker: CHECKER, k } })).draw).toStrictEqual({ count, generator: GENERATOR, checker: CHECKER, k });
    }
  });

  it("refuses a draw generator or checker that holds a lone surrogate", () => {
    const lone = 'export default () => [["\ud800"]];';
    expect(() => casesOf(spec({ cases: CASES, draw: { count: 1, generator: lone, checker: CHECKER, k: 1 } }))).toThrow(refusal(`has a draw generator that holds ${notUtf8}`));
    expect(() => casesOf(spec({ cases: CASES, draw: { count: 1, generator: GENERATOR, checker: lone, k: 1 } }))).toThrow(refusal(`has a draw checker that holds ${notUtf8}`));
  });

  it("refuses a draw that is null, a list or a string as not a JSON object", () => {
    for (const draw of [null, [], "draw"]) {
      expect(() => casesOf(spec({ cases: CASES, draw })), JSON.stringify(draw)).toThrow(refusal("has a draw that is not a JSON object"));
    }
  });
});
