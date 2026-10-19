import type { Address } from "@solana/kit";
import { AgentRefusal } from "./problems.js";

export const PREPARED_TTL = 120n;
export const MAX_PENDING_PER_OWNER = 16;

export type Claims = { held: Map<Address, Map<bigint, bigint>>; busy: Set<string> };

export type Call = { undo: (() => void)[]; asked?: string };

export const claimsOf = (): Claims => ({ held: new Map(), busy: new Set() });

export const callOf = (asked?: string): Call => ({ undo: [], ...(asked === undefined ? {} : { asked }) });

function prune(claims: Claims, now: bigint): void {
  for (const [owner, held] of claims.held) {
    for (const [nonce, until] of held) {
      if (until < now) {
        held.delete(nonce);
      }
    }
    if (held.size === 0) {
      claims.held.delete(owner);
    }
  }
}

export function claimedBy(claims: Claims, owner: Address, now: bigint): Set<bigint> {
  prune(claims, now);
  return new Set(claims.held.get(owner)?.keys());
}

export function claim(claims: Claims, call: Call, owner: Address, nonce: bigint, until: bigint, now: bigint): void {
  const pending = claimedBy(claims, owner, now);
  if (pending.has(nonce)) {
    throw new AgentRefusal(
      "NoncePromised",
      `nonce ${nonce} of ${owner} is already handed to another pending request; leave nonce out to get a free one, or ask again once that request expires`,
    );
  }
  if (pending.size >= MAX_PENDING_PER_OWNER) {
    throw new AgentRefusal(
      "TooManyPending",
      `${owner} already has ${MAX_PENDING_PER_OWNER} prepared requests waiting; submit some or let them expire (a signed intent holds its nonce until its submit_by), then ask again`,
    );
  }
  const held = claims.held.get(owner) ?? new Map<bigint, bigint>();
  held.set(nonce, until);
  claims.held.set(owner, held);
  call.undo.push(() => {
    if (held.get(nonce) === until) {
      held.delete(nonce);
    }
  });
}

export function enter(claims: Claims, key: string): () => void {
  if (claims.busy.has(key)) {
    throw new AgentRefusal(
      "SubmitInFlight",
      "this intent is being relayed by another request right now; ask again in a moment to see whether it landed",
    );
  }
  claims.busy.add(key);
  return () => {
    claims.busy.delete(key);
  };
}
