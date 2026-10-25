import { describe, expect, it } from "vitest";
import { JudgeRefused } from "../src/judge-errors.js";
import { decodeOutput, encodeInput } from "../src/viper.js";
import { Wtf8Refused, wtf8Decode, wtf8Encode } from "../src/wtf8.js";

const units = (...codes: number[]) => String.fromCharCode(...codes);
const bytes = (...list: number[]) => Uint8Array.from(list);

const refusedWith = (input: Uint8Array): string => {
  try {
    wtf8Decode(input);
  } catch (error) {
    expect(error).toBeInstanceOf(Wtf8Refused);
    return (error as Error).message;
  }
  throw new Error("the decoder accepted the bytes");
};

const answered = (value: number[]) => {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(value.length);
  return Buffer.concat([Buffer.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 5]), length, Buffer.from(value)]);
};

const thrown = (message: number[]) => {
  const length = Buffer.alloc(4);
  length.writeUInt32LE(message.length);
  return Buffer.concat([Buffer.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 3]), length, Buffer.from(message)]);
};

describe("the WTF-8 decoder", () => {
  it("decodes well-formed UTF-8 as UTF-8 does", () => {
    for (const text of ["", "ok", "é", "€", "�", "\u{1f600}", "a\u{10ffff}z", "\u0000\u007f\u0080߿ࠀ￿\u{10000}"]) {
      expect(wtf8Decode(new TextEncoder().encode(text))).toBe(text);
    }
  });

  it("maps each surrogate triple to the lone code unit it spells", () => {
    expect(wtf8Decode(bytes(0xed, 0xa0, 0x80))).toBe(units(0xd800));
    expect(wtf8Decode(bytes(0xed, 0xaf, 0xbf))).toBe(units(0xdbff));
    expect(wtf8Decode(bytes(0xed, 0xb0, 0x80))).toBe(units(0xdc00));
    expect(wtf8Decode(bytes(0xed, 0xbf, 0xbf))).toBe(units(0xdfff));
    expect(wtf8Decode(bytes(0x61, 0xed, 0xa0, 0x80, 0xef, 0xbf, 0xbd))).toBe(`a${units(0xd800)}�`);
    expect(wtf8Decode(bytes(0xed, 0xb0, 0x80, 0xed, 0xa0, 0x80))).toBe(units(0xdc00, 0xd800));
    expect(wtf8Decode(bytes(0xed, 0xa0, 0x80, 0xed, 0xa0, 0x80))).toBe(units(0xd800, 0xd800));
    expect(wtf8Decode(bytes(0xed, 0xa0, 0x80, 0xf0, 0x9f, 0x98, 0x80))).toBe(`${units(0xd800)}\u{1f600}`);
    expect(wtf8Decode(bytes(0xed, 0xa0, 0x80, 0x61, 0xed, 0xb0, 0x80))).toBe(`${units(0xd800)}a${units(0xdc00)}`);
  });

  it("refuses a surrogate pair written as two triples", () => {
    expect(refusedWith(bytes(0xed, 0xa0, 0x80, 0xed, 0xb0, 0x80))).toBe("a surrogate pair written as two triples at byte 0");
    expect(refusedWith(bytes(0x61, 0xed, 0xaf, 0xbf, 0xed, 0xbf, 0xbf))).toBe("a surrogate pair written as two triples at byte 1");
  });

  it("refuses malformed bytes with a named reason instead of replacing them", () => {
    expect(refusedWith(bytes(0x80))).toBe("a continuation byte that starts no character at byte 0");
    expect(refusedWith(bytes(0x61, 0xbf))).toBe("a continuation byte that starts no character at byte 1");
    expect(refusedWith(bytes(0xc3))).toBe("a character cut short at byte 0");
    expect(refusedWith(bytes(0xe2, 0x82, 0x61))).toBe("a character cut short at byte 0");
    expect(refusedWith(bytes(0xed, 0xa0))).toBe("a character cut short at byte 0");
    expect(refusedWith(bytes(0xf0, 0x9f, 0x98))).toBe("a character cut short at byte 0");
    expect(refusedWith(bytes(0xc0, 0x80))).toBe("a character written longer than it needs at byte 0");
    expect(refusedWith(bytes(0xc1, 0xbf))).toBe("a character written longer than it needs at byte 0");
    expect(refusedWith(bytes(0xe0, 0x9f, 0xbf))).toBe("a character written longer than it needs at byte 0");
    expect(refusedWith(bytes(0xf0, 0x8f, 0xbf, 0xbf))).toBe("a character written longer than it needs at byte 0");
    expect(refusedWith(bytes(0xf4, 0x90, 0x80, 0x80))).toBe("a character above U+10FFFF at byte 0");
    expect(refusedWith(bytes(0xf5, 0x80, 0x80, 0x80))).toBe("a character above U+10FFFF at byte 0");
    expect(refusedWith(bytes(0xf8, 0x80, 0x80, 0x80))).toBe("a byte UTF-8 never uses at byte 0");
    expect(refusedWith(bytes(0xff))).toBe("a byte UTF-8 never uses at byte 0");
  });

  it("decodes what the encoder writes, lone surrogates included", () => {
    const texts = ["", "ok", "�", "\u{1f600}", units(0xd800), units(0xdfff), units(0xdc00, 0xd800), `a${units(0xdbff)}\u{10ffff}${units(0xdc00)}`];
    for (const text of texts) {
      expect(wtf8Decode(wtf8Encode(text))).toBe(text);
    }
    expect([...wtf8Encode(units(0xd800))]).toStrictEqual([0xed, 0xa0, 0x80]);
    expect([...wtf8Encode("�")]).toStrictEqual([0xef, 0xbf, 0xbd]);
    expect(wtf8Encode("a\u{1f600}é")).toStrictEqual(Buffer.from("a\u{1f600}é", "utf8"));
  });

  it("decodes a string longer than one chunk of code units", () => {
    const text = `${"x".repeat(20_000)}${units(0xd800)}${"\u{1f600}".repeat(5_000)}`;
    expect(wtf8Decode(wtf8Encode(text))).toBe(text);
  });
});

