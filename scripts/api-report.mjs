import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const write = args.includes("--write");
const at = args.indexOf("--root");
const root = resolve(at >= 0 ? (args[at + 1] ?? ".") : ".");
const unknown = args.filter((arg, i) => arg !== "--write" && arg !== "--root" && args[i - 1] !== "--root");
if (unknown.length > 0) {
  console.error(`usage: bash scripts/api-report.sh [--write] [--root <dir>]; unknown argument ${unknown.join(" ")}`);
  process.exit(2);
}

const PACKAGES = ["core", "client"];
const ENTRY = "dist/src/index.d.ts";
const REPORT = "api-report.txt";
const BLOCK_KINDS = new Set(["class", "interface", "enum", "namespace"]);
const NAME = "[A-Za-z_$][\\w$]*";
const DECLARATION = new RegExp(`^(export )?(?:declare )?(?:abstract )?(function|const|let|class|type|interface|enum|namespace) (${NAME})`, "gm");

const entryOf = (name) => join(root, "packages", name, ENTRY);
const workspace = new Map(PACKAGES.map((name) => [`@intent-engine/${name}`, entryOf(name)]));

function stripped(text) {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
      continue;
    }
    if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      i = (end < 0 ? text.length : end) - 1;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) {
        j += text[j] === "\\" ? 2 : 1;
      }
      out += text.slice(i, j + 1);
      i = j;
      continue;
    }
    out += c;
  }
  return out;
}

const files = new Map();

function fileOf(path) {
  const known = files.get(path);
  if (known !== undefined) {
    return known;
  }
  if (!existsSync(path)) {
    throw new Error(`${path} does not exist; build the packages first`);
  }
  const text = stripped(readFileSync(path, "utf8"));
  const parsed = { path, text, declarations: new Map(), imports: new Map(), lists: [], stars: [] };
  for (const m of text.matchAll(DECLARATION)) {
    const statement = statementAt(text, m.index, m[2]);
    const list = parsed.declarations.get(m[3]) ?? [];
    list.push({ exported: m[1] !== undefined, kind: m[2] === "let" ? "const" : m[2], text: statement });
    parsed.declarations.set(m[3], list);
  }
  for (const m of text.matchAll(/^import (?:type )?\{([^}]*)\} from "([^"]+)";/gm)) {
    for (const [name, local] of pairs(m[1])) {
      parsed.imports.set(local, { from: m[2], name });
    }
  }
  for (const m of text.matchAll(/^export (?:type )?\{([^}]*)\}(?: from "([^"]+)")?;/gm)) {
    parsed.lists.push({ from: m[2], names: pairs(m[1]) });
  }
  for (const m of text.matchAll(/^export \* (?:as (\S+) )?from "([^"]+)";/gm)) {
    parsed.stars.push({ as: m[1], from: m[2] });
  }
  files.set(path, parsed);
  return parsed;
}

function pairs(list) {
  return list
    .split(",")
    .map((part) => part.replace(/^\s*type\s+/, "").trim())
    .filter((part) => part !== "")
    .map((part) => {
      const [name, as] = part.split(/\s+as\s+/);
      return [name, as ?? name];
    });
}

