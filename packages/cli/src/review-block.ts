import { type Address, isAddress } from "@solana/kit";
import { ambiguous, blockFields, readBlocks, specText, strayFence } from "./spec-blocks.js";
import { JudgeRefused } from "./judge-errors.js";

export const REVIEW_FENCE = "judge-review";
export const REVIEW_FIELDS = ["reviewers", "threshold"] as const;
export const MAX_REVIEWERS = 16;

export type ReviewPins = { reviewers: Address[]; threshold: number };

export type ReviewBlockRead = { pins: ReviewPins | undefined } | { problem: string };

export const REVIEWERS_RULE = `a list of 1 to ${MAX_REVIEWERS} distinct wallet addresses`;

export const thresholdRule = (count: number): string => `a whole number from 1 to ${count}, the number of reviewers`;

class Problem {
  constructor(readonly why: string) {}
}

const refused = (why: string): never => {
  throw new Problem(`the spec's ${REVIEW_FENCE} block ${why}`);
};

const ODD_ENDS = /\r(?!\n)|[\u2028\u2029]/;

function utf8(spec: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(spec);
    return true;
  } catch {
    return false;
  }
}

const shown = (value: unknown): string => (JSON.stringify(value) ?? String(value)).slice(0, 80);

function reviewersOf(value: unknown): Address[] {
  const fits =
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= MAX_REVIEWERS &&
    value.every((one) => typeof one === "string" && isAddress(one)) &&
    new Set(value).size === value.length;
  return fits ? (value as Address[]) : refused(value === undefined ? `has no reviewers, which must be ${REVIEWERS_RULE}` : `has reviewers ${shown(value)}, which is not ${REVIEWERS_RULE}`);
}

function pinsOf(spec: Uint8Array): ReviewPins | undefined {
  const text = specText(spec);
  const read = readBlocks(text, REVIEW_FENCE);
  if (read.mentions === 0) {
    return undefined;
  }
  if (!utf8(spec)) {
    throw new Problem(`the spec has a ${REVIEW_FENCE} block but is not valid UTF-8, so readers could see its fields differently`);
  }
  if (ODD_ENDS.test(text)) {
    throw new Problem(`the spec has a ${REVIEW_FENCE} block and a line that ends in a lone carriage return, U+2028 or U+2029, which Markdown and the judge would split differently`);
  }
  if (ambiguous(read)) {
    throw new Problem(`the spec ${strayFence(REVIEW_FENCE, read.mentions, read.plain)}`);
  }
  if (read.bodies.length > 1) {
    throw new Problem(`the spec has ${read.bodies.length} ${REVIEW_FENCE} blocks; it may have one`);
  }
  const fields = blockFields(read.bodies[0] ?? "", REVIEW_FIELDS, refused, true);
  const reviewers = reviewersOf(fields["reviewers"]);
  const given = fields["threshold"];
  if (given !== undefined && !(typeof given === "number" && Number.isSafeInteger(given) && given >= 1 && given <= reviewers.length)) {
    return refused(`has threshold ${shown(given)}, which is not ${thresholdRule(reviewers.length)}`);
  }
  return { reviewers, threshold: given ?? reviewers.length };
}

export function readReviewBlock(spec: Uint8Array): ReviewBlockRead {
  try {
    return { pins: pinsOf(spec) };
  } catch (error) {
    if (error instanceof Problem) {
      return { problem: error.why };
    }
    throw error;
  }
}

export function reviewProblem(spec: Uint8Array): string | undefined {
  const read = readReviewBlock(spec);
  return "problem" in read ? read.problem : undefined;
}

export class ReviewBlockRefused extends JudgeRefused {
  constructor(readonly why: string) {
    super(`${why}; nothing was run or paid`);
    this.name = "ReviewBlockRefused";
  }
}

export function reviewPinsOf(spec: Uint8Array): ReviewPins | undefined {
  const read = readReviewBlock(spec);
  if ("problem" in read) {
    throw new ReviewBlockRefused(read.problem);
  }
  return read.pins;
}
