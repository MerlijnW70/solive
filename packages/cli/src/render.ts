export { redactUrl } from "@intent-engine/client";

export function render(value: unknown): string {
  return JSON.stringify(
    value,
    (_, v: unknown) =>
      typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v,
    2,
  );
}

export const HIDDEN_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x61c, 0x61c],
  [0x200e, 0x200f],
  [0x2028, 0x202e],
  [0x2066, 0x2069],
];

const hidden = (code: number) => HIDDEN_RANGES.some(([low, high]) => code >= low && code <= high);

export const printable = (text: string): string =>
  Array.from(text, (c) => {
    const code = c.codePointAt(0) ?? 0;
    return hidden(code) ? `\\u${code.toString(16).padStart(4, "0")}` : c;
  }).join("");

export const printableLines = (text: string): string => text.split("\n").map(printable).join("\n");

const plain = (v: unknown): string =>
  printable(typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString("hex") : String(v));

const scalar = (v: unknown) => v === null || ["string", "number", "bigint", "boolean"].includes(typeof v);

export function renderText(value: object): string {
  const entries = Object.entries(value);
  const summary = entries.find(([k]) => k === "summary")?.[1];
  const lines = Array.isArray(summary) ? summary.map(plain) : [];
  const warnings = entries.find(([k]) => k === "warnings")?.[1];
  for (const warning of Array.isArray(warnings) ? warnings.map((w) => `WARNING: ${plain(w)}`) : []) {
    if (!lines.includes(warning)) {
      lines.push(warning);
    }
  }
  for (const [key, v] of entries) {
    if (key === "summary" || (key === "warnings" && Array.isArray(warnings))) {
      continue;
    }
    if (scalar(v)) {
      lines.push(`${printable(key)}: ${plain(v)}`);
    } else if (Array.isArray(v) && v.every(scalar)) {
      lines.push(`${printable(key)}: ${v.length === 0 ? "none" : v.map(plain).join(", ")}`);
    } else {
      lines.push(`${printable(key)}: ${printable(JSON.stringify(v, (_, x: unknown) => (typeof x === "bigint" ? x.toString() : x)))}`);
    }
  }
  return lines.join("\n");
}
