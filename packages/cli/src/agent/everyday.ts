import type { AnyAction } from "./actions.js";
import { ACTIONS } from "./registry.js";
import { WALLET_ACTIONS } from "./wallet.js";
import { tool } from "./names.js";

export const EVERYDAY_TOOLS: ReadonlySet<string> = new Set(
  [
    "wallet_setup",
    "wallet_balance",
    "wallet_estimate",
    "wallet_swap",
    "wallet_auction",
    "wallet_recurring",
    "wallet_escrow",
    "wallet_escrow_plan",
    "wallet_attest",
    "wallet_deliver",
    "wallet_check_delivery",
    "wallet_wait",
    "wallet_receipt",
    "wallet_intents",
    "wallet_history",
    "wallet_cancel",
    "find_jobs",
    "get_spec",
  ].map(tool),
);

export const RELAY_TOOLS: ReadonlySet<string> = new Set(["prepare_signed_intent", "preview_signed_intent", "submit_signed_intent"].map(tool));

export const AGENT_TOOLS: ReadonlySet<string> = new Set(
  ["prepare_mandate", "get_mandate", "prepare_revoke_mandate", "prepare_agent_create", "agent_create"].map(tool),
);

export type Serving = { wallet: boolean; allTools: boolean; relay: boolean; agent: boolean };

export function servedActions(serving: Serving): readonly AnyAction[] {
  if (!serving.wallet) {
    return ACTIONS;
  }
  const every = [...WALLET_ACTIONS, ...ACTIONS];
  if (serving.allTools) {
    return every;
  }
  return every.filter(
    (action) =>
      EVERYDAY_TOOLS.has(action.name) || (serving.relay && RELAY_TOOLS.has(action.name)) || (serving.agent && AGENT_TOOLS.has(action.name)),
  );
}
