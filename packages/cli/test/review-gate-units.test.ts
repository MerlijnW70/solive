import { type Address, generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { MAX_REVIEWERS, readReviewBlock, REVIEW_FENCE, type ReviewPins } from "../src/review-block.js";
import { type Binding, parsedReview, type Review, reviewedBy, reviewJson, reviewMessage, ReviewRefused, reviewSha256, signedReview, type Statement, statementOf } from "../src/review.js";
import { authorize, reviewMismatch, reviewOverrideRefused, REVIEW_GATE_WORDS, type Target } from "../src/receipt-gate.js";
import { ReceiptRefused } from "../src/judge-receipt.js";

const encoded = (text: string) => new TextEncoder().encode(text);
const spec = (body: string) => encoded(`# Job\n\n\`\`\`${REVIEW_FENCE}\n${body}\n\`\`\`\n`);

let a: KeyPairSigner;
let b: KeyPairSigner;
let c: KeyPairSigner;
let outsider: KeyPairSigner;
let intent: Address;
let at: Binding;
let pins: ReviewPins;

beforeAll(async () => {
  [a, b, c, outsider] = [await generateKeyPairSigner(), await generateKeyPairSigner(), await generateKeyPairSigner(), await generateKeyPairSigner()];
  intent = (await generateKeyPairSigner()).address;
  at = { cluster: "genesis-of-the-test-cluster", intent, nonce: 4n, specSha256: "a1".repeat(32), deliveredSha256: "b2".repeat(32) };
  pins = { reviewers: [a.address, b.address, c.address], threshold: 2 };
});

const statement = (verdict: "pay" | "fail" = "pay", over: Partial<Statement> = {}): Statement => ({ ...at, verdict, reason: "read the code and reran the gates", ...over });

const file = (review: Review, path = "review.json") => ({ path, review: parsedReview(reviewJson(review), path) });

async function refusal(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof ReviewRefused || error instanceof ReceiptRefused) {
      return error.message;
    }
    throw error;
  }
  throw new Error("nothing was refused");
}

describe("the judge-review block", () => {
  it("reads the reviewers and the threshold, which defaults to every reviewer", () => {
    expect(readReviewBlock(spec(JSON.stringify({ reviewers: [a.address, b.address], threshold: 1 })))).toEqual({ pins: { reviewers: [a.address, b.address], threshold: 1 } });
    expect(readReviewBlock(spec(JSON.stringify({ reviewers: [a.address, b.address] })))).toEqual({ pins: { reviewers: [a.address, b.address], threshold: 2 } });
    expect(readReviewBlock(encoded("# Job\n\nno block\n"))).toEqual({ pins: undefined });
  });

  const bad: [string, string, string][] = [
    ["an unknown field", JSON.stringify({ reviewers: ["x"], judge: 1 }), "it does not know"],
    ["no reviewers", JSON.stringify({ threshold: 1 }), "has no reviewers"],
    ["a reviewer twice", `{"reviewers": ["${"1".repeat(32)}", "${"1".repeat(32)}"]}`, "distinct wallet addresses"],
    ["a reviewer that is no address", JSON.stringify({ reviewers: ["not-an-address"] }), "distinct wallet addresses"],
    ["a threshold over the reviewers", `{"reviewers": ["${"1".repeat(32)}"], "threshold": 2}`, "from 1 to 1"],
    ["a threshold of zero", `{"reviewers": ["${"1".repeat(32)}"], "threshold": 0}`, "from 1 to 1"],
    ["a field twice", `{"reviewers": ["${"1".repeat(32)}"], "threshold": 1, "threshold": 1}`, "more than once"],
    ["too many reviewers", JSON.stringify({ reviewers: Array.from({ length: MAX_REVIEWERS + 1 }, (_, i) => `${i}`) }), "distinct wallet addresses"],
  ];
  for (const [name, body, says] of bad) {
    it(`refuses a block with ${name}`, () => {
      const read = readReviewBlock(spec(body));
      expect("problem" in read ? read.problem : "").toContain(says);
    });
  }

  it("refuses a second block and a fence that is not a plain top-level line", () => {
    const one = `\`\`\`${REVIEW_FENCE}\n{"reviewers": ["${"1".repeat(32)}"]}\n\`\`\`\n`;
    expect(readReviewBlock(encoded(`${one}${one}`))).toEqual({ problem: expect.stringContaining("2 judge-review blocks") });
    expect(readReviewBlock(encoded(`> ${one}`))).toEqual({ problem: expect.stringContaining("plain top-level") });
  });
});

