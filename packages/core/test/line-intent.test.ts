import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getAddressDecoder } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { ACCOUNT_LAYOUTS, lineIntent } from "../src/internal.js";

type LineCase = { case: string; account: string; length: number | null; intentAt: number; named: boolean };

const TABLE = JSON.parse(readFileSync(fileURLToPath(new URL("./golden/line-intent.json", import.meta.url)), "utf8")) as LineCase[];
const MARK = new Uint8Array(32).fill(7);
const NO_ENGINE = { discriminator: new Uint8Array(8), space: 72 };

function dataOf(row: LineCase): Uint8Array {
  const layout = row.account === "none" ? NO_ENGINE : ACCOUNT_LAYOUTS.find((l) => l.name === row.account);
  if (layout === undefined) throw new Error(row.account);
  const data = new Uint8Array(layout.space);
  data.set(layout.discriminator, 0);
  data.set(MARK, 8 + row.intentAt);
  return data.slice(0, row.length ?? layout.space);
}

describe("lineIntent against the table the Rust line_intent test reads", () => {
  it("covers a claim board, a claim list and a stand-by entry, each whole, cut at its field and one byte short", () => {
    const named = TABLE.filter((row) => row.named).map((row) => row.account);
    expect(new Set(named)).toEqual(new Set(["claim board", "claim list", "stand-by entry"]));
    expect(TABLE.filter((row) => !row.named && row.length !== null).map((row) => row.account)).toEqual(expect.arrayContaining(["claim board", "claim list", "stand-by entry"]));
  });

  it.each(TABLE)("$case", (row) => {
    expect(lineIntent(dataOf(row))).toBe(row.named ? getAddressDecoder().decode(MARK) : null);
  });
});
