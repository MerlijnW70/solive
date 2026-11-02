import { createHash } from "node:crypto";
import type { Address } from "@solana/kit";
import { formatAmount } from "@intent-engine/core";
import { isSealed, MAX_CLAIM_SECS, MAX_CLAIM_STAKE, MIN_CLAIM_STAKE, sealedTo } from "@intent-engine/core/internal";
import { loadCommittee, MAX_SPEC_BYTES } from "@intent-engine/client/internal";
import { tooLarge } from "../../delivery-fetch.js";
import type { AgentContext } from "../actions.js";
import { tool } from "../names.js";
import { InvalidInput, integer, optional, text } from "../schema.js";
import type { ClaimTerms, SpecRead } from "./escrow-claims.js";
import { raw } from "./guard.js";
import { openedSpec, SEALED_UNCHECKED } from "./seal.js";

export const SPEC_TOO_LARGE = `spec_url ${tooLarge(MAX_SPEC_BYTES)}, the most ${tool("get_spec")} reads, so workers cannot read the job; shorten the spec`;

export const notSealedTo = (missing: readonly Address[], committee: boolean): string =>
  `spec_url holds a spec not sealed to the ${committee ? "committee members" : "attestor"} ${missing.join(", ")}, so the work cannot be judged; seal it again to ${committee ? "every member" : "the attestor"}`;

type Preflight = { lines: string[]; readers: string[] };

async function unreadBy(ctx: AgentContext, bytes: Uint8Array, attestor: Address): Promise<string[]> {
  const recipients = new Set<string>(sealedTo(bytes));
  const committee = await loadCommittee(ctx.transport, attestor);
  const missing = (committee === null ? [attestor] : committee.members).filter((reader) => !recipients.has(reader));
  return missing.length === 0 ? [] : [notSealedTo(missing, committee !== null)];
}

export async function specPreflight(ctx: AgentContext, found: SpecRead, specHash: string, attestor: Address): Promise<Preflight> {
  if ("problem" in found) {
    return { lines: [found.problem === tooLarge(MAX_SPEC_BYTES) ? SPEC_TOO_LARGE : `spec_url ${found.problem}; publish it or workers cannot read the job`], readers: [] };
  }
  const sealed = isSealed(found.bytes);
  const lines = sealed ? await unreadBy(ctx, found.bytes, attestor) : [];
  const readers = sealed ? [...new Set<string>(sealedTo(found.bytes))].sort() : [];
  const opened = await openedSpec(ctx, found.bytes);
  if (opened === undefined) {
    return { lines: [...lines, SEALED_UNCHECKED], readers };
  }
  const sha256 = createHash("sha256").update(opened).digest("hex");
  if (sha256 !== specHash.toLowerCase()) {
    lines.push(`spec_url ${opened === found.bytes ? "hashes" : "opens to a spec that hashes"} to ${sha256}, not spec_hash ${specHash}; publish the exact bytes, or fix spec_hash`);
  }
  return { lines, readers };
}

export const STAKE_BELOW_RENT = `must be 0 or at least ${formatAmount(MIN_CLAIM_STAKE, 9)}, the rent-exempt minimum of a wallet: the program refuses a smaller stake (StakeBelowRent) so it can always pay a stake back to a wallet that holds nothing`;
export const CLAIMS_TOGETHER = "give claim_stake and claim_secs together, or neither";

export const CLAIMS_NEED_SPEC = "claims need spec_hash, since only a proof escrow takes claims";

export const claimInputs = {
  claim_stake: optional(text(`whole SOL a worker stakes to claim the job, such as 0.01: 0, or at least ${formatAmount(MIN_CLAIM_STAKE, 9)}, the rent-exempt minimum of a wallet; with claim_secs it opens claims, so one worker at a time can be paid; on a spec sealed at spec_url only the workers it invites may claim; needs spec_hash`)),
  claim_secs: optional(integer(1, MAX_CLAIM_SECS, "the longest a worker may hold the job by claiming it, in seconds; with claim_stake")),
};

type Claims = ClaimTerms & { line: string };

export const claimsLine = (secs: number, stake: string, every: boolean) =>
  `Opens: claims on ${every ? "every piece" : "the escrow"}; a worker can hold the job for up to ${secs} seconds by staking ${stake} SOL`;

export function claimTerms(input: { claim_stake?: string | undefined; claim_secs?: number | undefined }, every: boolean): Claims | undefined {
  if (input.claim_stake === undefined && input.claim_secs === undefined) {
    return undefined;
  }
  if (input.claim_stake === undefined || input.claim_secs === undefined) {
    throw new InvalidInput([{ path: input.claim_stake === undefined ? "claim_stake" : "claim_secs", message: CLAIMS_TOGETHER }]);
  }
  const stake = raw(input.claim_stake, 9, "claim_stake");
  if (stake > MAX_CLAIM_STAKE) {
    throw new InvalidInput([{ path: "claim_stake", message: `must be at most ${formatAmount(MAX_CLAIM_STAKE, 9)}` }]);
  }
  if (stake > 0n && stake < MIN_CLAIM_STAKE) {
    throw new InvalidInput([{ path: "claim_stake", message: STAKE_BELOW_RENT }]);
  }
  const maxSecs = input.claim_secs;
  return { line: claimsLine(maxSecs, formatAmount(stake, 9), every), maxSecs, stake };
}