describe("the review statement", () => {
  it("signs every binding field, the verdict and the reason", () => {
    const base = reviewSha256(statement());
    const changed: Partial<Statement>[] = [
      { cluster: "another-cluster" },
      { intent: a.address },
      { nonce: 5n },
      { specSha256: "c3".repeat(32) },
      { deliveredSha256: "d4".repeat(32) },
      { verdict: "fail" },
      { reason: "another reason" },
    ];
    for (const over of changed) {
      expect(reviewSha256(statement("pay", over)), Object.keys(over).join()).not.toBe(base);
    }
    expect(new TextDecoder().decode(reviewMessage(statement()))).toContain(at.deliveredSha256);
  });

  it("refuses a file with a field a review does not have, such as its own reviewer list", async () => {
    const signed = JSON.parse(reviewJson(await signedReview(a, statement()))) as Record<string, unknown>;
    expect(() => parsedReview(JSON.stringify({ ...signed, reviewers: [outsider.address] }), "r.json")).toThrow("a review does not have");
  });
});

describe("a review against the pinned reviewers", () => {
  it("passes a pay review signed by the threshold of named reviewers and names its signers", async () => {
    const review = await signedReview(b, statement(), (await signedReview(a, statement())).signatures);
    expect(await reviewedBy([file(review)], at, pins)).toEqual({ sha256: reviewSha256(statement()), signers: [a.address, b.address].sort(), verdict: "pay", reason: statement().reason });
  });

  it("pools the signatures of several files of one statement", async () => {
    const [one, two] = [await signedReview(a, statement()), await signedReview(c, statement())];
    expect((await reviewedBy([file(one, "a.json"), file(two, "c.json")], at, pins)).signers).toEqual([a.address, c.address].sort());
  });

  const mismatches: [string, () => Partial<Statement>, string][] = [
    ["cluster", () => ({ cluster: "another-cluster" }), "the cluster"],
    ["escrow", () => ({ intent: outsider.address }), "the escrow"],
    ["nonce", () => ({ nonce: 9n }), "the nonce"],
    ["spec", () => ({ specSha256: "c3".repeat(32) }), "the spec sha256"],
    ["work", () => ({ deliveredSha256: "d4".repeat(32) }), "the work sha256"],
  ];
  for (const [name, over, field] of mismatches) {
    it(`refuses a review of another ${name}`, async () => {
      const wrong = { ...statement(), ...over() };
      const review = await signedReview(b, wrong, (await signedReview(a, wrong)).signatures);
      expect(await refusal(() => reviewedBy([file(review)], at, pins))).toContain(`reviews ${field} `);
    });
  }

  it("refuses a review whose work sha256 was rewritten after it was signed", async () => {
    const other = statement("pay", { deliveredSha256: "d4".repeat(32) });
    const signed = await signedReview(b, other, (await signedReview(a, other)).signatures);
    const rewritten = { ...signed, deliveredSha256: at.deliveredSha256 };
    expect(await refusal(() => reviewedBy([file(rewritten)], at, pins))).toContain("does not sign its statement");
  });

  it("does not count a key outside the spec's reviewers", async () => {
    const review = await signedReview(outsider, statement(), (await signedReview(a, statement())).signatures);
    const refused = await refusal(() => reviewedBy([file(review)], at, pins));
    expect(refused).toContain("carry 1 signature of the named reviewers");
    expect(refused).toContain(`${outsider.address} is not among them`);
  });

  it("refuses a review under the threshold", async () => {
    const lone = file(await signedReview(a, statement()));
    expect(await refusal(() => reviewedBy([lone], at, pins))).toContain("needs 2 of the reviewers");
  });

  it("counts a reviewer who signed twice once", async () => {
    const one = await signedReview(a, statement());
    const twice: Review = { ...one, signatures: [...one.signatures, ...one.signatures] };
    expect(await refusal(() => reviewedBy([file(twice)], at, pins))).toContain("carry 1 signature");
    expect(await refusal(() => reviewedBy([file(one, "a.json"), file(one, "again.json")], at, pins))).toContain("carry 1 signature");
  });

  it("refuses reviews of two different statements", async () => {
    const [pay, fail] = [await signedReview(a, statement()), await signedReview(b, statement("fail"))];
    expect(await refusal(() => reviewedBy([file(pay, "pay.json"), file(fail, "fail.json")], at, pins))).toContain("sign different statements");
  });

  it("refuses no review at all, naming the reviewers", async () => {
    const refused = await refusal(() => reviewedBy([], at, pins));
    expect(refused).toContain(a.address);
    expect(refused).toContain("--review");
  });

  it("returns a fail review as a fail with its reason", async () => {
    const review = await signedReview(b, statement("fail"), (await signedReview(a, statement("fail"))).signatures);
    expect(await reviewedBy([file(review)], at, pins)).toMatchObject({ verdict: "fail", reason: statement().reason });
    expect(statementOf(review).verdict).toBe("fail");
  });
});

