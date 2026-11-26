import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import { IntentStatus, Kind } from "@intent-engine/core";
import { sortMembers, specMemo } from "@intent-engine/core/internal";
import { createClient } from "@intent-engine/client/node";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, main } from "../src/main.js";
import { EXIT_REFUSED } from "../src/judge-errors.js";
import { FAIL_RECEIPT_KIND, readReceipt, writeReceipt } from "../src/judge-receipt.js";
import { REVIEW_FENCE } from "../src/review-block.js";
import { parsedReview, REVIEW_NOT_GATED, reviewJson, reviewSha256, signedReview, type Statement } from "../src/review.js";
import { REVIEW_GATE_WORDS, reviewOverrideRefused, unknownOverrideRefused, unknownReceiptRefused } from "../src/receipt-gate.js";
import { specDiffers } from "../src/review-gate.js";
import { reviewRecordOf } from "../src/review-record.js";
import { REVIEW_ADD_ALONE } from "../src/arg-review.js";
import { REVIEW_NOT_SIGNED } from "../src/review-commands.js";
import { announced, keyed } from "./announce.js";
import { cli, creation, funded, h, HOME, NOW, ownerSigned, runtime, transport, world } from "./harness.js";
import { job, type Job, judging, paidTo, SPEC, status } from "./judge-kit.js";

const REASON = "read the code and reran every gate";
const SPEC_URL = "https://" + "example.org/jobs/reviewed.md";
const sha = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
const gated = (reviewers: readonly Address[], threshold?: number) =>
  `${SPEC}\n\`\`\`${REVIEW_FENCE}\n${JSON.stringify({ reviewers, ...(threshold === undefined ? {} : { threshold }) })}\n\`\`\`\n`;

type Scene = { j: Job; text: string; r1: KeyPairSigner; r2: KeyPairSigner; outsider: KeyPairSigner; keys: Record<string, KeyPairSigner> };

async function scene(threshold?: number): Promise<Scene> {
  const [r1, r2, outsider] = [await generateKeyPairSigner(), await generateKeyPairSigner(), await generateKeyPairSigner()];
  const text = gated([r1.address, r2.address], threshold);
  const j = await job(text);
  return { j, text, r1, r2, outsider, keys: { "judge.json": j.judge } };
}

const statementOf = async (s: Scene, over: Partial<Statement> = {}): Promise<Statement> => ({
  cluster: await transport.genesisHash(),
  intent: s.j.intent,
  nonce: 0n,
  specSha256: sha(s.text),
  deliveredSha256: s.j.sha256,
  verdict: "pay",
  reason: REASON,
  ...over,
});

async function reviewFile(s: Scene, signers: readonly KeyPairSigner[], over: Partial<Statement> = {}, name = "review.json"): Promise<string> {
  const statement = await statementOf(s, over);
  let signatures: { reviewer: Address; signature: string }[] = [];
  for (const signer of signers) {
    signatures = (await signedReview(signer, statement, signatures)).signatures;
  }
  const path = join(s.j.dir, name);
  await writeFile(path, reviewJson({ ...statement, signatures }));
  return path;
}

const placeOf = async (s: Scene) => ({ cluster: await transport.genesisHash(), judge: s.j.judge.address, intent: s.j.intent, announcement: s.j.first.announcement, deliveredSha256: s.j.sha256 });

