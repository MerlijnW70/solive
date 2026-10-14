import type { Address, TransactionSigner } from "@solana/kit";
import { type Budget, budgetOf, release, reserve } from "./budget.js";
import { AgentRefusal } from "./problems.js";

export const RATE_WINDOW = 3_600n;

type RelayPolicy = {
  maxLamports: bigint;
  maxTtl: bigint;
  perHour: number;
  hourlyLamports: bigint;
  fees: ReadonlyMap<Address, bigint>;
};

export type Relay = RelayPolicy & { signer: TransactionSigner; recent: Map<Address, bigint[]>; budget: Budget };

type Ticket = { cancel(): void };

export function relayOf(signer: TransactionSigner, policy: RelayPolicy): Relay {
  return { ...policy, signer, recent: new Map(), budget: budgetOf(policy.hourlyLamports) };
}

function prune(relay: Relay, now: bigint): void {
  for (const [owner, times] of relay.recent) {
    const live = times.filter((t) => t > now - RATE_WINDOW);
    if (live.length === 0) {
      relay.recent.delete(owner);
    } else {
      relay.recent.set(owner, live);
    }
  }
}

export function refuseLongRelay(relay: Relay, expiresAt: bigint, now: bigint): void {
  if (expiresAt - now > relay.maxTtl) {
    throw new AgentRefusal(
      "RelayTooLong",
      `this relayer only relays intents that expire within ${relay.maxTtl} seconds; sign one with an earlier expiry`,
    );
  }
}

export function refuseCostlyTerms(relay: Relay, charges: bigint): void {
  if (charges > relay.maxLamports) {
    throw new AgentRefusal(
      "RelayTooCostly",
      `relaying this intent costs at least ${charges} lamports in create fee and crank bounty before any priority fee; this relayer pays at most ${relay.maxLamports}`,
    );
  }
}

export function admitRelay(
  relay: Relay,
  owner: Address,
  charges: bigint,
  total: bigint,
  expiresAt: bigint,
  now: bigint,
): Ticket {
  if (charges > relay.maxLamports) {
    throw new AgentRefusal(
      "RelayTooCostly",
      `relaying this intent costs ${charges} lamports in create fee, crank bounty and priority fee; this relayer pays at most ${relay.maxLamports}`,
    );
  }
  refuseLongRelay(relay, expiresAt, now);
  prune(relay, now);
  const times = relay.recent.get(owner) ?? [];
  if (times.length >= relay.perHour) {
    throw new AgentRefusal("RelayRateLimited", `this relayer relays at most ${relay.perHour} intents per owner per hour`);
  }
  const spend = reserve(relay.budget, total, now);
  relay.recent.set(owner, [...times, now]);
  return {
    cancel: () => {
      release(relay.budget, spend);
      const current = relay.recent.get(owner) ?? [];
      const at = current.lastIndexOf(now);
      if (at >= 0) {
        current.splice(at, 1);
      }
    },
  };
}
