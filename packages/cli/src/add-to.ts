import { PRODUCT_SLUG } from "@intent-engine/core";
import type { Runtime } from "./runtime.js";

export const CLI_PACKAGE = "@intent-engine/cli";

export const CLAUDE = "claude";

export const CLAUDE_MISSING = "claude is not installed or not on PATH; install Claude Code, then run this again";

export const claudeFailed = (code: number, output: string) =>
  `claude mcp add failed with exit code ${code}, so nothing was added: ${output.trim() === "" ? "it printed nothing" : output.trim()}`;

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

export async function addTo(limits: readonly string[], runtime: Runtime): Promise<object> {
  const server = serverCommand(runtime.platform, limits);
  const args = ["mcp", "add", PRODUCT_SLUG, "--", ...server];
  const launched = await runtime.launch(CLAUDE, args);
  if (launched === null) {
    throw new Error(CLAUDE_MISSING);
  }
  if (launched.code !== 0) {
    throw new Error(claudeFailed(launched.code, launched.output));
  }
  return {
    added: PRODUCT_SLUG,
    to: "Claude Code",
    ran: [CLAUDE, ...args].join(" "),
    server: server.join(" "),
    next: "restart Claude Code, then ask it to set you up and make your first swap",
  };
}
