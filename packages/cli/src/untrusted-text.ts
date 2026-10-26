const HIDDEN_CLASS = "[\\p{Cc}\\p{Cf}\\p{Cs}\\p{Co}\\p{Cn}\\p{Zl}\\p{Zp}]";

const HIDDEN_ONE = new RegExp(`^${HIDDEN_CLASS}$`, "u");
const HIDDEN_EACH = new RegExp(HIDDEN_CLASS, "gu");
const HIDDEN_RUNS = new RegExp(`${HIDDEN_CLASS}+`, "gu");

export const SANITIZED_LIMIT = 300;

export const CUT_MARK = " [cut]";

export const isHidden = (char: string): boolean => HIDDEN_ONE.test(char);

export const hasHidden = (text: string): boolean => new RegExp(HIDDEN_CLASS, "u").test(text);

const escapeOf = (char: string): string =>
  Array.from({ length: char.length }, (_, at) => `\\u${char.charCodeAt(at).toString(16).padStart(4, "0")}`).join("");

export function sanitized(text: string, limit: number = SANITIZED_LIMIT): string {
  const reduced = text.replace(HIDDEN_RUNS, " ");
  const chars = Array.from(reduced);
  return chars.length <= limit ? reduced : `${chars.slice(0, Math.max(0, limit - CUT_MARK.length)).join("")}${CUT_MARK}`;
}

export const escaped = (text: string): string => text.replace(HIDDEN_EACH, escapeOf);

export const escapedLines = (text: string): string => text.split("\n").map(escaped).join("\n");

export const escapedJson = (json: string): string => json.replace(HIDDEN_EACH, (char) => (char === "\n" ? char : escapeOf(char)));
