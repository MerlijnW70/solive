import { formatAmount } from "@intent-engine/core";
import type { AgentPayout, RelayerPayout, WithheldPayout } from "@intent-engine/core/internal";
import { account, flag, list, object, optional, text } from "../schema.js";

export type Payouts = { agentPaid: AgentPayout | null; relayerPaid: RelayerPayout | null; withheld: WithheldPayout[]; complete: boolean };

export const PAYOUTS_MAX = 16;

export const payoutItems = {
  agent_paid: optional(
    object({
      agent: account("the mandate agent that created the intent and was paid its fee"),
      account: account("the token account the fee went into"),
      amount: text("whole tokens of the input token paid as the agent fee"),
    }),
  ),
  relayer_paid: optional(
    object({
      relayer: account("the relayer that submitted the owner-signed intent and was paid its fee"),
      account: account("the token account the fee went into"),
      amount: text("whole tokens of the input token paid as the relayer fee"),
    }),
  ),
  withheld: optional(
    list(
      object({
        role: text("who the fee was for: partner, agent, treasury, judge, protocol or unknown"),
        payee: account("the wallet the fee was for"),
        account: account("the token account that could not take it"),
        amount: text("whole tokens of the input token the program kept with the escrow owner instead"),
      }),
      PAYOUTS_MAX,
      "fees the program withheld because their account could not take them",
    ),
  ),
  payouts_incomplete: optional(flag("true when the transactions read do not include the intent's creation, so a relayer fee may exist that this does not show")),
};

export function payoutView(payouts: Payouts, decimals: number | undefined) {
  const whole = (raw: bigint) => formatAmount(raw, decimals);
  const { agentPaid, relayerPaid, withheld } = payouts;
  return {
    ...(agentPaid === null ? {} : { agent_paid: { agent: agentPaid.agent, account: agentPaid.account, amount: whole(agentPaid.fee) } }),
    ...(relayerPaid === null ? {} : { relayer_paid: { relayer: relayerPaid.relayer, account: relayerPaid.account, amount: whole(relayerPaid.fee) } }),
    ...(withheld.length === 0 ? {} : { withheld: withheld.map((fee) => ({ role: fee.role, payee: fee.payee, account: fee.account, amount: whole(fee.amount) })) }),
    ...(payouts.complete ? {} : { payouts_incomplete: true }),
  };
}

export function mergedPayouts(all: readonly Payouts[]): Payouts {
  const agents = all.flatMap(({ agentPaid }) => (agentPaid === null ? [] : [agentPaid]));
  const [first] = agents;
  return {
    agentPaid: first === undefined ? null : { ...first, fee: agents.reduce((sum, { fee }) => sum + fee, 0n) },
    relayerPaid: all.find(({ relayerPaid }) => relayerPaid !== null)?.relayerPaid ?? null,
    withheld: all.flatMap(({ withheld }) => withheld),
    complete: all.every(({ complete }) => complete),
  };
}
