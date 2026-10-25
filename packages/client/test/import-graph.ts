import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const IMPORT = /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+"([^"]+)"|import\("([^"]+)"\)/g;

export type Graph = { modules: Set<string>; packages: Set<string>; specifiers: Set<string> };

export function graph(entry: string): Graph {
  const modules = new Set<string>();
  const packages = new Set<string>();
  const specifiers = new Set<string>();
  const queue = [entry];
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    if (modules.has(file)) {
      continue;
    }
    modules.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(IMPORT)) {
      const target = match[1] ?? match[2] ?? "";
      if (target.startsWith(".")) {
        queue.push(resolve(dirname(file), target.replace(/\.js$/, ".ts")));
      } else {
        specifiers.add(target);
        packages.add(target.startsWith("@") ? target.split("/").slice(0, 2).join("/") : (target.split("/")[0] ?? target));
      }
    }
  }
  return { modules, packages, specifiers };
}
