import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { build, type Plugin } from "esbuild";

export const PACKAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const WEB_GLOBALS = ["fetch", "crypto", "TextEncoder", "TextDecoder", "URL", "console"] as const;
export const NODE_MODULE = /["'`]node:[\w/]+["'`]/;

const sideEffectsOf = (name: string): boolean | undefined =>
  (JSON.parse(readFileSync(join(PACKAGES, name, "package.json"), "utf8")) as { sideEffects?: boolean }).sideEffects;

const sources: Plugin = {
  name: "workspace-sources",
  setup(bundler) {
    bundler.onResolve({ filter: /^@intent-engine\/(core|client)(\/[\w.-]+)?$/ }, ({ path }) => {
      const [, name = "", entry = "index"] = /^@intent-engine\/(\w+)(?:\/([\w.-]+))?$/.exec(path) ?? [];
      const file = entry === "idl.json" ? join(PACKAGES, name, "generated", "idl.json") : join(PACKAGES, name, "src", `${entry}.ts`);
      return sideEffectsOf(name) === false ? { path: file, sideEffects: false } : { path: file };
    });
  },
};

export type Bundled = { code: string; inputs: string[] };

export async function bundled(app: string): Promise<Bundled> {
  const result = await build({
    stdin: { contents: app, resolveDir: join(PACKAGES, "client"), loader: "ts" },
    bundle: true,
    platform: "browser",
    format: "iife",
    minify: true,
    write: false,
    metafile: true,
    logLevel: "silent",
    plugins: [sources],
  });
  return { code: result.outputFiles[0]?.text ?? "", inputs: Object.keys(result.metafile.inputs) };
}

export function webOnly(code: string): Record<string, unknown> {
  const context = createContext(Object.fromEntries(WEB_GLOBALS.map((name) => [name, globalThis[name]])));
  runInContext(code, context);
  return context as Record<string, unknown>;
}
