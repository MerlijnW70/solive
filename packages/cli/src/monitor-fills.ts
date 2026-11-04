import type { Address } from "@solana/kit";
import { decodeEvent, decodeIntentAccount, fillPayoutsOf, INTENT_ENGINE_PROGRAM_ADDRESS, relayerPaidOf } from "@intent-engine/core/internal";
import type { EngineTransaction, Transport } from "@intent-engine/client";
import type { Payouts } from "./agent/wallet/payout-view.js";

export type SeenFill = { signature: string; slot: bigint; intent: Address; amountIn: bigint; payouts: Payouts };

const PAID_IN_ONE_STEP: ReadonlySet<string> = new Set(["IntentFilled", "IntentAttested", "IntentSplit"]);

export function fillsIn(transactions: readonly EngineTransaction[]): { fills: SeenFill[]; known: Map<Address, Address> } {
  const fills: SeenFill[] = [];
  const known = new Map<Address, Address>();
  const relayers = new Map<Address, Payouts["relayerPaid"]>();
  for (const tx of transactions) {
    if (tx.failed) {
      continue;
    }
    const begun = new Map<Address, bigint>();
    const events = tx.emitted.map(decodeEvent).filter((event) => event !== null);
    for (const event of events) {
      const fields = event.fields as Record<string, unknown>;
      const intent = fields["intent"] as Address;
      if (event.name === "IntentCreated") {
        known.set(intent, fields["inputMint"] as Address);
        relayers.set(intent, relayerPaidOf(events, intent));
      }
      if (event.name === "FillBegun") {
        begun.set(intent, fields["amountIn"] as bigint);
      }
      const amountIn = PAID_IN_ONE_STEP.has(event.name)
        ? (fields["amountIn"] as bigint)
        : event.name === "FillEnded"
          ? (begun.get(intent) ?? null)
          : undefined;
      if (amountIn !== undefined) {
        const payouts = { ...fillPayoutsOf(events, intent), relayerPaid: null, complete: false };
        fills.push({ signature: tx.signature, slot: tx.slot, intent, amountIn: amountIn ?? 0n, payouts });
        const vault = tx.tokens?.find((held) => held.owner === intent);
        if (vault !== undefined && !known.has(intent)) {
          known.set(intent, vault.mint);
        }
      }
    }
  }
  const created = new Set(relayers.keys());
  for (const fill of fills) {
    fill.payouts = { ...fill.payouts, relayerPaid: relayers.get(fill.intent) ?? null, complete: created.has(fill.intent) };
  }
  return { fills, known };
}

export async function inputMintsOf(
  transport: Transport,
  fills: readonly SeenFill[],
  known: ReadonlyMap<Address, Address>,
): Promise<Map<Address, Address>> {
  const mints = new Map(known);
  const unknown = [...new Set(fills.map((f) => f.intent).filter((intent) => !mints.has(intent)))];
  if (unknown.length === 0) {
    return mints;
  }
  const views = await transport.getAccounts(unknown);
  unknown.forEach((intent, i) => {
    const view = views[i];
    if (view === null || view === undefined || view.owner !== INTENT_ENGINE_PROGRAM_ADDRESS) {
      return;
    }
    try {
      mints.set(intent, decodeIntentAccount(view.data).inputMint);
    } catch {
      return;
    }
  });
  return mints;
}

export function payoutFields({ agentPaid, relayerPaid, withheld, complete }: Payouts): Record<string, unknown> {
  return {
    ...(agentPaid === null ? {} : { agentPaid: { agent: agentPaid.agent, account: agentPaid.account, fee: agentPaid.fee.toString() } }),
    ...(relayerPaid === null ? {} : { relayerPaid: { relayer: relayerPaid.relayer, account: relayerPaid.account, fee: relayerPaid.fee.toString() } }),
    ...(withheld.length === 0 ? {} : { withheld: withheld.map(({ role, payee, account, amount }) => ({ role, payee, account, fee: amount.toString() })) }),
    ...(complete ? {} : { payoutsIncomplete: true }),
  };
}
