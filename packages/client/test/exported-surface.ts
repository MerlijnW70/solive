import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type Declared = { name: string; file: string; kind: "function" | "arrow" | "class" | "type" | "value" };

export type ReturnFinding = { name: string; file: string; returns: string; problem: string };

export type Packages = Readonly<Record<string, string>>;

const BUILTIN_TYPES = new Set([
  "Promise",
  "Uint8Array",
  "Array",
  "ReadonlyArray",
  "Readonly",
  "Record",
  "Partial",
  "Pick",
  "Omit",
  "Map",
  "Set",
  "ReadonlyMap",
  "ReadonlySet",
  "Error",
  "Exclude",
  "Extract",
  "NonNullable",
  "ArrayBuffer",
  "Response",
  "AbortSignal",
  "AsyncIterable",
  "Iterable",
]);

const PAIRS: Readonly<Record<string, string>> = { "(": ")", "<": ">", "[": "]", "{": "}" };

function closing(text: string, at: number): number {
  const open = text[at] ?? "";
  const close = PAIRS[open] ?? "";
  let depth = 0;
  for (let i = at; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      i = text.indexOf(c, i + 1);
      continue;
    }
    if (c === ">" && text[i - 1] === "=") {
      continue;
    }
    if (c === open) {
      depth += 1;
    } else if (c === close) {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function annotation(text: string, at: number, stop: "{" | "=>"): string | null {
  let i = at;
  while (/\s/.test(text[i] ?? "")) {
    i += 1;
  }
  if (text[i] !== ":") {
    return null;
  }
  const start = i + 1;
  for (i = start; i < text.length; i += 1) {
    const c = text[i] ?? "";
    if (stop === "=>" && c === "=" && text[i + 1] === ">") {
      return text.slice(start, i).trim();
    }
    if (stop === "{" && (c === "{" || c === ";")) {
      return text.slice(start, i).trim();
    }
    if (c === "(" || c === "<" || c === "[" || (stop === "=>" && c === "{")) {
      i = closing(text, i);
    }
  }
  return null;
}

function generics(text: string, at: number): { names: string[]; end: number } {
  let i = at;
  while (/\s/.test(text[i] ?? "")) {
    i += 1;
  }
  if (text[i] !== "<") {
    return { names: [], end: i };
  }
  const end = closing(text, i);
  const inner = text.slice(i + 1, end);
  const names = [...inner.matchAll(/(?:^|,)\s*([A-Z][A-Za-z0-9_]*)/g)].map((m) => m[1] ?? "");
  return { names, end: end + 1 };
}

export function surface(entry: string, packages: Packages): { declared: Map<string, Declared>; names: Set<string> } {
  const declared = new Map<string, Declared>();
  const names = new Set<string>();
  const visit = (file: string, only: Map<string, string> | null): void => {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/^export \* from "([^"]+)";/gm)) {
      const target = moduleFile(file, m[1] ?? "", packages);
      if (target !== null) {
        visit(target, only);
      }
    }
    for (const m of text.matchAll(/^export (?:type )?\{([^}]*)\}(?: from "([^"]+)")?;/gm)) {
      const target = m[2] === undefined ? file : moduleFile(file, m[2], packages);
      if (target === null) {
        continue;
      }
      const picked = new Map<string, string>();
      for (const part of (m[1] ?? "").split(",")) {
        const [from, as] = part.replace(/^\s*type\s+/, "").trim().split(/\s+as\s+/);
        if (from === undefined || from === "") {
          continue;
        }
        const outer = as ?? from;
        if (only === null || only.has(outer)) {
          picked.set(from, only?.get(outer) ?? outer);
        }
      }
      if (picked.size > 0 && target !== file) {
        visit(target, picked);
      }
      for (const [from, outer] of picked) {
        if (target === file) {
          names.add(outer);
          declared.set(outer, declared.get(from) ?? { name: from, file, kind: "value" });
        }
      }
    }
    for (const m of text.matchAll(/^export (async function|function|const|let|class|abstract class|type|interface|enum) ([A-Za-z0-9_]+)/gm)) {
      const local = m[2] ?? "";
      if (only !== null && !only.has(local)) {
        continue;
      }
      const word = m[1] ?? "";
      const outer = only?.get(local) ?? local;
      const kind = word.includes("function") ? "function" : word.includes("class") ? "class" : word === "const" || word === "let" ? "arrow" : word === "enum" ? "value" : "type";
      names.add(outer);
      declared.set(outer, { name: local, file, kind });
    }
  };
  visit(entry, null);
  return { declared, names };
}

