import { createHash } from "node:crypto";
import type { Address } from "@solana/kit";
import { type DeliveryOpener, formatAmount } from "@intent-engine/core";
import { checkReviewTerms, isSealed, MAX_CLAIM_SECS, MAX_CLAIM_STAKE, MAX_REVIEW_SECS, MIN_REVIEW_SECS, sealedTo } from "@intent-engine/core/internal";
import { loadCommittee, MAX_SPEC_BYTES, type Transport } from "@intent-engine/client/internal";
import { tooLarge } from "../../delivery-fetch.js";
import type { AgentContext } from "../actions.js";
import { claimFloor, stakeBelowRent } from "../../stake-floor.js";
import { tool } from "../names.js";
import { flag, InvalidInput, integer, optional, text } from "../schema.js";
import type { ClaimTerms, SpecRead } from "./escrow-claims.js";
import { raw } from "./guard.js";
import { malformedRun, openedSpec, SEALED_UNCHECKED } from "./seal.js";
import { runProblem } from "../../judge-run.js";
import { DEFAULT_REVIEW_SECS, reviewLine } from "../../fair-lines.js";

export { malformedRun, refuseMalformedText } from "./seal.js";

export const SPEC_TOO_LARGE = `spec_url ${tooLarge(MAX_SPEC_BYTES)}, the most ${tool("get_spec")} reads, so workers cannot read the job; shorten the spec`;

export const notSealedTo = (missing: readonly Address[], committee: boolean): string =>
  `spec_url holds a spec not sealed to the ${committee ? "committee members" : "attestor"} ${missing.join(", ")}, so the work cannot be judged; seal it again to ${committee ? "every member" : "the attestor"}`;

type Preflight = { lines: string[]; readers: string[]; wrong?: true; malformed?: string };

export function refuseMalformedRun(checked: Preflight | undefined, path: string, label = ""): void {
  if (checked?.malformed !== undefined) {
    throw new InvalidInput([{ path, message: `${label}${malformedRun(checked.malformed)}` }]);
  }
}


export const WRONG_SPEC_SEND = "a send refuses this spec unless allow_wrong_spec is true";

export const WRONG_SPEC_ALLOWED = "allow_wrong_spec is true: the send escrows anyway, against a spec_hash the bytes at spec_url do not match";

export const ALLOW_WRONG_SPEC = "allow_wrong_spec sends a mismatched spec_url";

export const wrongSpecRefused = (line: string): string => `${line}; nothing was sent; fix spec_hash or the file at spec_url, or pass allow_wrong_spec: true to send anyway`;

export const allowWrongSpec = { allow_wrong_spec: optional(flag("true sends even when the bytes at spec_url do not hash to spec_hash; leave out to refuse such a send")) };

export function wrongSpecLines(checked: Preflight | undefined, allowed: boolean | undefined): string[] {
  return checked === undefined ? [] : checked.wrong === true ? [...checked.lines, allowed === true ? WRONG_SPEC_ALLOWED : WRONG_SPEC_SEND] : checked.lines;
}

export function refuseWrongSpec(checked: Preflight | undefined, allowed: boolean | undefined, path: string, label = ""): void {
  if (checked?.wrong === true && allowed !== true) {
    throw new InvalidInput([{ path, message: wrongSpecRefused(`${label}${checked.lines.at(-1) ?? ""}`) }]);
  }
}

async function unreadBy(ctx: AgentContext, bytes: Uint8Array, attestor: Address): Promise<string[]> {
  const recipients = new Set<string>(sealedTo(bytes));
  const committee = await loadCommittee(ctx.transport, attestor);
  const missing = (committee === null ? [attestor] : committee.members).filter((reader) => !recipients.has(reader));
  return missing.length === 0 ? [] : [notSealedTo(missing, committee !== null)];
}

export async function specPreflight(ctx: AgentContext, found: SpecRead, specHash: string, attestor: Address, openers?: readonly DeliveryOpener[]): Promise<Preflight> {
  if ("problem" in found) {
    return { lines: [found.problem === tooLarge(MAX_SPEC_BYTES) ? SPEC_TOO_LARGE : `spec_url ${found.problem}; publish it or workers cannot read the job`], readers: [] };
  }
  const sealed = isSealed(found.bytes);
  const lines = sealed ? await unreadBy(ctx, found.bytes, attestor) : [];
  const readers = sealed ? [...new Set<string>(sealedTo(found.bytes))].sort() : [];
  const opened = await openedSpec(ctx, found.bytes, openers);
  if (opened === undefined) {
    return { lines: [...lines, SEALED_UNCHECKED], readers };
  }
  const sha256 = createHash("sha256").update(opened).digest("hex");
  const malformed = runProblem(opened);
  if (malformed !== undefined) {
    lines.push(malformedRun(malformed));
    return { lines, readers, malformed };
  }
  if (sha256 !== specHash.toLowerCase()) {
    lines.push(`spec_url ${opened === found.bytes ? "hashes" : "opens to a spec that hashes"} to ${sha256}, not spec_hash ${specHash}; publish the exact bytes, or fix spec_hash`);
    return { lines, readers, wrong: true };
  }
  return { lines, readers };
}

