import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

export const FALLBACK = "INTENT_ENGINE_ROOT";
export const ENGINE_FALLBACK = "INTENT_ENGINE_SO";

const ERASED = /^\s*(?:import|export)\s+type\b/;
const SOURCE = /\.(?:ts|mts|cts|js|mjs|cjs)$/;
const SKIPPED = new Set(["node_modules", "dist", ".git"]);
const LITERAL = /(["'`])((?:\.\.)(?:\/\.\.)*)(?:\/[^"'`\n]*)?\1/g;
const CALL = /\b(?:join|resolve)\s*\(/g;
const FALLBACK_OPERAND = /INTENT_ENGINE_(?:ROOT|SO)["']\]\s*\?\?[^;,\n]*$/;
const NAMES_FALLBACK = /INTENT_ENGINE_(?:ROOT|SO)/;
const WHOLE_LITERAL = /^(["'`])([^"'`]*)\1$/;
const TAKES_ROOT = /\$\{1:-\}|\$1\b/;
const EXPORTS_ROOT = /^\s*export\s+INTENT_ENGINE_ROOT=/m;

export interface Escape {
  file: string;
  line: number;
  text: string;
}

interface Argument {
  text: string;
  start: number;
}

interface Call {
  args: Argument[];
}

function argumentsOf(text: string, open: number): Call {
  const args: Argument[] = [];
  let depth = 1;
  let quote = "";
  let start = open + 1;
  for (let i = open + 1; i < text.length && depth > 0; i += 1) {
    const ch = text.charAt(i);
    if (quote !== "") {
      if (ch === "\\") {
        i += 1;
      } else if (ch === quote) {
        quote = "";
      }
    } else if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
    } else if (ch === "(" || ch === "[" || ch === "{") {
      depth += 1;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) {
        args.push({ text: text.slice(start, i), start });
      }
    } else if (ch === "," && depth === 1) {
      args.push({ text: text.slice(start, i), start });
      start = i + 1;
    }
  }
  return { args };
}

export function climbs(text: string): number {
  let most = 0;
  for (const found of text.matchAll(LITERAL)) {
    most = Math.max(most, (found[2] ?? "").split("/").length);
  }
  for (const found of text.matchAll(CALL)) {
    most = Math.max(most, joined(argumentsOf(text, found.index + found[0].length - 1)).up);
  }
  return most;
}

function joined(call: Call): { up: number; literals: Set<number> } {
  const stack: string[] = [];
  const literals = new Set<number>();
  let up = 0;
  for (const arg of call.args) {
    const trimmed = arg.text.trim();
    const whole = WHOLE_LITERAL.exec(trimmed);
    if (whole === null || (whole[2] ?? "").includes("${")) {
      continue;
    }
    literals.add(arg.start + arg.text.length - arg.text.trimStart().length);
    for (const segment of (whole[2] ?? "").split("/")) {
      if (segment === "..") {
        if (stack.length > 0) {
          stack.pop();
        } else {
          up += 1;
        }
      } else if (segment !== "" && segment !== ".") {
        stack.push(segment);
      }
    }
  }
  return { up, literals };
}

function walk(dir: string, into: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) {
      continue;
    }
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path, into);
    } else if (SOURCE.test(entry.name)) {
      into.push(path);
    }
  }
}

export function checkedFiles(packageDir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(packageDir, { withFileTypes: true })) {
    if (entry.isFile() && /^vitest\..*\.(?:ts|mts|js|mjs)$/.test(entry.name)) {
      found.push(join(packageDir, entry.name));
    }
  }
  try {
    walk(join(packageDir, "test"), found);
  } catch {
    return found;
  }
  return found;
}

function operandOfFallback(text: string, at: number): boolean {
  const lineStart = text.lastIndexOf("\n", at - 1) + 1;
  const prefix = text.slice(lineStart, at);
  if (FALLBACK_OPERAND.test(prefix)) {
    return true;
  }
  const before = text.slice(text.lastIndexOf("\n", lineStart - 2) + 1, Math.max(lineStart - 1, 0)).trimEnd();
  return before.endsWith("??") && NAMES_FALLBACK.test(before) && !/[;,]/.test(prefix);
}

export function escapesIn(packageDir: string, file: string, text: string): Escape[] {
  const depth = relative(packageDir, file).split(sep).length - 1;
  const lines = text.split("\n");
  const out: Escape[] = [];
  const seen = new Set<number>();
  const report = (at: number): void => {
    const line = text.slice(0, at).split("\n").length;
    if (seen.has(line) || ERASED.test(lines[line - 1] ?? "")) {
      return;
    }
    seen.add(line);
    out.push({ file, line, text: (lines[line - 1] ?? "").trim() });
  };
  const direct = new Set<number>();
  for (const found of text.matchAll(CALL)) {
    const call = argumentsOf(text, found.index + found[0].length - 1);
    const { up, literals } = joined(call);
    for (const at of literals) {
      direct.add(at);
    }
    if (up > depth && !operandOfFallback(text, found.index)) {
      report(found.index);
    }
  }
  for (const found of text.matchAll(LITERAL)) {
    const count = (found[2] ?? "").split("/").length;
    if (count > depth && !direct.has(found.index) && !operandOfFallback(text, found.index)) {
      report(found.index);
    }
  }
  return out.sort((a, b) => a.line - b.line);
}

export function missesRootExport(script: string): boolean {
  return TAKES_ROOT.test(script) && !EXPORTS_ROOT.test(script);
}

export function escapesOf(root: string): Escape[] {
  const packages = join(root, "packages");
  const out: Escape[] = [];
  for (const entry of readdirSync(packages, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = join(packages, entry.name);
    for (const file of checkedFiles(dir)) {
      out.push(...escapesIn(dir, file, readFileSync(file, "utf8")));
    }
    const script = join(dir, "scripts", "test.sh");
    if (existsSync(script) && missesRootExport(readFileSync(script, "utf8"))) {
      out.push({ file: script, line: 1, text: "takes the repo root but does not export " + FALLBACK });
    }
  }
  return out;
}