describe("judge on a review-gated spec", () => {
  let s: Scene;

  beforeEach(async () => {
    s = await scene();
  });

  it("pays on a pay review of its reviewers and records the review's sha256 and signers in the verdict and the receipt", async () => {
    const path = await reviewFile(s, [s.r1, s.r2]);
    const sent = await cli(judging(s.j, "true", "--review", path, "--yes"), s.keys);
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
    const signers = [s.r1.address, s.r2.address].sort();
    const statementSha = reviewSha256(await statementOf(s));
    expect(sent.json()).toMatchObject({ verdict: "pass", signature: expect.any(String), review: { sha256: statementSha, signers, verdict: "pay", reason: REASON } });
    expect(status(s.j.intent)).toBe(IntentStatus.Filled);
    expect(await paidTo(s.j, s.j.worker.address)).toBeGreaterThan(0n);
    expect((await readReceipt(HOME, await placeOf(s))).route.review).toEqual({ sha256: statementSha, signers });
  });

  it("refuses without a review, runs and pays nothing and saves no receipt", async () => {
    const refused = await cli(judging(s.j, "true", "--yes"), s.keys);
    expect(refused.code).toBe(EXIT_REFUSED);
    expect(refused.err).toContain("the spec needs a signed review by 2 of the reviewers");
    expect(refused.err).toContain(s.r1.address);
    await expect(readReceipt(HOME, await placeOf(s))).rejects.toMatchObject({ problem: "missing" });
    expect(status(s.j.intent)).toBe(IntentStatus.Open);
  });

  const mismatches: [string, (s: Scene) => Promise<Partial<Statement>>, string][] = [
    ["cluster", async () => ({ cluster: "another-cluster" }), "the cluster"],
    ["escrow", async () => ({ intent: (await generateKeyPairSigner()).address }), "the escrow"],
    ["nonce", async () => ({ nonce: 1n }), "the nonce"],
    ["spec", async () => ({ specSha256: sha("another spec") }), "the spec sha256"],
    ["work", async () => ({ deliveredSha256: sha("other work") }), "the work sha256"],
  ];
  for (const [name, over, field] of mismatches) {
    it(`refuses a review of another ${name} and pays nothing`, async () => {
      const path = await reviewFile(s, [s.r1, s.r2], await over(s));
      const refused = await cli(judging(s.j, "true", "--review", path, "--yes"), s.keys);
      expect(refused.code).toBe(EXIT_REFUSED);
      expect(refused.err).toContain(`reviews ${field} `);
      await expect(readReceipt(HOME, await placeOf(s))).rejects.toMatchObject({ problem: "missing" });
      expect(status(s.j.intent)).toBe(IntentStatus.Open);
    });
  }

  it("refuses a review whose work sha256 was rewritten after the reviewers signed another", async () => {
    const path = await reviewFile(s, [s.r1, s.r2], { deliveredSha256: sha("other work") });
    const held = parsedReview(await readFile(path, "utf8"), path);
    await writeFile(path, reviewJson({ ...held, deliveredSha256: s.j.sha256 }));
    const refused = await cli(judging(s.j, "true", "--review", path, "--yes"), s.keys);
    expect(refused.code).toBe(EXIT_REFUSED);
    expect(refused.err).toContain("does not sign its statement");
    expect(status(s.j.intent)).toBe(IntentStatus.Open);
  });

  it("does not count a key outside the spec, refuses under the threshold and counts a repeated reviewer once", async () => {
    const outside = await reviewFile(s, [s.r1, s.outsider], {}, "outside.json");
    const one = await reviewFile(s, [s.r1], {}, "one.json");
    for (const argv of [["--review", outside], ["--review", one], ["--review", one, "--review", one]]) {
      const refused = await cli(judging(s.j, "true", ...argv, "--yes"), s.keys);
      expect(refused.code, argv.join(" ")).toBe(EXIT_REFUSED);
      expect(refused.err).toContain("carry 1 signature of the named reviewers, and the spec needs 2");
    }
    expect(status(s.j.intent)).toBe(IntentStatus.Open);
    const both = await reviewFile(s, [s.r2], {}, "two.json");
    const paid = await cli(judging(s.j, "true", "--review", one, "--review", both, "--yes"), s.keys);
    expect([paid.code, paid.err]).toEqual([EXIT_OK, ""]);
  });

  it("fails on a fail review whatever the check says, and saves a fail receipt with the review for reject", async () => {
    const path = await reviewFile(s, [s.r1, s.r2], { verdict: "fail", reason: "the tests are faked" });
    const failed = await cli(judging(s.j, "true", "--review", path, "--yes"), s.keys);
    expect(failed.code).toBe(EXIT_FAILED);
    expect(failed.json()).toMatchObject({ verdict: "fail", signature: null, review: { verdict: "fail", reason: "the tests are faked" } });
    expect(status(s.j.intent)).toBe(IntentStatus.Open);
    const kept = await readReceipt(HOME, await placeOf(s), {}, FAIL_RECEIPT_KIND);
    expect(kept).toMatchObject({ outcome: "fail", route: { review: { signers: [s.r1.address, s.r2.address].sort() } } });
    const rejected = await cli(["reject", "--keypair", "judge.json", "--owner", s.j.w.owner.address, "--nonce", "0", "--announcement", s.j.first.announcement, "--sha256", s.j.sha256, "--yes"], s.keys);
    expect([rejected.code, rejected.err]).toEqual([EXIT_OK, ""]);
  });

  it("lets a threshold below every reviewer pay on that many signatures", async () => {
    const low = await scene(1);
    const path = await reviewFile(low, [low.r2]);
    const sent = await cli(judging(low.j, "true", "--review", path, "--yes"), low.keys);
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
  });
});

