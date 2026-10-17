import type { Address } from "@solana/kit";
import { type Intent, IntentStatus } from "@intent-engine/core";
import type { Flight } from "./solver.js";

export type Hold = { account: Address; amount: bigint };

export function unheld(live: bigint, held: bigint): bigint {
  return live > held ? live - held : 0n;
}

export function heldBy(flights: ReadonlyMap<Address, Flight>): (account: Address) => bigint {
  return (account) => {
    let total = 0n;
    for (const flight of flights.values()) {
      if (flight.holds?.account === account) {
        total += flight.holds.amount;
      }
    }
    return total;
  };
}

export function releaseHolds(
  flights: Map<Address, Flight>,
  listed: readonly { address: Address; intent: Intent }[],
  full: boolean,
): void {
  const status = new Map(listed.map(({ address, intent }) => [address, intent.status]));
  for (const [address, flight] of flights) {
    if (flight.holds === undefined) {
      continue;
    }
    const seen = status.get(address);
    if (seen === IntentStatus.Open || (seen === undefined && !full)) {
      continue;
    }
    flights.set(address, { until: flight.until, signature: flight.signature });
  }
}
