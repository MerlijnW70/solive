import { appendFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/client";
import { afterEach } from "vitest";

export const LEDGER_ENV = "SOLIVE_ANSWER_LEDGER";

type Answer = { tool: string; value: unknown; error: boolean };

const seen: Answer[] = [];
const OUTSIDE = "produced output outside its schema";

const detailOf = (value: unknown): string => {
  const detail = (value as { untrustedDetail?: unknown } | null | undefined)?.untrustedDetail;
  return typeof detail === "string" ? detail : "";
};

export function watchAnswers(): void {
  const real = Client.prototype.callTool;
  Client.prototype.callTool = async function (this: Client, ...args: Parameters<Client["callTool"]>) {
    const result = await real.apply(this, args);
    seen.push({ tool: String(args[0].name), value: (result as { structuredContent?: unknown }).structuredContent, error: (result as { isError?: boolean }).isError === true });
    return result;
  } as Client["callTool"];
  afterEach(async () => {
    const misses = await takeMisses();
    if (misses.length > 0) {
      throw new Error(`a tool answered outside its output schema: ${misses.join(" | ")}`);
    }
  });
}

export async function takeMisses(): Promise<string[]> {
  const answers = seen.splice(0);
  if (answers.length === 0) {
    return [];
  }
  const { servedActions } = await import("../src/agent/everyday.js");
  const actions = new Map(servedActions({ wallet: true, allTools: true, relay: true, agent: true }).map((action) => [action.name, action]));
  const misses: string[] = [];
  const ledger = process.env[LEDGER_ENV];
  for (const { tool, value, error } of answers) {
    if (error) {
      if (detailOf(value).includes(OUTSIDE)) {
        misses.push(`${tool}: ${detailOf(value)}`);
      }
      continue;
    }
    const action = actions.get(tool);
    if (action === undefined) {
      continue;
    }
    try {
      action.output.read(value, "");
      if (ledger !== undefined) {
        appendFileSync(ledger, `${tool}\n`);
      }
    } catch (cause) {
      misses.push(`${tool}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  return misses;
}
