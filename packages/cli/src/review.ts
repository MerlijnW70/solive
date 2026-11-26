import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { type Address, getPublicKeyFromAddress, isAddress, type MessagePartialSigner, type SignatureBytes, verifySignature } from "@solana/kit";
import { signMessageBytes } from "@intent-engine/core/internal";
import { JudgeDeferred, JudgeRefused } from "./judge-errors.js";
import { type ReviewPins, reviewPinsOf } from "./review-block.js";
import { hasHidden } from "./untrusted-text.js";

export const REVIEW_KIND = "judge-review";
export const REVIEW_VERSION = 1;
export const REVIEW_DOMAIN = "judge-review/1\n";
export const REVIEW_REASON_LIMIT = 200;
export const MAX_REVIEW_BYTES = 65_536;
export const MAX_REVIEW_SIGNATURES = 64;
export const REVIEW_VERDICTS = ["pay", "fail"] as const;

export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

export type Binding = { cluster: string; intent: Address; nonce: bigint; specSha256: string; deliveredSha256: string };

export type Statement = Binding & { verdict: ReviewVerdict; reason: string };

export type ReviewSignature = { reviewer: Address; signature: string };

export type Review = Statement & { signatures: ReviewSignature[] };

export type ReviewSeal = { sha256: string; signers: Address[] };

export type Reviewed = ReviewSeal & { verdict: ReviewVerdict; reason: string };

const SHA256 = /^[0-9a-f]{64}$/;
const SIGNATURE = /^[0-9a-f]{128}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,19})$/;
const FILE_KEYS = ["kind", "version", "cluster", "intent", "nonce", "spec_sha256", "delivered_sha256", "verdict", "reason", "signatures"] as const;

export const REASON_RULE = `a reason of 1 to ${REVIEW_REASON_LIMIT} characters with no control or hidden character`;

export const reasonFits = (reason: string): boolean => reason.trim() !== "" && Array.from(reason).length <= REVIEW_REASON_LIMIT && !hasHidden(reason);

export const reviewMessage = (statement: Statement): Uint8Array =>
  new TextEncoder().encode(
    `${REVIEW_DOMAIN}${JSON.stringify([statement.cluster, statement.intent, statement.nonce.toString(), statement.specSha256, statement.deliveredSha256, statement.verdict, statement.reason])}`,
  );

export const reviewSha256 = (statement: Statement): string => createHash("sha256").update(reviewMessage(statement)).digest("hex");

export const statementOf = (review: Review): Statement => ({
  cluster: review.cluster,
  intent: review.intent,
  nonce: review.nonce,
  specSha256: review.specSha256,
  deliveredSha256: review.deliveredSha256,
  verdict: review.verdict,
  reason: review.reason,
});

export const reviewJson = (review: Review): string =>
  `${JSON.stringify(
    {
      kind: REVIEW_KIND,
      version: REVIEW_VERSION,
      cluster: review.cluster,
      intent: review.intent,
      nonce: review.nonce.toString(),
      spec_sha256: review.specSha256,
      delivered_sha256: review.deliveredSha256,
      verdict: review.verdict,
      reason: review.reason,
      signatures: review.signatures,
    },
    null,
    2,
  )}\n`;

