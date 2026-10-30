import { PRODUCT_SLUG } from "@intent-engine/core/internal";
import type { Runtime } from "./runtime.js";
import { onPath } from "./launch.js";
import { httpRefused, npmRegistry, registryWarning } from "./npm-registry.js";

export const CLI_PACKAGE = "@intent-engine/cli";

export const CLAUDE = "claude";

export const CODEX = "codex";

export type App = typeof CLAUDE | typeof CODEX;

export const ADD_TO_APPS: readonly App[] = [CLAUDE, CODEX];

export const CODEX_STARTUP_TIMEOUT = 90;

export const CODEX_TOOL_TIMEOUT = 180;

export const CODEX_HOME_ENV = "CODEX_HOME";

export const CLAUDE_INSTALL = "npm install -g @anthropic-ai/claude-code";

export const CODEX_INSTALL = "npm install -g @openai/codex";

export const CLAUDE_MISSING = `claude is not installed or not on PATH; install Claude Code with ${CLAUDE_INSTALL}, then run this again`;

export const CODEX_MISSING = `codex is not installed or not on PATH; install Codex with ${CODEX_INSTALL}, then run this again`;

export const npxFor = (platform: string): string => (platform === "win32" ? "npx.cmd" : "npx");

const failed = (app: App) => (code: number, output: string) =>
  `${app} mcp add failed with exit code ${code}, so nothing was added: ${output.trim() === "" ? "it printed nothing" : output.trim()}`;

export const claudeFailed = failed(CLAUDE);

export const CLAUDE_SCOPE = ["--scope", "user"];

const ALREADY_EXISTS = /already exists/i;

const replaceCommands = (app: App, limits: readonly string[], platform: string): string[] => [
  [app, "mcp", "remove", ...(app === CLAUDE ? CLAUDE_SCOPE : []), PRODUCT_SLUG].join(" "),
  [npxFor(platform), "-y", CLI_PACKAGE, "add-to", app, ...limits].join(" "),
];

export const alreadyAdded = (app: App, limits: readonly string[], platform: string) =>
  `${PRODUCT_SLUG} is already set up in ${APPS[app].name}, so nothing was changed; to replace it, run ${replaceCommands(app, limits, platform).join(", then ")}`;

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
  npxFor(platform),
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

const timeoutLine = (key: string) => new RegExp(`^\\s*${key}\\s*=\\s*([^#\\r]*?)\\s*(?:#.*)?\\r?$`);

export function withTimeout(text: string, key: string, value: number): { text: string; was: string | null } | null {
  const TIMEOUT = timeoutLine(key);
  const lines = text.split("\n");
  const start = lines.findIndex((line) => HEADER.test(line));
  if (start < 0) {
    return null;
  }
  const after = lines.slice(start + 1).findIndex((line) => TABLE.test(line));
  const end = after < 0 ? lines.length : start + 1 + after;
  const eol = text.includes("\r\n") ? "\r" : "";
  const setting = `${key} = ${value}${eol}`;
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

export const withStartupTimeout = (text: string) => withTimeout(text, "startup_timeout_sec", CODEX_STARTUP_TIMEOUT);

async function setCodexTimeout(runtime: Runtime): Promise<object> {
  const path = codexConfigPath(runtime);
  const text = await runtime.readText(path).catch(() => "");
  const started = withStartupTimeout(text);
  const changed = started === null ? null : withTimeout(started.text, "tool_timeout_sec", CODEX_TOOL_TIMEOUT);
  if (started === null || changed === null) {
    throw new Error(codexNoEntry(path));
  }
  if (changed.text !== text) {
    await runtime.saveText(path, changed.text, false);
  }
  return { config: path, startup_timeout_sec: CODEX_STARTUP_TIMEOUT, tool_timeout_sec: CODEX_TOOL_TIMEOUT, was: started.was };
}

export type WalletSetup = () => Promise<object>;

async function withWallet(result: object, setup: WalletSetup | undefined): Promise<object> {
  if (setup === undefined) {
    return result;
  }
  try {
    return { ...result, setup: await setup() };
  } catch (error) {
    return { ...result, setup: { failed: error instanceof Error ? error.message : String(error) } };
  }
}

const alreadyResult = (app: App, limits: readonly string[], platform: string): object => ({
  already: PRODUCT_SLUG,
  to: APPS[app].name,
  note: alreadyAdded(app, limits, platform),
  next: `restart ${APPS[app].name} if it is open, then ask it to set you up and make your first swap`,
});

export class HttpRegistryRefused extends Error {}

export async function addTo(app: App, limits: readonly string[], allowHttpRegistry: boolean, runtime: Runtime, setup?: WalletSetup): Promise<object> {
  const target = APPS[app];
  if (!onPath(app, runtime.env, runtime.platform)) {
    throw new Error(target.missing);
  }
  const existing = app === CODEX ? await runtime.readText(codexConfigPath(runtime)).catch(() => "") : "";
  if (app === CODEX && withStartupTimeout(existing) !== null) {
    return withWallet(alreadyResult(app, limits, runtime.platform), setup);
  }
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
    return withWallet(alreadyResult(app, limits, runtime.platform), setup);
  }
  if (launched.code !== 0) {
    throw new Error(target.failed(launched.code, launched.output));
  }
  const timeout = app === CODEX ? await setCodexTimeout(runtime) : {};
  return withWallet(
    {
      added: PRODUCT_SLUG,
      to: target.name,
      ran: [app, ...args].join(" "),
      server: server.join(" "),
      ...timeout,
      ...(warning === undefined ? {} : { warnings: [warning] }),
      next: `restart ${target.name}, then ask it to set you up and make your first swap`,
    },
    setup,
  );
}
