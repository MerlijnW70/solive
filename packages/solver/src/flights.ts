import type { Address } from "@solana/kit";
import { type Intent, IntentStatus } from "@intent-engine/core";
import type { Backoff } from "./backoff.js";
import type { Hold } from "./holds.js";

export type Flight = { until: bigint; signature: string; holds?: Hold };

export const FAILED_ON_CHAIN = "the fill was sent but failed on chain";

export async function landings(
  flights: Map<Address, Flight>,
  now: bigint,
  listed: readonly { address: Address; intent: Intent }[],
  failedOnChain: (signature: string) => Promise<boolean>,
  held: Backoff,
): Promise<{ intent: Address; error: string }[]> {
  const failed: { intent: Address; error: string }[] = [];
  for (const { address, intent } of listed) {
    const flight = flights.get(address);
    if (flight === undefined || flight.until > now) {
      continue;
    }
    flights.delete(address);
    if (intent.status !== IntentStatus.Open) {
      continue;
    }
    const lost = await failedOnChain(flight.signature).catch(() => false);
    if (lost) {
      held.failed(address, intent);
      failed.push({ intent: address, error: `${FAILED_ON_CHAIN}: ${flight.signature}` });
    }
  }
  return failed;
}
