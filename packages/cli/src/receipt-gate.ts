import { createHash } from "node:crypto";
import { type Address, getBase16Decoder } from "@solana/kit";
import { Kind } from "@intent-engine/core";
import { decodeParams } from "@intent-engine/core/internal";
import type { Transport } from "@intent-engine/client";
import { intentAt } from "@intent-engine/client/internal";
import { FAIL_RECEIPT_KIND, RECEIPT_KIND, readReceipt, type ReceiptOutcome, ReceiptRefused, type Route, type StoreOptions, type Stored } from "./judge-receipt.js";
import { sanitized } from "./untrusted-text.js";
import { VIPER_ENGINE_COMMIT, VIPER_WASM_SHA256 } from "./viper.js";
import { REVIEW_FENCE, type ReviewPins } from "./review-block.js";
import { type RecordRead, reviewRecordOf } from "./review-record.js";

export const OVERRIDE_FLAG = "--without-receipt";
export const OVERRIDE_INPUT = "without_receipt";
export const REASON_LIMIT = 200;

export type Target = { cluster: string; owner: Address; nonce: bigint; intent: Address; specSha256: string; deliveredSha256: string; announcement: Address };

export type Unchecked = { reason: string; warning: string };

export type Authority = { by: "receipt"; judge: Address } | { by: "override"; unchecked: Unchecked };

export type Pins = { wasmSha256: string; commit: string };

export const CURRENT_PINS: Pins = { wasmSha256: VIPER_WASM_SHA256, commit: VIPER_ENGINE_COMMIT };

export const EMPTY_REASON = "the override needs a reason: a non-empty text saying why this signature needs no passing judge run";

export const uncheckedWarning = (target: Target, reason: string, want: ReceiptOutcome = "pass"): string =>
  `signed without a judge receipt: nothing checked that a judge run on this machine ${want === "pass" ? "passed" : "failed"} the work with sha256 ${target.deliveredSha256}, announced in ${target.announcement}, against the spec ${target.specSha256} of escrow ${target.intent}; the reason given: ${reason}`;

const differs = (field: string, held: string, want: string): string => `the judge receipt records ${field} ${held}, not ${want}`;

export const REVIEW_GATE_WORDS = "review gate";

export type Gate = { pins: ReviewPins } | { problem: string } | { unknown: string; transient?: true } | { ungated: true };

export const UNGATED: Gate = Object.freeze({ ungated: true as const });

export const NOT_READ = "no spec was read for this signature";

export const unknownGate = (why: string): string => `the review gate is unknown because ${why}`;

export const unknownOverrideRefused = (why: string): string =>
  `${unknownGate(why)}, so this escrow may need a signed review and a signature without a receipt needs a reason that names the ${REVIEW_GATE_WORDS}, with those words`;

export const unknownReceiptRefused = (why: string): string =>
  `${unknownGate(why)}, so no judge receipt can show this escrow needs no signed review; sign only with a reason that names the ${REVIEW_GATE_WORDS}, with those words`;

export const reviewUnchecked = (why: string): string => `the ${REVIEW_GATE_WORDS} was not checked: ${why}`;

const reviewersOf = (pins: ReviewPins): string => `${pins.threshold} of the reviewers ${pins.reviewers.join(", ")}`;

export const reviewOverrideRefused = (pins: ReviewPins): string =>
  `this escrow's spec has a ${REVIEW_FENCE} block that needs a signed review by ${reviewersOf(pins)}, so a signature without a receipt needs a reason that names the ${REVIEW_GATE_WORDS}, with those words`;

export const reviewSkipped = (pins: ReviewPins): string => `the ${REVIEW_GATE_WORDS} was skipped: no signed review by ${reviewersOf(pins)} was checked`;

export const unreviewedReceipt = (pins: ReviewPins): string =>
  `the judge receipt records no signed review by ${reviewersOf(pins)}, which this escrow's spec needs in its ${REVIEW_FENCE} block`;

