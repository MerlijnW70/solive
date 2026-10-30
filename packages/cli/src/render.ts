import { escaped, escapedJson, escapedLines } from "./untrusted-text.js";

export { redactUrl } from "@intent-engine/client/internal";

export function render(value: unknown): string {
  return escapedJson(
    JSON.stringify(
      value,
      (_, v: unknown) =>
        typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString("hex") : v,
      2,
    ),
  );
}

export const printable = escaped;

export const printableLines = escapedLines;

const plain = (v: unknown): string =>
  printable(typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString("hex") : String(v));

const field = (value: object, key: string): unknown => (value as Record<string, unknown>)[key];

const walletLine = (setup: unknown): string => {
  if (setup === undefined) {
    return "Wallet setup was skipped; run intent-engine setup when you want a wallet.";
  }
  const done: { failed?: unknown; sol?: unknown; next?: unknown; other_ways?: unknown } = setup !== null && typeof setup === "object" ? setup : {};
  if (typeof done.failed === "string") {
    return `Wallet setup did not finish (${done.failed}); run intent-engine setup again.`;
  }
  if (typeof done.sol !== "string" || done.sol === "0" || done.other_ways !== undefined) {
    return typeof done.next === "string" ? done.next : "Your wallet is not funded yet; run intent-engine setup again.";
  }
  return `Your wallet holds ${done.sol} SOL.`;
};

export function addToLines(value: object): string {
  const app = String(field(value, "to"));
  const slug = String(field(value, "added") ?? field(value, "already"));
  const server = field(value, "added") === undefined ? `${slug} was already added to ${app}.` : `${slug} was added to ${app}.`;
  const start = `Restart ${app}, then type "set me up and make my first swap"${app === "Claude Code" ? ` or /${slug}:start` : ""}.`;
  return [server, walletLine(field(value, "setup")), start].map(printable).join("\n");
}

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
