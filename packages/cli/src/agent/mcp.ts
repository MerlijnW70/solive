import { McpServer } from "@modelcontextprotocol/server";
import { PRODUCT_SLUG } from "@intent-engine/core";
import { render } from "../render.js";
import { type AgentContext, type AnyAction, type Effect, invoke } from "./actions.js";
import { ACTIONS } from "./registry.js";
import { limitLines, WALLET_ACTIONS, WALLET_NOTICE } from "./wallet.js";
import { tool } from "./names.js";
import { passThrough } from "./schema.js";
import { VERSION } from "../version.js";
import type { WalletLimits } from "../args.js";

export const ANNOTATIONS: Record<Effect, { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }> = {
  read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  prepare: { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  submit: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

export const annotationsOf = (action: AnyAction) =>
  action.repeats === true ? { ...ANNOTATIONS[action.effect], idempotentHint: false } : ANNOTATIONS[action.effect];

export const WALLET_INSTRUCTIONS = [
  `This server holds a devnet wallet and trades intents with it. Devnet tokens have no value.`,
  `Before anything else, show the user this notice once, every line:`,
  ...WALLET_NOTICE.map((line) => `- ${line}`),
  `Start with ${tool("wallet_setup")}; it creates and funds the wallet and is safe to call again.`,
  `${tool("wallet_swap")}, ${tool("wallet_auction")}, ${tool("wallet_recurring")} and ${tool("wallet_cancel")} only preview until called with send: true. Show the user the summary first and send only after they say yes.`,
  `Name tokens SOL and TEST, or by mint address. Amounts are whole tokens such as 0.05.`,
  `Solvers pay the least an intent asks. ${tool("wallet_swap")} therefore starts its ask a little above the best recent fill and lets it fall to min_receive, so a solver takes it near the most it can pay: set min_receive to the least the user accepts. ${tool("wallet_estimate")} shows what recent fills paid.`,
  `${tool("wallet_recurring")} repeats a swap on a schedule, such as every hour, by sending every order now with its ask held until its turn.`,
  `After sending, ${tool("wallet_wait")} waits for the fill and says what the wallet received; ${tool("wallet_intents")} and ${tool("wallet_balance")} show the rest.`,
].join("\n");

export const walletInstructions = (limits: WalletLimits): string => [WALLET_INSTRUCTIONS, ...limitLines(limits)].join("\n");

export const START_PROMPT = `Set me up on devnet and walk me through my first swap: set up the wallet, show me its notice, show my balance, preview selling 0.05 SOL for at least 5 TEST, and send it once I approve. Then wait for it to fill and tell me what I received.`;

export function agentServer(ctx: AgentContext, served: readonly AnyAction[] = ACTIONS): McpServer {
  const withWallet = ctx.wallet !== undefined;
  const actions = withWallet ? [...WALLET_ACTIONS, ...served] : served;
  const server = new McpServer({ name: PRODUCT_SLUG, version: VERSION }, ctx.wallet === undefined ? {} : { instructions: walletInstructions(ctx.wallet.limits.limits) });
  if (withWallet) {
    server.registerPrompt("start", { title: "Get started", description: "Set up a devnet wallet and make a first swap" }, () => ({
      messages: [{ role: "user" as const, content: { type: "text" as const, text: START_PROMPT } }],
    }));
  }
  for (const action of actions) {
    server.registerTool(
      action.name,
      {
        title: action.title,
        description: action.description,
        inputSchema: passThrough(action.input.json),
        outputSchema: passThrough(action.output.json),
        annotations: annotationsOf(action),
      },
      async (args: unknown) => {
        const outcome = await invoke(action, ctx, args);
        return outcome.ok
          ? { content: [{ type: "text" as const, text: render(outcome.value) }], structuredContent: outcome.value }
          : {
              isError: true,
              content: [{ type: "text" as const, text: `${outcome.problem.code}: ${outcome.problem.hint}` }],
              structuredContent: outcome.problem,
            };
      },
    );
  }
  return server;
}
