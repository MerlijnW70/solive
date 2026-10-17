import type { Address } from "@solana/kit";
import { type Intent, IntentStatus } from "@intent-engine/core";
import type { Backoff } from "./backoff.js";
import type { Hold } from "./holds.js";

export type Flight = { until: bigint; signature: string; holds?: Hold; intent?: Intent };

export type Landing = "landed" | "failed" | null;

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

export async function answered(
  flights: Map<Address, Flight>,
  listed: readonly { address: Address; intent: Intent }[],
  statuses: (signatures: readonly string[]) => Promise<readonly Landing[]>,
  held: Backoff,
): Promise<{ intent: Address; error: string }[]> {
  const asked = [...flights];
  if (asked.length === 0) {
    return [];
  }
  const found = await statuses(asked.map(([, flight]) => flight.signature)).catch((): readonly Landing[] => []);
  const current = new Map(listed.map(({ address, intent }) => [address, intent]));
  const failed: { intent: Address; error: string }[] = [];
  asked.forEach(([address, flight], i) => {
    const status = found[i];
    if (status === "landed") {
      flights.delete(address);
      return;
    }
    const intent = current.get(address) ?? flight.intent;
    if (status !== "failed" || intent === undefined) {
      return;
    }
    flights.delete(address);
    if (intent.status === IntentStatus.Open) {
      held.failed(address, intent);
      failed.push({ intent: address, error: `${FAILED_ON_CHAIN}: ${flight.signature}` });
    }
  });
  return failed;
}
