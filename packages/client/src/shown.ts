const DEPTH = 8;
const BARE_KEY = /^[A-Za-z_$][\w$]*$/;

const quoted = (text: string): string => `'${text.replaceAll("\\", "\\\\").replaceAll("'", "\\'").replaceAll("\n", "\\n")}'`;

function shownAt(value: unknown, depth: number, seen: ReadonlySet<object>): string {
  if (typeof value === "string") {
    return quoted(value);
  }
  if (typeof value === "bigint") {
    return `${value}n`;
  }
  if (value === null || typeof value !== "object") {
    return String(value);
  }
  if (seen.has(value)) {
    return "[Circular]";
  }
  const inner = new Set([...seen, value]);
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return "[]";
    }
    return depth >= DEPTH ? "[Array]" : `[ ${value.map((item) => shownAt(item, depth + 1, inner)).join(", ")} ]`;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return "{}";
  }
  if (depth >= DEPTH) {
    return "[Object]";
  }
  return `{ ${entries.map(([key, item]) => `${BARE_KEY.test(key) ? key : quoted(key)}: ${shownAt(item, depth + 1, inner)}`).join(", ")} }`;
}

export function shown(value: unknown): string {
  return shownAt(value, 0, new Set());
}
