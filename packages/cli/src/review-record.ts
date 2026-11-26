import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Address, isAddress } from "@solana/kit";
import { MAX_REVIEWERS, type ReviewPins } from "./review-block.js";
import { DIR_MODE, FILE_MODE } from "./judge-receipt.js";
import { settingsDir } from "./wallet.js";

export type Recorded = ReviewPins | { problem: string } | null;

export type SpecRecord = { cluster: string; intent: Address; specSha256: string; review: Recorded };

export type RecordRead = { pins: ReviewPins } | { problem: string } | { ungated: true } | { unknown: string } | undefined;

export const REVIEW_RECORD_DIR = "review-gate";

const SHA256 = /^[0-9a-f]{64}$/;

export const reviewRecordPath = (home: string, intent: Address): string => join(settingsDir(home), REVIEW_RECORD_DIR, `${intent}.json`);

export const recordUnread = (path: string, why: string): string => `this machine's review gate record ${path} ${why}, so it cannot tell whether a judge here found a judge-review block`;

export const recordUnwritten = (path: string, why: string): string =>
  `this machine's review gate record ${path} could not be written (${why}), so later signatures here could not tell this escrow needs a signed review; nothing was run or paid`;

const isPins = (value: unknown): value is ReviewPins => {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const { reviewers, threshold } = value as Record<string, unknown>;
  return (
    Array.isArray(reviewers) &&
    reviewers.length >= 1 &&
    reviewers.length <= MAX_REVIEWERS &&
    reviewers.every((one) => typeof one === "string" && isAddress(one)) &&
    new Set(reviewers).size === reviewers.length &&
    typeof threshold === "number" &&
    Number.isSafeInteger(threshold) &&
    threshold >= 1 &&
    threshold <= reviewers.length
  );
};

const isProblem = (value: unknown): value is { problem: string } =>
  value !== null && typeof value === "object" && Object.keys(value).length === 1 && typeof (value as Record<string, unknown>)["problem"] === "string";

const isRecord = (value: unknown): value is SpecRecord => {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry["cluster"] === "string" &&
    typeof entry["intent"] === "string" &&
    isAddress(entry["intent"]) &&
    typeof entry["specSha256"] === "string" &&
    SHA256.test(entry["specSha256"]) &&
    (entry["review"] === null || isPins(entry["review"]) || isProblem(entry["review"]))
  );
};

const codeOf = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

async function keptRecords(path: string): Promise<{ records: SpecRecord[] } | { unread: string }> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    return codeOf(error) === "ENOENT" ? { records: [] } : { unread: `could not be read (${messageOf(error)})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { unread: "is not valid JSON" };
  }
  if (!Array.isArray(parsed) || !parsed.every(isRecord)) {
    return { unread: "holds an entry that is not a review gate record" };
  }
  return { records: parsed };
}

const at = (cluster: string, intent: Address, specSha256: string) => (entry: SpecRecord) => entry.cluster === cluster && entry.intent === intent && entry.specSha256 === specSha256;

export async function reviewRecordOf(home: string, cluster: string, intent: Address, specSha256: string): Promise<RecordRead> {
  const path = reviewRecordPath(home, intent);
  const kept = await keptRecords(path);
  if ("unread" in kept) {
    return { unknown: recordUnread(path, kept.unread) };
  }
  const found = kept.records.filter(at(cluster, intent, specSha256)).map(({ review }) => review);
  const problem = found.find((review) => review !== null && "problem" in review);
  if (problem !== undefined && problem !== null && "problem" in problem) {
    return { problem: problem.problem };
  }
  const pins = found.find((review) => review !== null && "reviewers" in review);
  if (pins !== undefined && pins !== null && "reviewers" in pins) {
    return { pins };
  }
  return found.length > 0 ? { ungated: true } : undefined;
}

const sameReview = (one: Recorded, two: Recorded): boolean => JSON.stringify(one) === JSON.stringify(two);

export async function keepReviewRecord(home: string, record: SpecRecord): Promise<string | undefined> {
  const path = reviewRecordPath(home, record.intent);
  try {
    const kept = await keptRecords(path);
    if ("unread" in kept) {
      return recordUnwritten(path, `it ${kept.unread}`);
    }
    const same = at(record.cluster, record.intent, record.specSha256);
    const held = kept.records.filter(same);
    if (held.some((entry) => sameReview(entry.review, record.review) || (record.review === null && entry.review !== null))) {
      return undefined;
    }
    await mkdir(join(settingsDir(home), REVIEW_RECORD_DIR), { recursive: true, mode: DIR_MODE });
    const next = `${path}.${process.pid}.tmp`;
    await writeFile(next, `${JSON.stringify([...kept.records.filter((entry) => !same(entry) || entry.review !== null), record], null, 2)}\n`, { mode: FILE_MODE });
    await rename(next, path);
    return undefined;
  } catch (error) {
    return recordUnwritten(path, messageOf(error));
  }
}
