import { describe, expect, it } from "vitest";
import { JudgeRefused } from "../../src/judge-errors.js";
import { CASES_FENCE, casesOf, notUtf8 } from "../../src/viper.js";

const bytes = (text: string) => new TextEncoder().encode(text);
const SPEC = '# First code unit\n\nReturn the first UTF-16 code unit of the text.\n\n```judge-cases\n{"cases": [{"args": ["\\ud800"], "expected": 55296}, {"args": ["\\udfff!"], "expected": 57343}, {"args": ["a\\ud83d"], "expected": 97}]}\n```\n';
const alone = (arg: string) => SPEC.replace(/\{"cases".*\}/, JSON.stringify({ cases: [{ args: [arg], expected: arg.charCodeAt(0) }] }));

describe("string arguments the spec writes as JSON escapes", () => {
  it("JS-1 a spec with a lone surrogate argument is refused when the judge reads it, before any engine runs", () => {
    expect(() => casesOf(bytes(SPEC))).toThrow(JudgeRefused);
    expect(() => casesOf(bytes(SPEC))).toThrow(`the spec's ${CASES_FENCE} block has case 0, whose args hold ${notUtf8}; nothing was run or paid`);
    for (const arg of ["\udfff!", "a\ud83d"]) {
      expect(() => casesOf(bytes(alone(arg))), JSON.stringify(arg)).toThrow(`has case 0, whose args hold ${notUtf8}`);
    }
  });
});
