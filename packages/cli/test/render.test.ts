import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { HIDDEN_RANGES, printable, printableLines, renderText } from "../src/render.js";

const ch = (code: number) => String.fromCodePoint(code);
const shows = (text: string) =>
  !Array.from(text.replaceAll("\n", "")).some((c) => HIDDEN_RANGES.some(([low, high]) => (c.codePointAt(0) ?? 0) >= low && (c.codePointAt(0) ?? 0) <= high));

describe("text the cli prints", () => {
  it("shows control, bidi and line-separator characters as visible escapes", () => {
    expect(HIDDEN_RANGES).toEqual([
      [0x00, 0x1f],
      [0x7f, 0x9f],
      [0x61c, 0x61c],
      [0x200e, 0x200f],
      [0x2028, 0x202e],
      [0x2066, 0x2069],
    ]);
    expect(printable(`plain ${ch(0x2192)} text ${ch(0x2713)}`)).toBe(`plain ${ch(0x2192)} text ${ch(0x2713)}`);
    expect(printable(`${ch(0x1b)}]0;owned${ch(0x07)}`)).toBe("\\u001b]0;owned\\u0007");
    expect(printable(`a${ch(0x0a)}sent: true`)).toBe("a\\u000asent: true");
    expect(printable(`${ch(0x202e)}evil${ch(0x2028)}${ch(0x85)}${ch(0x7f)}${ch(0x2069)}${ch(0x61c)}`)).toBe(
      "\\u202eevil\\u2028\\u0085\\u007f\\u2069\\u061c",
    );
    for (const edge of [0x1f, 0x20, 0x7e, 0x7f, 0x9f, 0xa0, 0x61b, 0x61d, 0x200d, 0x2010, 0x2027, 0x202f, 0x2065, 0x206a]) {
      expect(shows(printable(ch(edge)))).toBe(true);
    }
    expect(printable(ch(0x20))).toBe(" ");
    expect(printable(ch(0xa0))).toBe(ch(0xa0));
    expect(printableLines(`first${ch(0x0a)}${ch(0x1b)}[2Jsecond`)).toBe("first\n\\u001b[2Jsecond");
  });

  it("never lets a value forge a line or reach the terminal as a control sequence", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), fc.string({ unit: "binary" }), (key, value) => {
        const out = renderText({ [`k${key}`]: value, list: [value], nested: { value } });
        expect(out.split("\n")).toHaveLength(3);
        expect(shows(out)).toBe(true);
        const summary = renderText({ summary: [value], warnings: [value] });
        expect(summary.split("\n")).toHaveLength(2);
        expect(shows(summary)).toBe(true);
        expect(shows(printableLines(value))).toBe(true);
        expect(printableLines(value).split("\n")).toHaveLength(value.split("\n").length);
      }),
      { numRuns: 1_000 },
    );
  });
});
