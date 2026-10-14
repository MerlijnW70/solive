import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";

const write = process.argv.slice(2).includes("--write");
const unknown = process.argv.slice(2).filter((arg) => arg !== "--write");
if (unknown.length > 0) {
  console.error(`usage: bash scripts/supply-chain.sh [--write]; unknown argument ${unknown.join(" ")}`);
  process.exit(2);
}

const EXACT = /^(workspace:\*|\d+\.\d+\.\d+)$/;
const PROD = ["dependencies", "optionalDependencies"];
const HOOKS = ["preinstall", "install", "postinstall"];
const problems = [];

const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

const published = readdirSync("packages")
  .filter((dir) => existsSync(join("packages", dir, "package.json")))
  .map((dir) => ({ dir, manifest: readJson(join("packages", dir, "package.json")) }))
  .filter(({ manifest }) => manifest.private !== true)
  .sort((a, b) => a.dir.localeCompare(b.dir));

for (const { manifest } of published) {
  for (const field of PROD) {
    for (const [name, range] of Object.entries(manifest[field] ?? {})) {
      if (!EXACT.test(range)) {
        problems.push(`${manifest.name} ${field} pins ${name} to "${range}"; every dependency of a published package must be an exact version or workspace:*`);
      }
    }
  }
}

const unquote = (text) => (text.startsWith("'") && text.endsWith("'") ? text.slice(1, -1).replaceAll("''", "'") : text);

const entry = (line) => {
  const m = /^( *)('(?:[^']|'')*'|[^\s:'][^:]*?):(?: (.*))?$/.exec(line);
  return m === null ? undefined : { indent: m[1].length, key: unquote(m[2]), value: m[3] === undefined ? undefined : unquote(m[3].trim()) };
};

const parseLock = () => {
  const importers = new Map();
  const snapshots = new Map();
  let section = "";
  let owner;
  let group;
  let name;
  for (const line of readFileSync("pnpm-lock.yaml", "utf8").split("\n")) {
    const e = entry(line);
    if (e === undefined) {
      continue;
    }
    if (e.indent === 0) {
      section = e.key;
      continue;
    }
    const table = section === "importers" ? importers : section === "snapshots" ? snapshots : undefined;
    if (table === undefined) {
      continue;
    }
    if (e.indent === 2) {
      owner = new Map();
      table.set(e.key, owner);
    } else if (e.indent === 4) {
      group = new Map();
      owner.set(e.key, group);
    } else if (e.indent === 6 && section === "snapshots") {
      group.set(e.key, e.value);
    } else if (e.indent === 6) {
      name = e.key;
    } else if (e.indent === 8 && e.key === "version") {
      group.set(name, e.value);
    }
  }
  return { importers, snapshots };
};

const lock = parseLock();

const productionTree = (importer) => {
  const seen = new Set();
  const out = new Set();
  const visit = (from, deps) => {
    for (const [name, version] of deps) {
      if (version.startsWith("link:")) {
        const target = posix.normalize(posix.join(from, version.slice(5)));
        if (!seen.has(`importer ${target}`)) {
          seen.add(`importer ${target}`);
          visitImporter(target);
        }
        continue;
      }
      const id = /^@?[^@(]+@/.test(version) ? version : `${name}@${version}`;
      out.add(id.replace(/\(.*$/, ""));
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      const snapshot = lock.snapshots.get(id);
      if (snapshot === undefined) {
        problems.push(`pnpm-lock.yaml has no snapshot for ${id}`);
        continue;
      }
      for (const field of PROD) {
        visit(from, snapshot.get(field) ?? new Map());
      }
    }
  };
  const visitImporter = (path) => {
    const deps = lock.importers.get(path);
    if (deps === undefined) {
      problems.push(`pnpm-lock.yaml has no importer ${path}`);
      return;
    }
    for (const field of PROD) {
      visit(path, deps.get(field) ?? new Map());
    }
  };
  seen.add(`importer ${importer}`);
  visitImporter(importer);
  return [...out].sort();
};

if (write) {
  mkdirSync("supply-chain", { recursive: true });
}
for (const { dir, manifest } of published) {
  const tree = productionTree(`packages/${dir}`);
  const file = `supply-chain/${dir}.txt`;
  if (write) {
    writeFileSync(file, `${tree.join("\n")}\n`);
    console.log(`wrote ${file}: ${tree.length} packages`);
    continue;
  }
  const committed = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((line) => line !== "") : [];
  const added = tree.filter((line) => !committed.includes(line));
  const removed = committed.filter((line) => !tree.includes(line));
  if (added.length > 0 || removed.length > 0) {
    problems.push(
      [
        `the production tree of ${manifest.name} differs from ${file}:`,
        ...added.map((line) => `  + ${line}`),
        ...removed.map((line) => `  - ${line}`),
        "review every added and removed package, then rerun with --write: bash scripts/supply-chain.sh --write",
      ].join("\n"),
    );
  }
}

const listed = (key) => {
  const lines = readFileSync("pnpm-workspace.yaml", "utf8").split("\n");
  const start = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (start === -1) {
    return new Set();
  }
  const names = new Set();
  for (const line of lines.slice(start + 1)) {
    const m = /^\s+-\s+(.+?)\s*$/.exec(line);
    if (m === null) {
      break;
    }
    names.add(unquote(m[1].replace(/^"(.*)"$/, "$1")));
  }
  return names;
};

const allowed = listed("onlyBuiltDependencies");
const ignored = listed("ignoredBuiltDependencies");
for (const name of allowed) {
  if (ignored.has(name)) {
    problems.push(`pnpm-workspace.yaml lists ${name} in both onlyBuiltDependencies and ignoredBuiltDependencies`);
  }
}

const store = join("node_modules", ".pnpm");
if (!existsSync(store)) {
  problems.push("node_modules/.pnpm is missing; run pnpm install --frozen-lockfile first");
} else {
  const builders = new Map();
  const inspect = (path) => {
    const manifestPath = join(path, "package.json");
    if (!lstatSync(path).isDirectory() || !existsSync(manifestPath)) {
      return;
    }
    const manifest = readJson(manifestPath);
    const scripts = manifest.scripts ?? {};
    const hooks = HOOKS.filter((hook) => typeof scripts[hook] === "string");
    if (hooks.length === 0 && existsSync(join(path, "binding.gyp"))) {
      hooks.push("install (binding.gyp)");
    }
    if (hooks.length > 0) {
      builders.set(`${manifest.name}@${manifest.version}`, { name: manifest.name, hooks });
    }
  };
  for (const id of readdirSync(store)) {
    const modules = join(store, id, "node_modules");
    if (!existsSync(modules)) {
      continue;
    }
    for (const name of readdirSync(modules)) {
      const path = join(modules, name);
      if (lstatSync(path).isSymbolicLink()) {
        continue;
      }
      if (name.startsWith("@")) {
        for (const scoped of readdirSync(path)) {
          const inner = join(path, scoped);
          if (!lstatSync(inner).isSymbolicLink()) {
            inspect(inner);
          }
        }
      } else {
        inspect(path);
      }
    }
  }
  for (const [id, { name, hooks }] of [...builders].sort(([a], [b]) => a.localeCompare(b))) {
    if (!allowed.has(name) && !ignored.has(name)) {
      problems.push(
        `${id} declares ${hooks.join(", ")} but pnpm-workspace.yaml lists it in neither onlyBuiltDependencies nor ignoredBuiltDependencies; review the script and add it to one of them`,
      );
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  console.error("supply chain check failed");
  process.exit(1);
}
console.log(`supply chain check passed: ${published.map(({ dir }) => dir).join(", ")}`);