describe("judge on a spec without a judge-review block", () => {
  it("refuses --review and otherwise judges as before, with no review in the verdict or the receipt", async () => {
    const j = await job();
    const keys = { "judge.json": j.judge };
    const path = join(j.dir, "review.json");
    await writeFile(path, "{}");
    const refused = await cli(judging(j, "true", "--review", path), keys);
    expect(refused.code).toBe(EXIT_REFUSED);
    expect(refused.err).toContain(REVIEW_NOT_GATED);
    const passed = await cli(judging(j, "true"), keys);
    expect([passed.code, passed.err]).toEqual([EXIT_OK, ""]);
    expect(passed.json()).not.toHaveProperty("review");
    const at = { cluster: await transport.genesisHash(), judge: j.judge.address, intent: j.intent, announcement: j.first.announcement, deliveredSha256: j.sha256 };
    expect((await readReceipt(HOME, at)).route).toEqual({ sandbox: "none", command: "true" });
  });

  it("refuses a spec whose judge-review block is malformed", async () => {
    const j = await job(`${SPEC}\n\`\`\`${REVIEW_FENCE}\n{"reviewers": []}\n\`\`\`\n`);
    const refused = await cli(judging(j, "true"), { "judge.json": j.judge });
    expect(refused.code).toBe(EXIT_REFUSED);
    expect(refused.err).toContain("judge-review block has reviewers []");
  });
});

describe("judge --watch on a review-gated spec", () => {
  async function watch(s: Scene, argv: string[]) {
    const out: string[] = [];
    const err: string[] = [];
    const base = runtime(s.keys);
    let sleeps = 0;
    const code = await main(argv, { ...base, sleep: async () => ++sleeps < 2 }, { out: (t) => out.push(t), err: (t) => err.push(t) });
    return { code, err: err.join("\n"), lines: out.map((o) => JSON.parse(o) as Record<string, unknown>) };
  }

  it("defers work without a review of it and pays the work its reviewers signed", async () => {
    const [r1, r2] = [await generateKeyPairSigner(), await generateKeyPairSigner()];
    const text = gated([r1.address, r2.address]);
    const module = "42\n";
    const j = await job(text, sha(module));
    const s: Scene = { j, text, r1, r2, outsider: r1, keys: { "judge.json": j.judge } };
    h.specPages.set("https://" + "example.org/work.tar", new TextEncoder().encode(module));
    const argv = ["judge", "--keypair", "judge.json", "--owner", j.w.owner.address, "--nonce", "0", "--spec", j.spec, "--run", "true", "--sandbox", "none", "--i-trust-this-work", "--watch", "--yes"];
    const unreviewed = await watch(s, argv);
    expect(unreviewed.code).toBe(EXIT_OK);
    expect(unreviewed.lines[0]).toMatchObject({ verdict: "retry", outcome: "deferred", reason: expect.stringContaining("the spec needs a signed review") });
    expect(status(j.intent)).toBe(IntentStatus.Open);
    const path = await reviewFile(s, [r1, r2]);
    const reviewed = await watch(s, [...argv, "--review", path]);
    expect(reviewed.code).toBe(EXIT_OK);
    expect(reviewed.lines).toContainEqual(expect.objectContaining({ verdict: "pass", signature: expect.any(String), review: expect.objectContaining({ verdict: "pay" }) }));
    expect(status(j.intent)).toBe(IntentStatus.Filled);
  });
});

