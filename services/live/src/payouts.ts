import type { Activity } from "./activity.js";
import type { EventPayouts, Job } from "./shapes.js";
import { amountText } from "./words.js";

export function payoutsOf(activity: Activity, job: Job, places: number | null): EventPayouts | undefined {
  if (activity.kind !== "swap") {
    return undefined;
  }
  const amount = (raw: bigint) => (places === null ? null : amountText(raw, places));
  const { agentPaid = null, withheld = [] } = activity;
  const payouts: EventPayouts = {
    ...(agentPaid === null ? {} : { agent_paid: { wallet: agentPaid.agent, account: agentPaid.account, amount: amount(agentPaid.fee) } }),
    ...(job.relayer === undefined ? {} : { relayer_paid: { wallet: job.relayer.relayer, account: job.relayer.account, amount: amount(BigInt(job.relayer.raw)) } }),
    ...(withheld.length === 0 ? {} : { withheld: withheld.map((fee) => ({ role: fee.role, wallet: fee.payee, account: fee.account, amount: amount(fee.amount) })) }),
  };
  return Object.keys(payouts).length === 0 ? undefined : payouts;
}
