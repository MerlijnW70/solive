import type { Address } from "@solana/kit";
import { formatTime } from "@intent-engine/core";
import { type ClaimsView, loadClaimsOf, type Transport } from "@intent-engine/client";
import { tool } from "./names.js";

export const CLAIM_FIRST = `a job with takes_claims true pays only the worker holding its claim while the claim holds; claim one with ${tool("wallet_claim")} before working on it or hosting the work`;

export const SPEC_TAKES_CLAIMS = `this job takes claims: while one holds, only its worker can be paid; claim it with ${tool("wallet_claim")} before working on it or hosting the work`;

export const specClaimHeld = (worker: Address, until: bigint) =>
  `${worker} holds this job's claim until ${formatTime(until)}, so only that worker can be paid while it holds; join its line with ${tool("wallet_claim")} action standby to get it next, and hold the claim before working on it or hosting the work`;

export const NO_CLAIM_HELD = `this job takes claims and this wallet holds none: a worker who claims it first is the only one who can be paid while that claim holds; claim it with ${tool("wallet_claim")} before working on it`;

export const claimedByOther = (worker: Address, until: bigint, self: Address) =>
  `${worker} holds this job's claim until ${formatTime(until)}: while that claim holds, a release can pay only ${worker}, so this wallet ${self} cannot be paid for this work`;

export async function claimOf(transport: Transport, intent: Address): Promise<ClaimsView | null> {
  const [view] = await loadClaimsOf(transport, [intent]);
  return view ?? null;
}

const heldBy = (view: ClaimsView): Address | null => (view.state === "held" ? view.worker : null);

export function deliverClaimWarnings(view: ClaimsView | null, self: Address): string[] {
  if (view === null) {
    return [];
  }
  const holder = heldBy(view);
  if (holder === null) {
    return [NO_CLAIM_HELD];
  }
  return holder === self ? [] : [claimedByOther(holder, view.until, self)];
}

export function specClaimHint(view: ClaimsView | null): string | undefined {
  if (view === null) {
    return undefined;
  }
  const holder = heldBy(view);
  return holder === null ? SPEC_TAKES_CLAIMS : specClaimHeld(holder, view.until);
}