async function panel() {
  const [r1, r2] = [await generateKeyPairSigner(), await generateKeyPairSigner()];
  const text = gated([r1.address, r2.address]);
  const w = await world();
  const members = [await funded(), await funded()] as const;
  const payer = await funded();
  const worker = await keyed();
  const keys: Record<string, KeyPairSigner> = { "payer.json": payer, "m0.json": members[0] as KeyPairSigner, "m1.json": members[1] as KeyPairSigner };
  const addresses = sortMembers(members.map((m) => m.address));
  const created = await cli(["committee", "create", "--keypair", "payer.json", "--members", addresses.join(","), "--threshold", "2", "--fee-wallet", payer.address, "--yes"], keys);
  expect([created.code, created.err]).toEqual([EXIT_OK, ""]);
  const committee = created.json()["committee"] as Address;
  const dir = await mkdtemp(join(tmpdir(), "review-committee-"));
  const spec = join(dir, "spec.md");
  const artifact = join(dir, "answer.txt");
  await writeFile(spec, text);
  await writeFile(artifact, "42\n");
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: committee, specHash: Uint8Array.from(Buffer.from(sha(text), "hex")), judgeFee: 0n } as const;
  const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  h.specPages.set(SPEC_URL, new TextEncoder().encode(text));
  h.engineLog = [{ ...creation(intent), ...ownerSigned(intent, [specMemo(SPEC_URL)]) }];
  const made = await announced(intent, worker, sha("42\n"), "https://" + "example.org/answer.txt");
  const statement: Statement = { cluster: await transport.genesisHash(), intent, nonce: 0n, specSha256: sha(text), deliveredSha256: sha("42\n"), verdict: "pay", reason: REASON };
  const review = join(dir, "review.json");
  await writeFile(review, reviewJson(await signedReview(r2, statement, (await signedReview(r1, statement)).signatures)));
  const judging = (member: string, ...more: string[]) => ["judge", "--keypair", member, "--owner", w.owner.address, "--nonce", "0", "--spec", spec, "--artifact", artifact, "--run", "true", "--sandbox", "none", "--i-trust-this-work", ...more];
  const vote = (member: string, ...more: string[]) => ["committee", "vote", "--keypair", member, "--owner", w.owner.address, "--nonce", "0", "--result", "1", "--sha256", sha("42\n"), ...more];
  return { w, keys, committee, intent, made, review, judging, vote, members, statement, spec, r1, r2 };
}

describe("a committee on a review-gated spec", () => {
  it("gives a member's vote from judge only with the review", async () => {
    const p = await panel();
    const refused = await cli(p.judging("m0.json"), p.keys);
    expect(refused.code).toBe(EXIT_REFUSED);
    expect(refused.err).toContain("the spec needs a signed review");
    const voted = await cli(p.judging("m0.json", "--review", p.review), p.keys);
    expect([voted.code, voted.err]).toEqual([EXIT_OK, ""]);
    expect(voted.json()).toMatchObject({ verdict: "pass", vote: { member: (p.members[0] as KeyPairSigner).address } });
  });

  it("committee vote refuses a receipt with no review, and an override whose reason does not name the review gate", async () => {
    const p = await panel();
    const member = p.members[1] as KeyPairSigner;
    await writeReceipt(HOME, {
      outcome: "pass",
      cluster: await transport.genesisHash(),
      judge: member.address,
      owner: p.w.owner.address,
      nonce: 0n,
      intent: p.intent,
      specSha256: p.statement.specSha256,
      deliveredSha256: p.statement.deliveredSha256,
      announcement: p.made.announcement,
      route: { sandbox: "none", command: "true" },
    });
    const reused = await cli(p.vote("m1.json", "--yes"), p.keys);
    expect(reused.code).toBe(EXIT_FAILED);
    expect(reused.err).toContain("records no signed review");
    const override = await cli(p.vote("m1.json", "--without-receipt", "the member checked it by hand", "--yes"), p.keys);
    expect(override.code).toBe(EXIT_FAILED);
    expect(override.err).toContain(`a reason that names the ${REVIEW_GATE_WORDS}`);
    const named = await cli(p.vote("m1.json", "--without-receipt", `skipping the ${REVIEW_GATE_WORDS} on purpose`, "--yes"), p.keys);
    expect(named.code).toBe(EXIT_OK);
    expect(named.err).toContain("WARNING: the review gate was skipped");
    const judged = await cli(p.judging("m1.json", "--review", p.review), p.keys);
    expect(judged.code).toBe(EXIT_OK);
    const voted = await cli(p.vote("m1.json", "--yes"), p.keys);
    expect([voted.code, voted.err]).toEqual([EXIT_OK, ""]);
  });
});