export function reviewMismatch(route: Route, pins: ReviewPins): string | undefined {
  const signers = new Set(route.review?.signers.filter((signer) => pins.reviewers.includes(signer)) ?? []);
  return route.review === undefined || signers.size < pins.threshold ? unreviewedReceipt(pins) : undefined;
}

const gateProblem = (gate: Gate): string | undefined => ("problem" in gate ? `${gate.problem}, so nothing can be signed for this escrow` : undefined);

function routeMismatch(route: Route, pins: Pins): string | undefined {
  if (route.sandbox === "viper" && route.engine === undefined) {
    return "the judge receipt records a viper run without the engine that ran";
  }
  if (route.engine !== undefined && (route.engine.wasmSha256 !== pins.wasmSha256 || route.engine.commit !== pins.commit)) {
    return differs("the viper engine", `${route.engine.wasmSha256} at ${route.engine.commit}`, `the pinned ${pins.wasmSha256} at ${pins.commit}`);
  }
  if (route.judgeRun !== undefined && (route.sandbox !== "docker" || route.image !== route.judgeRun.image || route.command !== route.judgeRun.run)) {
    return "the judge receipt records a judge-run block that is not the docker run it records";
  }
  if (route.sandbox === "docker" && (route.image === undefined || route.image === "")) {
    return "the judge receipt records a docker run without its image";
  }
  return undefined;
}

export function mismatchOf(receipt: Stored, target: Target, judges: readonly Address[], pins: Pins = CURRENT_PINS, want: ReceiptOutcome = "pass"): string | undefined {
  if (receipt.outcome !== want) {
    return want === "pass"
      ? `the judge receipt records the outcome ${receipt.outcome}, and only a pass authorizes a signature`
      : `the judge receipt records the outcome ${receipt.outcome}, and only a fail authorizes a reject`;
  }
  const fields: [string, string, string][] = [
    ["the cluster", receipt.cluster, target.cluster],
    ["the escrow owner", receipt.owner, target.owner],
    ["the escrow nonce", receipt.nonce.toString(), target.nonce.toString()],
    ["the escrow", receipt.intent, target.intent],
    ["the spec sha256", receipt.specSha256, target.specSha256],
    ["the delivered sha256", receipt.deliveredSha256, target.deliveredSha256],
    ["the announcement", receipt.announcement, target.announcement],
  ];
  for (const [field, held, want] of fields) {
    if (held !== want) {
      return differs(field, held, want);
    }
  }
  if (!judges.includes(receipt.judge)) {
    return differs("the judge", receipt.judge, judges.join(" or "));
  }
  return routeMismatch(receipt.route, pins);
}