describe("the receipt gate for a review-gated escrow", () => {
  const target = (): Target => ({ cluster: at.cluster, owner: a.address, nonce: at.nonce, intent: at.intent, specSha256: at.specSha256, deliveredSha256: at.deliveredSha256, announcement: b.address });

  it("needs a receipt whose review was signed by the threshold of the named reviewers, each counted once", () => {
    const route = { sandbox: "none" as const, command: "true" };
    expect(reviewMismatch(route, pins)).toContain("records no signed review");
    expect(reviewMismatch({ ...route, review: { sha256: "e5".repeat(32), signers: [a.address, a.address] } }, pins)).toContain("records no signed review");
    expect(reviewMismatch({ ...route, review: { sha256: "e5".repeat(32), signers: [a.address, outsider.address] } }, pins)).toContain("records no signed review");
    expect(reviewMismatch({ ...route, review: { sha256: "e5".repeat(32), signers: [a.address, c.address] } }, pins)).toBeUndefined();
  });

  it("refuses an override on a gated escrow unless its reason names the review gate, and then warns that it was skipped", async () => {
    const home = "/nonexistent-home-for-overrides";
    const refused = await refusal(() => authorize(home, target(), [a.address], "the hirer checked it by hand", {}, "pass", { pins }));
    expect(refused).toBe(reviewOverrideRefused(pins));
    const named = await authorize(home, target(), [a.address], `skip the ${REVIEW_GATE_WORDS}: the reviewer lost their key`, {}, "pass", { pins });
    expect(named).toMatchObject({ by: "override" });
    expect(named.by === "override" ? named.unchecked.warning : "").toMatch(/^the review gate was skipped: no signed review by 2 of the reviewers/);
    const plain = await authorize(home, target(), [a.address], "the hirer checked it by hand", {}, "pass", undefined);
    expect(plain.by === "override" ? plain.unchecked.warning : "").not.toContain(REVIEW_GATE_WORDS);
  });

  it("refuses anything at all for an escrow whose spec has a malformed block", async () => {
    expect(await refusal(() => authorize("/nonexistent", target(), [a.address], `${REVIEW_GATE_WORDS} skipped`, {}, "pass", { problem: "the spec's judge-review block is bad" }))).toContain("nothing can be signed");
  });
});