export const CLAIMS_TOGETHER = "give claim_stake and claim_secs together, or neither";

export const CLAIMS_NEED_SPEC = "claims need spec_hash, since only a proof escrow takes claims";

export const claimInputs = {
  claim_stake: optional(text(`whole SOL a worker stakes to claim the job, such as 0.01: 0, or at least the rent-exempt minimum of an empty account on the cluster; with claim_secs it opens claims, so one worker at a time can be paid; on a spec sealed at spec_url only the workers it invites may claim; needs spec_hash`)),
  claim_secs: optional(integer(1, MAX_CLAIM_SECS, "the longest a worker may hold the job by claiming it, in seconds; with claim_stake")),
  review_secs: optional(integer(0, MAX_REVIEW_SECS, `with claims: the seconds the judge has to release or reject the holder's first delivery, during which this wallet cannot cancel; 0, or ${MIN_REVIEW_SECS} to ${MAX_REVIEW_SECS}; default ${DEFAULT_REVIEW_SECS}`)),
  kill_fee: optional(text("with claims: whole SOL this wallet locks on the claims board and pays the holder if the judge neither releases nor rejects its delivery in the review window; 0 or at least the rent-exempt minimum; default the claim stake, or 0 without a stake or review")),
};

type Claims = ClaimTerms & { line: string; lines: string[] };

export const claimsLine = (secs: number, stake: string, every: boolean) =>
  `Opens: claims on ${every ? "every piece" : "the escrow"}; a worker can hold the job for up to ${secs} seconds by staking ${stake} SOL`;

type ReviewInput = { review_secs?: number | undefined; kill_fee?: string | undefined };

export function reviewOf(input: ReviewInput, stake: bigint, floor: bigint | undefined): { reviewSecs: number; killFee: bigint } {
  const reviewSecs = input.review_secs ?? DEFAULT_REVIEW_SECS;
  const killFee = input.kill_fee === undefined ? (reviewSecs === 0 ? 0n : stake) : raw(input.kill_fee, 9, "kill_fee");
  try {
    checkReviewTerms(reviewSecs, killFee, stake, floor);
  } catch (error) {
    const path = reviewSecs !== 0 && (reviewSecs < MIN_REVIEW_SECS || reviewSecs > MAX_REVIEW_SECS) ? "review_secs" : "kill_fee";
    throw new InvalidInput([{ path, message: `a review window is 0 or ${MIN_REVIEW_SECS} to ${MAX_REVIEW_SECS} seconds; a kill fee needs a review window and a claim stake, is 0 or at least the rent-exempt minimum, and is at most ${formatAmount(MAX_CLAIM_STAKE, 9)} SOL: ${error instanceof Error ? error.message : String(error)}` }]);
  }
  return { reviewSecs, killFee };
}

export function escrowExpiresIn(given: number | undefined, claims: { maxSecs: number; reviewSecs?: number } | undefined, base: number): number {
  const review = claims?.reviewSecs ?? 0;
  if (given === undefined) {
    return base + review;
  }
  if (claims !== undefined && review > 0 && given < claims.maxSecs + review) {
    throw new InvalidInput([{ path: "expires_in", message: `must be at least claim_secs plus review_secs, ${claims.maxSecs + review} seconds, so a worker can claim the job and the judge still has the whole review window before expiry; or give a shorter review_secs` }]);
  }
  return given;
}

export async function claimTerms(input: { claim_stake?: string | undefined; claim_secs?: number | undefined } & ReviewInput, every: boolean, transport: Transport): Promise<Claims | undefined> {
  if (input.claim_stake === undefined && input.claim_secs === undefined) {
    if (input.review_secs !== undefined || input.kill_fee !== undefined) {
      throw new InvalidInput([{ path: input.review_secs !== undefined ? "review_secs" : "kill_fee", message: "a review needs claims: give claim_stake and claim_secs too" }]);
    }
    return undefined;
  }
  if (input.claim_stake === undefined || input.claim_secs === undefined) {
    throw new InvalidInput([{ path: input.claim_stake === undefined ? "claim_stake" : "claim_secs", message: CLAIMS_TOGETHER }]);
  }
  const stake = raw(input.claim_stake, 9, "claim_stake");
  if (stake > MAX_CLAIM_STAKE) {
    throw new InvalidInput([{ path: "claim_stake", message: `must be at most ${formatAmount(MAX_CLAIM_STAKE, 9)}` }]);
  }
  const floor = stake > 0n || (input.kill_fee !== undefined && input.kill_fee.trim() !== "0") ? await claimFloor(transport) : undefined;
  if (floor !== undefined && stake > 0n && stake < floor) {
    throw new InvalidInput([{ path: "claim_stake", message: stakeBelowRent(floor) }]);
  }
  const maxSecs = input.claim_secs;
  const review = reviewOf(input, stake, floor);
  const line = claimsLine(maxSecs, formatAmount(stake, 9), every);
  return { line, lines: [reviewLine(review.reviewSecs, review.killFee), line], maxSecs, stake, ...review, ...(floor === undefined ? {} : { floor }) };
}

