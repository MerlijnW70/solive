import type { Address } from "@solana/kit";
import { decodeEvent, getIntentDecoder, INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core";
import type { EngineTransaction, Transport } from "@intent-engine/client";

export type SeenFill = { signature: string; slot: bigint; intent: Address; amountIn: bigint };

const PAID_IN_ONE_STEP: ReadonlySet<string> = new Set(["IntentFilled", "IntentAttested", "IntentSplit"]);

export function fillsIn(transactions: readonly EngineTransaction[]): { fills: SeenFill[]; created: Map<Address, Address> } {
  const fills: SeenFill[] = [];
  const created = new Map<Address, Address>();
  for (const tx of transactions) {
    if (tx.failed) {
      continue;
    }
    const begun = new Map<Address, bigint>();
    for (const event of tx.emitted.map(decodeEvent)) {
      if (event === null) {
        continue;
      }
      const fields = event.fields as Record<string, unknown>;
      const intent = fields["intent"] as Address;
      if (event.name === "IntentCreated") {
        created.set(intent, fields["inputMint"] as Address);
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
        fills.push({ signature: tx.signature, slot: tx.slot, intent, amountIn: amountIn ?? 0n });
      }
    }
  }
  return { fills, created };
}

export async function inputMintsOf(
  transport: Transport,
  fills: readonly SeenFill[],
  created: ReadonlyMap<Address, Address>,
): Promise<Map<Address, Address>> {
  const mints = new Map(created);
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
      mints.set(intent, getIntentDecoder().decode(view.data).inputMint);
    } catch {
      return;
    }
  });
  return mints;
}