export async function authorize(home: string, target: Target, judges: readonly Address[], override: string | undefined, options: StoreOptions = {}, want: ReceiptOutcome = "pass", gate: Gate = { unknown: NOT_READ }): Promise<Authority> {
  const problem = want === "pass" ? gateProblem(gate) : undefined;
  if (problem !== undefined) {
    throw new ReceiptRefused("tampered", problem);
  }
  const pins = want === "pass" && "pins" in gate ? gate.pins : undefined;
  const unknown = want === "pass" && "unknown" in gate ? gate.unknown : undefined;
  if (override !== undefined) {
    const reason = sanitized(override.trim(), REASON_LIMIT);
    if (reason === "") {
      throw new ReceiptRefused("missing", EMPTY_REASON);
    }
    if (pins === undefined && unknown === undefined) {
      return { by: "override", unchecked: { reason, warning: uncheckedWarning(target, reason, want) } };
    }
    if (!reason.toLowerCase().includes(REVIEW_GATE_WORDS)) {
      throw new ReceiptRefused("missing", pins === undefined ? unknownOverrideRefused(unknown ?? NOT_READ) : reviewOverrideRefused(pins));
    }
    const skipped = pins === undefined ? reviewUnchecked(unknown ?? NOT_READ) : reviewSkipped(pins);
    return { by: "override", unchecked: { reason, warning: `${skipped}; ${uncheckedWarning(target, reason, want)}` } };
  }
  if (unknown !== undefined) {
    throw new ReceiptRefused("missing", unknownReceiptRefused(unknown));
  }
  let worst: ReceiptRefused | undefined;
  for (const judge of judges) {
    try {
      const receipt = await readReceipt(home, { cluster: target.cluster, judge, intent: target.intent, announcement: target.announcement, deliveredSha256: target.deliveredSha256 }, options, want === "fail" ? FAIL_RECEIPT_KIND : RECEIPT_KIND);
      const mismatch = mismatchOf(receipt, target, [judge], CURRENT_PINS, want) ?? (pins === undefined ? undefined : reviewMismatch(receipt.route, pins));
      if (mismatch === undefined) {
        return { by: "receipt", judge };
      }
      worst = new ReceiptRefused("tampered", mismatch);
    } catch (error) {
      if (!(error instanceof ReceiptRefused)) {
        throw new ReceiptRefused("unsafe", `the judge receipt could not be read: ${error instanceof Error ? error.message : String(error)}`);
      }
      worst = worst === undefined || worst.problem === "missing" ? error : worst;
    }
  }
  if (worst === undefined || worst.problem === "missing") {
    throw new ReceiptRefused("missing", `no judge receipt on this machine says a judge run of ${judges.join(" or ")} ${want === "pass" ? "passed" : "failed"} the work with sha256 ${target.deliveredSha256}, announced in ${target.announcement}, for escrow ${target.intent}`);
  }
  throw worst;
}

export const boundApproval = (approval: string, authority: Authority | undefined): string =>
  authority === undefined || authority.by === "receipt" ? approval : createHash("sha256").update(approval).update("\n").update(authority.unchecked.reason).digest("hex").slice(0, approval.length);

export const recorded = (authority: Authority | undefined): { unchecked?: Unchecked } => (authority === undefined || authority.by === "receipt" ? {} : { unchecked: authority.unchecked });

export async function proofSpecOf(transport: Transport, intent: Address): Promise<string | undefined> {
  const held = await intentAt(transport, intent);
  if (held === null) {
    return undefined;
  }
  const params = decodeParams(held.kind, Uint8Array.from(held.params));
  return params.kind !== Kind.AttestedResult || params.specHash.every((b) => b === 0) ? undefined : getBase16Decoder().decode(params.specHash).toLowerCase();
}

export function withRecord(held: RecordRead, gate: Gate): Gate {
  if (held === undefined || "problem" in gate) {
    return gate;
  }
  if ("problem" in held || "pins" in held) {
    return held;
  }
  return "unknown" in gate || ("unknown" in held && "ungated" in gate) ? held : gate;
}

export async function authorizeEscrow(home: string | undefined, transport: Transport, at: Omit<Target, "cluster" | "specSha256">, judges: readonly Address[], override: string | undefined, want: ReceiptOutcome = "pass", gate: Gate = { unknown: NOT_READ }): Promise<Authority> {
  const specSha256 = await proofSpecOf(transport, at.intent);
  if (home === undefined || specSha256 === undefined) {
    throw new ReceiptRefused("missing", `escrow ${at.intent} is not an open proof escrow this wallet judges, so no judge receipt can match it`);
  }
  const cluster = await transport.genesisHash();
  const held = want === "pass" ? await reviewRecordOf(home, cluster, at.intent, specSha256) : undefined;
  return authorize(home, { ...at, specSha256, cluster }, judges, override, {}, want, withRecord(held, gate));
}

export const CLI_RECEIPT_NEXT = `run judge on this work first, which saves a receipt when the check passes, or pass ${OVERRIDE_FLAG} <reason> to sign without one; nothing was signed or sent`;

export const cliRefusal = (error: ReceiptRefused): string => `${error.why}; ${CLI_RECEIPT_NEXT}`;

export const CLI_REJECT_NEXT = `run judge on this work first, which saves a receipt when the check fails, or pass ${OVERRIDE_FLAG} <reason> to reject without one; nothing was signed or sent`;
