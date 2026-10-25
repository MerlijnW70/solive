import type { Address } from "@solana/kit";
import { decodeEvent, decodeIntentAccount, INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core/internal";
import type { EngineTransaction, Transport } from "@intent-engine/client";

export type SeenFill = { signature: string; slot: bigint; intent: Address; amountIn: bigint };

const PAID_IN_ONE_STEP: ReadonlySet<string> = new Set(["IntentFilled", "IntentAttested", "IntentSplit"]);

export function fillsIn(transactions: readonly EngineTransaction[]): { fills: SeenFill[]; known: Map<Address, Address> } {
  const fills: SeenFill[] = [];
  const known = new Map<Address, Address>();
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
        known.set(intent, fields["inputMint"] as Address);
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
        const vault = tx.tokens?.find((held) => held.owner === intent);
        if (vault !== undefined && !known.has(intent)) {
          known.set(intent, vault.mint);
        }
      }
    }
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