function statementAt(text, start, kind) {
  let depth = 0;
  let opened = false;
  for (let i = start; i < text.length; i += 1) {
    const c = text[i];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) {
        j += text[j] === "\\" ? 2 : 1;
      }
      i = j;
    } else if (c === "(" || c === "[" || c === "{") {
      depth += 1;
      opened ||= c === "{" && depth === 1;
    } else if (c === ")" || c === "]" || c === "}") {
      depth -= 1;
      if (depth === 0 && c === "}" && opened && BLOCK_KINDS.has(kind)) {
        return text.slice(start, i + 1);
      }
    } else if (c === ";" && depth === 0) {
      return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

function target(from, specifier) {
  const known = workspace.get(specifier);
  if (known !== undefined) {
    return known;
  }
  if (!specifier.startsWith(".")) {
    return null;
  }
  return resolve(dirname(from), specifier.replace(/\.js$/, ".d.ts"));
}

function locate(path, name, seen = new Set()) {
  const key = `${path}#${name}`;
  if (seen.has(key)) {
    return null;
  }
  seen.add(key);
  const file = fileOf(path);
  const own = (file.declarations.get(name) ?? []).filter((d) => d.exported);
  if (own.length > 0) {
    return { key, declarations: own };
  }
  for (const list of file.lists) {
    const hit = list.names.find(([, as]) => as === name);
    if (hit === undefined) {
      continue;
    }
    if (list.from === undefined) {
      const local = file.declarations.get(hit[0]) ?? [];
      return local.length > 0 ? { key: `${path}#${hit[0]}`, declarations: local } : null;
    }
    const next = target(path, list.from);
    return next === null ? { key: `${list.from}#${hit[0]}`, external: true } : locate(next, hit[0], seen);
  }
  for (const star of file.stars) {
    const next = target(path, star.from);
    if (star.as === name) {
      return { key: `${next}#*`, namespace: next };
    }
    if (star.as === undefined && next !== null) {
      const found = locate(next, name, seen);
      if (found !== null) {
        return found;
      }
    }
  }
  return null;
}

function exportedNames(path, seen = new Set()) {
  if (seen.has(path)) {
    return [];
  }
  seen.add(path);
  const file = fileOf(path);
  const names = new Set([...file.declarations].filter(([, list]) => list.some((d) => d.exported)).map(([name]) => name));
  for (const list of file.lists) {
    for (const [, as] of list.names) {
      names.add(as);
    }
  }
  for (const star of file.stars) {
    if (star.as !== undefined) {
      names.add(star.as);
    } else {
      const next = target(path, star.from);
      for (const name of next === null ? [] : exportedNames(next, seen)) {
        names.add(name);
      }
    }
  }
  return [...names].sort();
}

const flat = (text) => text.replace(/\s+/g, " ").replace(/^export /, "").replace(/^declare /, "").trim();

function lines(path, prefix) {
  const out = [];
  for (const name of exportedNames(path)) {
    const found = locate(path, name);
    if (found === null) {
      out.push(`unresolved ${prefix}${name}`);
    } else if (found.namespace !== undefined) {
      out.push(`namespace ${prefix}${name}`, ...lines(found.namespace, `${prefix}${name}.`));
    } else if (found.external === true) {
      out.push(`external ${prefix}${name}: ${found.key}`);
    } else {
      for (const declaration of found.declarations) {
        out.push(`${declaration.kind} ${prefix}${name}: ${flat(declaration.text)}`);
      }
    }
  }
  return out;
}

function rootKeys() {
  const keys = new Set();
  const visit = (path) => {
    for (const name of exportedNames(path)) {
      const found = locate(path, name);
      if (found !== null) {
        keys.add(found.key);
        if (found.namespace !== undefined) {
          visit(found.namespace);
        }
      }
    }
  };
  for (const path of workspace.values()) {
    visit(path);
  }
  return keys;
}

function unexported(path, keys, prefix = "") {
  const problems = [];
  for (const name of exportedNames(path)) {
    const found = locate(path, name);
    if (found === null || found.external === true) {
      continue;
    }
    if (found.namespace !== undefined) {
      problems.push(...unexported(found.namespace, keys, `${prefix}${name}.`));
      continue;
    }
    const home = found.key.slice(0, found.key.lastIndexOf("#"));
    const file = fileOf(home);
    const named = new Set();
    for (const declaration of found.declarations) {
      const bare = declaration.text
        .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""')
        .replace(new RegExp(`\\btypeof ${NAME}|\\[${NAME}\\](?=\\??:| =|\\()`, "g"), "");
      for (const m of bare.matchAll(new RegExp(`(?<![\\w$.])${NAME}(?![\\w$]|\\??:|\\()`, "g"))) {
        named.add(m[0]);
      }
      for (const m of declaration.text.matchAll(new RegExp(`import\\("([^"]+)"\\)\\.(${NAME})`, "g"))) {
        const next = target(home, m[1]);
        const hit = next === null ? null : locate(next, m[2]);
        if (next !== null && (hit === null || !keys.has(hit.key))) {
          problems.push(`${prefix}${name} names ${m[2]} from ${m[1]}, which no package root exports`);
        }
      }
    }
    for (const word of named) {
      const imported = file.imports.get(word);
      let hit;
      if (imported !== undefined) {
        const next = target(home, imported.from);
        if (next === null) {
          continue;
        }
        hit = locate(next, imported.name);
      } else if (file.declarations.has(word)) {
        hit = locate(home, word) ?? { key: `${home}#${word}` };
      } else {
        continue;
      }
      if (hit === null || !keys.has(hit.key)) {
        problems.push(`${prefix}${name} names ${word}, which no package root exports`);
      }
    }
  }
  return problems;
}

const problems = [];
const keys = rootKeys();
for (const name of PACKAGES) {
  const report = `${lines(entryOf(name), "").join("\n")}\n`;
  const file = join(root, "packages", name, REPORT);
  problems.push(...unexported(entryOf(name), keys).map((line) => `@intent-engine/${name}: ${line}`));
  if (write) {
    writeFileSync(file, report);
    console.log(`wrote packages/${name}/${REPORT}`);
    continue;
  }
  const committed = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (committed !== report) {
    const before = committed.split("\n").filter((line) => line !== "");
    const after = report.split("\n").filter((line) => line !== "");
    problems.push(
      [
        `the exports of @intent-engine/${name} differ from packages/${name}/${REPORT}:`,
        ...after.filter((line) => !before.includes(line)).map((line) => `  + ${line}`),
        ...before.filter((line) => !after.includes(line)).map((line) => `  - ${line}`),
        "review the change to the public API, then run bash scripts/api-report.sh --write",
      ].join("\n"),
    );
  }
}
if (problems.length > 0) {
  console.error(problems.join("\n"));
  console.error("api report check failed");
  process.exit(1);
}
console.log(`api report ${write ? "written" : "check passed"}: ${PACKAGES.map((name) => `@intent-engine/${name}`).join(", ")}`);