describe("the viper judge's string values", () => {
  it("reads an answer exactly as the delivery returned it", () => {
    expect(decodeOutput(answered([0xed, 0xa0, 0x80]), 1)).toStrictEqual([{ verdict: "wrong", detail: units(0xd800) }]);
    expect(decodeOutput(answered([0xef, 0xbf, 0xbd]), 1)).toStrictEqual([{ verdict: "wrong", detail: "�" }]);
    expect(decodeOutput(answered([0xf0, 0x9f, 0x98, 0x80]), 1)).toStrictEqual([{ verdict: "wrong", detail: "\u{1f600}" }]);
  });

  it("refuses an answer that is not WTF-8 as a broken output", () => {
    for (const [value, why] of [
      [[0xff], "a byte UTF-8 never uses at byte 0"],
      [[0x61, 0x80], "a continuation byte that starts no character at byte 1"],
      [[0xed, 0xa0, 0x80, 0xed, 0xb0, 0x80], "a surrogate pair written as two triples at byte 0"],
    ] as const) {
      expect(() => decodeOutput(answered([...value]), 1)).toThrow(JudgeRefused);
      expect(() => decodeOutput(answered([...value]), 1)).toThrow(`the viper judge answered a string that is not WTF-8, with ${why}; nothing was paid`);
    }
  });

  it("reads a thrown message as the plain UTF-8 ViperJS documents", () => {
    expect(decodeOutput(thrown([0x45, 0xef, 0xbf, 0xbd]), 1)).toStrictEqual([{ verdict: "threw", detail: "E�" }]);
  });

  it("writes string arguments and expected answers as WTF-8", () => {
    const run = { seed: 1, clock: 0 };
    const input = encodeInput("", { steps: 1, heap: 1, seed: undefined, clock: undefined, cases: [{ args: ["�"], expected: units(0xd800) }] }, run);
    expect([...input.subarray(input.length - 16)]).toStrictEqual([5, 3, 0, 0, 0, 0xef, 0xbf, 0xbd, 5, 3, 0, 0, 0, 0xed, 0xa0, 0x80]);
  });
});