export async function signedReview(signer: MessagePartialSigner, statement: Statement, prior: readonly ReviewSignature[] = []): Promise<Review> {
  const signature = Buffer.from(await signMessageBytes(signer, reviewMessage(statement))).toString("hex");
  return { ...statement, signatures: [...prior.filter(({ reviewer }) => reviewer !== signer.address), { reviewer: signer.address, signature }] };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export class ReviewUnreadable extends JudgeDeferred {
  constructor(readonly path: string, readonly why: string) {
    super(`--review ${path} ${why}; nothing was run or paid`);
    this.name = "ReviewUnreadable";
  }
}

export function parsedReview(text: string, path: string): Review {
  const bad = (why: string): never => {
    throw new ReviewUnreadable(path, why);
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return bad("is not JSON");
  }
  if (!isObject(parsed) || parsed["kind"] !== REVIEW_KIND || parsed["version"] !== REVIEW_VERSION) {
    return bad(`is not a version ${REVIEW_VERSION} ${REVIEW_KIND}`);
  }
  const unknown = Object.keys(parsed).find((key) => !(FILE_KEYS as readonly string[]).includes(key));
  if (unknown !== undefined) {
    return bad(`has a field ${JSON.stringify(unknown).slice(0, 40)} a review does not have`);
  }
  const { cluster, intent, nonce, spec_sha256: spec, delivered_sha256: delivered, verdict, reason, signatures } = parsed;
  if (typeof cluster !== "string" || cluster === "" || typeof intent !== "string" || !isAddress(intent)) {
    return bad("names no cluster or no escrow address");
  }
  if (typeof nonce !== "string" || !DECIMAL.test(nonce) || typeof spec !== "string" || !SHA256.test(spec) || typeof delivered !== "string" || !SHA256.test(delivered)) {
    return bad("holds a nonce or sha256 that is not in a review's form");
  }
  if (typeof verdict !== "string" || !(REVIEW_VERDICTS as readonly string[]).includes(verdict)) {
    return bad("has a verdict that is neither pay nor fail");
  }
  if (typeof reason !== "string" || !reasonFits(reason)) {
    return bad(`has a reason that is not ${REASON_RULE}`);
  }
  if (!Array.isArray(signatures) || signatures.length === 0 || signatures.length > MAX_REVIEW_SIGNATURES) {
    return bad(`carries no signatures or more than ${MAX_REVIEW_SIGNATURES}`);
  }
  const signed = signatures.map((one: unknown): ReviewSignature => {
    const fits = isObject(one) && Object.keys(one).length === 2 && typeof one["reviewer"] === "string" && isAddress(one["reviewer"]) && typeof one["signature"] === "string" && SIGNATURE.test(one["signature"]);
    return fits ? { reviewer: one["reviewer"] as Address, signature: one["signature"] as string } : bad("carries a signature that is not a reviewer address and 128 hex digits");
  });
  return { cluster, intent, nonce: BigInt(nonce), specSha256: spec, deliveredSha256: delivered, verdict: verdict as ReviewVerdict, reason, signatures: signed };
}

export async function readReviewFile(path: string): Promise<Review> {
  const found = await lstat(path).catch(() => undefined);
  if (found !== undefined && !found.isFile()) {
    throw new ReviewUnreadable(path, "is not a regular file");
  }
  if (found !== undefined && found.size > MAX_REVIEW_BYTES) {
    throw new ReviewUnreadable(path, `holds more than ${MAX_REVIEW_BYTES} bytes`);
  }
  return parsedReview(await readFile(path, "utf8"), path);
}

export class ReviewRefused extends JudgeDeferred {
  constructor(readonly why: string) {
    super(`${why}; nothing was run or paid`);
    this.name = "ReviewRefused";
  }
}

const named = (pins: ReviewPins): string => `${pins.threshold} of the reviewers ${pins.reviewers.join(", ")}`;

export const noReview = (pins: ReviewPins, at: Binding): string =>
  `the spec needs a signed review by ${named(pins)} of the work with sha256 ${at.deliveredSha256} for escrow ${at.intent}; pass it with --review <file>`;

export const REVIEW_NOT_GATED = "--review is for a spec with a judge-review block, and this spec has none; nothing was run or paid";

export const reviewFailed = (reviewed: Reviewed): string => `the review signed by ${reviewed.signers.join(", ")} says fail: ${reviewed.reason}`;

const differs = (path: string, field: string, held: string, want: string): string => `--review ${path} reviews ${field} ${held}, not ${want}`;

function bindingMismatch(path: string, review: Review, at: Binding): string | undefined {
  const fields: [string, string, string][] = [
    ["the cluster", review.cluster, at.cluster],
    ["the escrow", review.intent, at.intent],
    ["the nonce", review.nonce.toString(), at.nonce.toString()],
    ["the spec sha256", review.specSha256, at.specSha256],
    ["the work sha256", review.deliveredSha256, at.deliveredSha256],
  ];
  const found = fields.find(([, held, want]) => held !== want);
  return found === undefined ? undefined : differs(path, found[0], found[1], found[2]);
}

export async function signatureHolds(statement: Statement, signed: ReviewSignature): Promise<boolean> {
  try {
    return await verifySignature(await getPublicKeyFromAddress(signed.reviewer), Uint8Array.from(Buffer.from(signed.signature, "hex")) as SignatureBytes, reviewMessage(statement));
  } catch {
    return false;
  }
}

export async function reviewedBy(files: readonly { path: string; review: Review }[], at: Binding, pins: ReviewPins): Promise<Reviewed> {
  const [first] = files;
  if (first === undefined) {
    throw new ReviewRefused(noReview(pins, at));
  }
  for (const { path, review } of files) {
    const mismatch = bindingMismatch(path, review, at);
    if (mismatch !== undefined) {
      throw new ReviewRefused(mismatch);
    }
  }
  const statement = statementOf(first.review);
  const sha256 = reviewSha256(statement);
  const other = files.find(({ review }) => reviewSha256(statementOf(review)) !== sha256);
  if (other !== undefined) {
    throw new ReviewRefused(`--review ${other.path} and --review ${first.path} sign different statements: a different verdict or reason; pass reviews of one statement`);
  }
  const counted = new Set<Address>();
  const outside = new Set<Address>();
  for (const { path, review } of files) {
    for (const signed of review.signatures) {
      if (!(await signatureHolds(statement, signed))) {
        throw new ReviewRefused(`--review ${path} carries a signature of ${signed.reviewer} that does not sign its statement`);
      }
      if (pins.reviewers.includes(signed.reviewer)) {
        counted.add(signed.reviewer);
      } else {
        outside.add(signed.reviewer);
      }
    }
  }
  if (counted.size < pins.threshold) {
    const ignored = outside.size === 0 ? "" : `; ${[...outside].join(", ")} ${outside.size === 1 ? "is" : "are"} not among them and ${outside.size === 1 ? "does" : "do"} not count`;
    throw new ReviewRefused(`the reviews carry ${counted.size} signature${counted.size === 1 ? "" : "s"} of the named reviewers, and the spec needs ${named(pins)}${ignored}`);
  }
  return { sha256, signers: [...counted].sort(), verdict: statement.verdict, reason: statement.reason };
}

export async function reviewsOf(paths: readonly string[]): Promise<{ path: string; review: Review }[]> {
  const read: { path: string; review: Review }[] = [];
  for (const path of paths) {
    read.push({ path, review: await readReviewFile(path) });
  }
  return read;
}

export function reviewGate(spec: Uint8Array, reviews: readonly string[] | undefined): ReviewPins | undefined {
  const gate = reviewPinsOf(spec);
  if (gate === undefined && (reviews?.length ?? 0) > 0) {
    throw new JudgeRefused(REVIEW_NOT_GATED);
  }
  return gate;
}
