import type { Address } from "@solana/kit";
import type { EngineEvent } from "./events.js";
import { type WithheldRole, withheldRole } from "./events.js";

export type AgentPayout = { agent: Address; account: Address; fee: bigint };

export type RelayerPayout = { relayer: Address; account: Address; fee: bigint };

export type WithheldPayout = { role: WithheldRole | "unknown"; payee: Address; account: Address; amount: bigint };

export type FillPayouts = { agentPaid: AgentPayout | null; withheld: WithheldPayout[] };

export function fillPayoutsOf(events: readonly EngineEvent[], intent: Address): FillPayouts {
  let agentPaid: AgentPayout | null = null;
  const withheld: WithheldPayout[] = [];
  for (const event of events) {
    if (event.name === "AgentPaid" && event.fields.intent === intent) {
      const { agent, account, fee } = event.fields;
      agentPaid = { agent, account, fee };
    }
    if (event.name === "FeeWithheld" && event.fields.intent === intent && withheldRole(event.fields.role) !== "treasury") {
      const { role, payee, account, fee } = event.fields;
      withheld.push({ role: withheldRole(role), payee, account, amount: fee });
    }
  }
  return { agentPaid, withheld };
}

export function relayerPaidOf(events: readonly EngineEvent[], intent: Address): RelayerPayout | null {
  for (const event of events) {
    if (event.name === "RelayerPaid" && event.fields.intent === intent) {
      const { relayer, account, fee } = event.fields;
      return { relayer, account, fee };
    }
  }
  return null;
}