function moduleFile(from: string, specifier: string, packages: Packages): string | null {
  const root = packages[specifier];
  if (root !== undefined) {
    return root;
  }
  if (!specifier.startsWith(".")) {
    return null;
  }
  const file = resolve(dirname(from), specifier.replace(/\.js$/, ".ts"));
  return existsSync(file) ? file : null;
}

function importedNames(text: string): Set<string> {
  const found = new Set<string>();
  for (const m of text.matchAll(/^import (?:type )?\{([^}]*)\} from "([^"]+)";/gm)) {
    if ((m[2] ?? "").startsWith(".")) {
      continue;
    }
    for (const part of (m[1] ?? "").split(",")) {
      const name = part.replace(/^\s*type\s+/, "").trim().split(/\s+as\s+/).pop();
      if (name !== undefined && name !== "") {
        found.add(name);
      }
    }
  }
  return found;
}

function judged(returns: string | null, scope: Set<string>, names: Set<string>): string | null {
  if (returns === null || returns === "") {
    return "has no return type annotation";
  }
  const bare = returns.replace(/"[^"]*"|'[^']*'|`[^`]*`/g, "");
  if (bare.includes("{")) {
    return "returns an anonymous object type";
  }
  if (bare.includes("=>")) {
    return "returns an anonymous function type";
  }
  for (const m of bare.matchAll(/\b[A-Z][A-Za-z0-9_]*\b/g)) {
    const name = m[0];
    if (!BUILTIN_TYPES.has(name) && !scope.has(name) && !names.has(name)) {
      return `returns ${name}, which is not exported`;
    }
  }
  return null;
}

function methodsOf(body: string): { name: string; at: number }[] {
  const found: { name: string; at: number }[] = [];
  for (const m of body.matchAll(/^ {2}((?:static |override |async |get |set |public )*)([A-Za-z_][A-Za-z0-9_]*)\s*[<(]/gm)) {
    const name = m[2] ?? "";
    if (name !== "constructor" && !/(^|\s)set\s$/.test(m[1] ?? "")) {
      found.push({ name, at: (m.index ?? 0) + (m[0]?.length ?? 1) - 1 });
    }
  }
  return found;
}

export function returnFindings(entry: string, packages: Packages): ReturnFinding[] {
  const { declared, names } = surface(entry, packages);
  const findings: ReturnFinding[] = [];
  for (const [outer, { name, file, kind }] of declared) {
    if (kind === "type" || kind === "value") {
      continue;
    }
    const text = readFileSync(file, "utf8");
    const imports = importedNames(text);
    const report = (returns: string | null, scope: Set<string>, label: string) => {
      const problem = judged(returns, scope, names);
      if (problem !== null) {
        findings.push({ name: label, file, returns: returns ?? "", problem });
      }
    };
    if (kind === "function") {
      for (const head of text.matchAll(new RegExp(`^export (?:async )?function ${name}\\b`, "gm"))) {
        const typeParams = generics(text, head.index + head[0].length);
        const params = closing(text, typeParams.end);
        report(annotation(text, params + 1, "{"), new Set([...imports, ...typeParams.names]), outer);
      }
    } else if (kind === "arrow") {
      const head = new RegExp(`^export (?:const|let) ${name}\\s*(:[^=]+)?=\\s*(async\\s*)?`, "m").exec(text);
      if (head === null || head[1] !== undefined) {
        continue;
      }
      const typeParams = generics(text, head.index + head[0].length);
      if (text[typeParams.end] !== "(") {
        continue;
      }
      const params = closing(text, typeParams.end);
      report(annotation(text, params + 1, "=>"), new Set([...imports, ...typeParams.names]), outer);
    } else {
      const head = new RegExp(`^export (?:abstract )?class ${name}\\b[^{]*`, "m").exec(text);
      if (head === null) {
        continue;
      }
      const open = head.index + head[0].length;
      const typeParams = generics(text, head.index + head[0].indexOf(name) + name.length);
      const body = text.slice(open, closing(text, open) + 1);
      for (const method of methodsOf(body)) {
        const own = generics(body, method.at);
        const params = closing(body, own.end);
        report(annotation(body, params + 1, "{"), new Set([...imports, ...typeParams.names, ...own.names]), `${outer}.${method.name}`);
      }
    }
  }
  return findings;
}

export const clientRoot = (here: string): { entry: string; packages: Packages } => ({
  entry: join(here, "..", "src", "index.ts"),
  packages: { "@intent-engine/core": join(here, "..", "..", "core", "src", "index.ts") },
});
