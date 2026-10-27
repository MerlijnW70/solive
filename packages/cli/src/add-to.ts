import { PRODUCT_SLUG } from "@intent-engine/core/internal";
import type { Runtime } from "./runtime.js";
import { httpRefused, npmRegistry, registryWarning } from "./npm-registry.js";

export const CLI_PACKAGE = "@intent-engine/cli";

export const CLAUDE = "claude";

export const CODEX = "codex";

export type App = typeof CLAUDE | typeof CODEX;

export const ADD_TO_APPS: readonly App[] = [CLAUDE, CODEX];

export const CODEX_STARTUP_TIMEOUT = 90;

export const CODEX_HOME_ENV = "CODEX_HOME";

export const CLAUDE_MISSING = "claude is not installed or not on PATH; install Claude Code, then run this again";

export const CODEX_MISSING = "codex is not installed or not on PATH; install Codex, then run this again";

const failed = (app: App) => (code: number, output: string) =>
  `${app} mcp add failed with exit code ${code}, so nothing was added: ${output.trim() === "" ? "it printed nothing" : output.trim()}`;

export const claudeFailed = failed(CLAUDE);

export const CLAUDE_SCOPE = ["--scope", "user"];

const ALREADY_EXISTS = /already exists/i;

export const claudeExists = (limits: readonly string[]) =>
  `${PRODUCT_SLUG} is already added to Claude Code for your user, so nothing was changed; to replace it, run ${[CLAUDE, "mcp", "remove", ...CLAUDE_SCOPE, PRODUCT_SLUG].join(" ")}, then ${["npx", "-y", CLI_PACKAGE, "add-to", CLAUDE, ...limits].join(" ")}`;

export const codexFailed = failed(CODEX);

export const codexConfigPath = (runtime: Pick<Runtime, "env" | "home">): string =>
  `${(runtime.env[CODEX_HOME_ENV] ?? `${runtime.home}/.codex`).replaceAll("\\", "/").replace(/\/+$/, "")}/config.toml`;

export const codexNoEntry = (path: string) =>
  `codex mcp add ran, but ${path} has no [mcp_servers.${PRODUCT_SLUG}] table, so startup_timeout_sec was not set: add startup_timeout_sec = ${CODEX_STARTUP_TIMEOUT} under that table`;

const APPS: Record<App, { name: string; missing: string; failed: (code: number, output: string) => string }> = {
  claude: { name: "Claude Code", missing: CLAUDE_MISSING, failed: claudeFailed },
  codex: { name: "Codex", missing: CODEX_MISSING, failed: codexFailed },
};

export const serverCommand = (platform: string, limits: readonly string[]): string[] => [
  ...(platform === "win32" ? ["cmd", "/c"] : []),
  "npx",
  "-y",
  CLI_PACKAGE,
  "mcp",
  "--url",
  "devnet",
  "--wallet",
  ...limits,
];

const HEADER = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:${PRODUCT_SLUG}|"${PRODUCT_SLUG}"|'${PRODUCT_SLUG}')\\s*\\]\\s*(?:#.*)?\\r?$`);

const TABLE = /^\s*\[/;

const TIMEOUT = /^\s*startup_timeout_sec\s*=\s*([^#\r]*?)\s*(?:#.*)?\r?$/;

export function withStartupTimeout(text: string): { text: string; was: string | null } | null {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => HEADER.test(line));
  if (start < 0) {
    return null;
  }
  const after = lines.slice(start + 1).findIndex((line) => TABLE.test(line));
  const end = after < 0 ? lines.length : start + 1 + after;
  const eol = text.includes("\r\n") ? "\r" : "";
  const setting = `startup_timeout_sec = ${CODEX_STARTUP_TIMEOUT}${eol}`;
  for (let i = start + 1; i !== end; i++) {
    const found = TIMEOUT.exec(lines[i] ?? "");
    if (found !== null) {
      lines[i] = setting;
      return { text: lines.join("\n"), was: found[1] ?? "" };
    }
  }
  let last = end;
  while (lines[last - 1]?.trim() === "") {
    last--;
  }
  lines.splice(last, 0, setting);
  return { text: lines.join("\n"), was: null };
}

async function setCodexTimeout(runtime: Runtime): Promise<object> {
  const path = codexConfigPath(runtime);
  const text = await runtime.readText(path).catch(() => "");
  const changed = withStartupTimeout(text);
  if (changed === null) {
    throw new Error(codexNoEntry(path));
  }
  if (changed.text !== text) {
    await runtime.saveText(path, changed.text, false);
  }
  return { config: path, startup_timeout_sec: CODEX_STARTUP_TIMEOUT, was: changed.was };
}

export class HttpRegistryRefused extends Error {}

export async function addTo(app: App, limits: readonly string[], allowHttpRegistry: boolean, runtime: Runtime): Promise<object> {
  const target = APPS[app];
  const registry = await npmRegistry(runtime.launch);
  if (registry.read === "http" && !allowHttpRegistry) {
    throw new HttpRegistryRefused(httpRefused(registry.registry, registry.key));
  }
  const warning = registryWarning(registry);
  const server = serverCommand(runtime.platform, limits);
  const args = ["mcp", "add", ...(app === CLAUDE ? CLAUDE_SCOPE : []), PRODUCT_SLUG, "--", ...server];
  const launched = await runtime.launch(app, args);
  if (launched === null) {
    throw new Error(target.missing);
  }
  if (launched.code !== 0 && app === CLAUDE && ALREADY_EXISTS.test(launched.output)) {
    throw new Error(claudeExists(limits));
  }
  if (launched.code !== 0) {
    throw new Error(target.failed(launched.code, launched.output));
  }
  const timeout = app === CODEX ? await setCodexTimeout(runtime) : {};
  return {
    added: PRODUCT_SLUG,
    to: target.name,
    ran: [app, ...args].join(" "),
    server: server.join(" "),
    ...timeout,
    ...(warning === undefined ? {} : { warnings: [warning] }),
    next: `restart ${target.name}, then ask it to set you up and make your first swap`,
  };
}