describe("committee vote when the review gate cannot read the pinned spec", () => {
  const unblocked = (text: string) => text.slice(0, text.indexOf(`\`\`\`${REVIEW_FENCE}`));

  it("refuses an override that does not name the review gate, and a receipt, when the url now serves the spec without its block", async () => {
    const p = await panel();
    const member = p.members[1] as KeyPairSigner;
    const edited = unblocked(await readFile(p.spec, "utf8"));
    h.specPages.set(SPEC_URL, new TextEncoder().encode(edited));
    const why = specDiffers(SPEC_URL, sha(edited));
    const override = await cli(p.vote("m1.json", "--without-receipt", "the member checked it by hand", "--yes"), p.keys);
    expect(override.code).toBe(EXIT_FAILED);
    expect(override.err).toContain(unknownOverrideRefused(why));
    await writeReceipt(HOME, {
      outcome: "pass",
      cluster: await transport.genesisHash(),
      judge: member.address,
      owner: p.w.owner.address,
      nonce: 0n,
      intent: p.intent,
      specSha256: p.statement.specSha256,
      deliveredSha256: p.statement.deliveredSha256,
      announcement: p.made.announcement,
      route: { sandbox: "none", command: "true" },
    });
    const receipted = await cli(p.vote("m1.json", "--yes"), p.keys);
    expect(receipted.code).toBe(EXIT_FAILED);
    expect(receipted.err).toContain(unknownReceiptRefused(why));
    const named = await cli(p.vote("m1.json", "--without-receipt", `skipping the ${REVIEW_GATE_WORDS}: the url was edited`, "--yes"), p.keys);
    expect(named.code).toBe(EXIT_OK);
    expect(named.err).toContain("WARNING: the review gate was not checked: the spec at");
  });

  it("keeps the review gate a local judge run recorded after the url is deleted, and votes on the reviewed receipt", async () => {
    const p = await panel();
    const refused = await cli(p.judging("m1.json"), p.keys);
    expect(refused.code).toBe(EXIT_REFUSED);
    const held = { reviewers: [p.r1.address, p.r2.address], threshold: 2 };
    expect(await reviewRecordOf(HOME, p.statement.cluster, p.intent, p.statement.specSha256)).toEqual({ pins: held });
    h.engineLog = [];
    h.specPages.delete(SPEC_URL);
    const override = await cli(p.vote("m1.json", "--without-receipt", "the member checked it by hand", "--yes"), p.keys);
    expect(override.code).toBe(EXIT_FAILED);
    expect(override.err).toContain(reviewOverrideRefused(held));
    const judged = await cli(p.judging("m1.json", "--review", p.review), p.keys);
    expect(judged.code).toBe(EXIT_OK);
    const voted = await cli(p.vote("m1.json", "--yes"), p.keys);
    expect([voted.code, voted.err]).toEqual([EXIT_OK, ""]);
  });
});

describe("intent-engine review", () => {
  it("previews, signs and co-signs one statement that judge then pays on", async () => {
    const s = await scene();
    const keys = { ...s.keys, "r1.json": s.r1, "r2.json": s.r2 } as unknown as Record<string, KeyPairSigner>;
    const out = join(s.j.dir, "signed.json");
    const base = ["review", "--owner", s.j.w.owner.address, "--nonce", "0", "--artifact", s.j.artifact, "--outcome", "pay", "--reason", REASON, "--out", out];
    const preview = await cli([...base, "--keypair", "r1.json"], keys);
    expect([preview.code, preview.err]).toEqual([EXIT_OK, ""]);
    expect(preview.json()).toMatchObject({ intent: s.j.intent, delivered_sha256: s.j.sha256, spec_sha256: sha(s.text), signed: false, next: REVIEW_NOT_SIGNED });
    const one = await cli([...base, "--keypair", "r1.json", "--yes"], keys);
    expect([one.code, one.err]).toEqual([EXIT_OK, ""]);
    expect(one.json()).toMatchObject({ signed: true, signers: [s.r1.address], statement_sha256: reviewSha256(await statementOf(s)) });
    const two = await cli(["review", "--keypair", "r2.json", "--add", out, "--out", out, "--yes"], keys);
    expect([two.code, two.err]).toEqual([EXIT_OK, ""]);
    expect(two.json()).toMatchObject({ signers: [s.r1.address, s.r2.address] });
    const paid = await cli(judging(s.j, "true", "--review", out, "--yes"), s.keys);
    expect([paid.code, paid.err]).toEqual([EXIT_OK, ""]);
    expect(await cli(["review", "--keypair", "r2.json", "--add", out, "--reason", REASON, "--out", out], keys)).toMatchObject({ code: EXIT_USAGE });
    expect((await cli(["review", "--keypair", "r2.json", "--add", out, "--reason", REASON, "--out", out], keys)).err).toContain(REVIEW_ADD_ALONE);
  });

  it("refuses to co-sign a file whose signatures do not sign its statement", async () => {
    const s = await scene();
    const keys = { "r2.json": s.r2 } as Record<string, KeyPairSigner>;
    const path = await reviewFile(s, [s.r1], { deliveredSha256: sha("other work") });
    const held = parsedReview(await readFile(path, "utf8"), path);
    await writeFile(path, reviewJson({ ...held, deliveredSha256: s.j.sha256 }));
    const refused = await cli(["review", "--keypair", "r2.json", "--add", path, "--out", join(s.j.dir, "out.json"), "--yes"], keys);
    expect(refused.code).toBe(EXIT_FAILED);
    expect(refused.err).toContain("does not sign its statement");
  });
});
