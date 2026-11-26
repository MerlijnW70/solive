import { createHash, generateKeyPairSync } from "node:crypto";
import { type Address, generateKeyPairSigner, getAddressDecoder, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, IntentStatus, Kind, NATIVE_MINT } from "@intent-engine/core";
import { getIntentDecoder, sortMembers, specMemo } from "@intent-engine/core/internal";
import { createClient } from "@intent-engine/client/node";
import { tool } from "../src/agent/names.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { REVIEW_GATED } from "../src/agent/wallet/judge-work.js";
import { REVIEW_CHANGED, REVIEW_OTHER } from "../src/agent/wallet/review.js";
import { writeReceipt, type Route } from "../src/judge-receipt.js";
import { REVIEW_FENCE } from "../src/review-block.js";
import { parsedReview, reviewedBy } from "../src/review.js";
import { CURRENT_PINS, reviewOverrideRefused, REVIEW_GATE_WORDS, unknownOverrideRefused, unknownReceiptRefused } from "../src/receipt-gate.js";
import { gateUnread, NO_SPEC_READ, specDiffers } from "../src/review-gate.js";
import { keepReviewRecord } from "../src/review-record.js";
import { EXIT_OK } from "../src/main.js";
import { announced as made, keyed } from "./announce.js";
import { cli, creation, funded, h, HOME, NOW, ownerSigned, transport, world } from "./harness.js";
import { approved } from "./approved.js";

type Json = Record<string, unknown> & { [key: string]: any };

const CASES = '{"cases": [{"args": [""], "expected": 0}, {"args": ["one"], "expected": 1}]}';
const SPEC_URL = "https://" + "example.org/jobs/reviewed.md";
const WORK = "7c".repeat(32);
const WORK_URL = "https://" + "example.org/work/0123456789abcdef0123456789abcdef";
const REASON = "the reviewer read the code";
const sha = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
const encoded = (text: string) => new TextEncoder().encode(text);

function address(): Address {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  return getAddressDecoder().decode(Uint8Array.from(Buffer.from(jwk.x ?? "", "base64url")));
}

function preset(at: Address): void {
  if (h.svm.getAccount(at).exists) {
    return;
  }
  const space = BigInt(getMintSize());
  h.svm.setAccount({
    address: at,
    data: Uint8Array.from(getMintEncoder().encode({ mintAuthority: none(), supply: 0n, decimals: 9, isInitialized: true, freezeAuthority: none() })),
    executable: false,
    lamports: lamports(h.svm.minimumBalanceForRentExemption(space)),
    programAddress: TOKEN_PROGRAM_ADDRESS,
    space,
  });
}

async function call(client: Client, name: string, args: object = {}) {
  const result = await client.callTool({ name: tool(name), arguments: args as Record<string, unknown> });
  return { error: result.isError === true, value: result.structuredContent as Json };
}

async function ok(client: Client, name: string, args: object = {}): Promise<Json> {
  const { error, value } = await call(client, name, args);
  expect(error, JSON.stringify(value)).toBe(false);
  return value;
}

async function setup() {
  const w = await world();
  h.files.clear();
  preset(NATIVE_MINT);
  preset(DEVNET_TEST_MINT);
  h.served.length = 0;
  const started = await cli(["mcp", "--url", "devnet", "--wallet", "--all-tools"], {});
  expect([started.code, started.err]).toEqual([EXIT_OK, WALLET_NOTICE.join("\n")]);
  const [near, far] = InMemoryTransport.createLinkedPair();
  await h.served[0]?.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
  const [r1, r2] = [await generateKeyPairSigner(), await generateKeyPairSigner()];
  const text = `# Count words\n\n\`\`\`judge-cases\n${CASES}\n\`\`\`\n\n\`\`\`${REVIEW_FENCE}\n${JSON.stringify({ reviewers: [r1.address, r2.address] })}\n\`\`\`\n`;
  return { w, client, wallet, r1, r2, text };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function post(s: Setup, attestor: Address, served = true): Promise<Address> {
  h.specPages.set(SPEC_URL, encoded(s.text));
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor, specHash: Uint8Array.from(Buffer.from(sha(s.text), "hex")), judgeFee: 0n } as const;
  const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: s.w.owner, params, inputMint: s.w.inputMint, outputMint: s.w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  h.engineLog = served ? [{ ...creation(intent), ...ownerSigned(intent, [specMemo(SPEC_URL)]) }] : [];
  return intent;
}

const routeOf = (review?: { signers: Address[] }): Route => ({ sandbox: "viper", command: "viper", engine: CURRENT_PINS, ...(review === undefined ? {} : { review: { sha256: "e5".repeat(32), signers: review.signers } }) });

async function receipt(s: Setup, intent: Address, judge: Address, announcement: Address, route: Route): Promise<void> {
  await writeReceipt(HOME, {
    outcome: "pass",
    cluster: await transport.genesisHash(),
    judge,
    owner: s.w.owner.address,
    nonce: 0n,
    intent,
    specSha256: sha(s.text),
    deliveredSha256: WORK,
    announcement,
    route,
  });
}

const statusOf = (intent: Address) => {
  const view = h.svm.getAccount(intent);
  return view.exists ? getIntentDecoder().decode(view.data).status : undefined;
};

describe("the review gate on the wallet server's release paths", () => {
  it("wallet_attest refuses a receipt with no review and an override that does not name the review gate, and pays on a reviewed receipt", async () => {
    const s = await setup();
    const worker = await keyed();
    const intent = await post(s, s.wallet);
    const first = await made(intent, worker, WORK, WORK_URL);
    const release = { owner: s.w.owner.address, nonce: "0", delivered_sha256: WORK };
    await receipt(s, intent, s.wallet, first.announcement, routeOf());
    const reused = await call(s.client, "wallet_attest", release);
    expect(reused).toMatchObject({ error: true, value: { code: "NoJudgeReceipt" } });
    expect(String(reused.value["hint"])).toContain("records no signed review");
    const plain = await call(s.client, "wallet_attest", { ...release, without_receipt: "the hirer checked this by hand" });
    expect(plain).toMatchObject({ error: true, value: { code: "NoJudgeReceipt" } });
    expect(String(plain.value["hint"])).toContain(reviewOverrideRefused({ reviewers: [s.r1.address, s.r2.address], threshold: 2 }));
    const named = await ok(s.client, "wallet_attest", { ...release, without_receipt: `the ${REVIEW_GATE_WORDS} is skipped on purpose` });
    expect(named["unchecked"]["warning"]).toMatch(/^the review gate was skipped/);
    await receipt(s, intent, s.wallet, first.announcement, routeOf({ signers: [s.r1.address, s.r2.address] }));
    const shown = await ok(s.client, "wallet_attest", release);
    expect(shown).not.toHaveProperty("unchecked");
    expect(await ok(s.client, "wallet_attest", { ...release, approval: shown["approval"], send: true })).toMatchObject({ sent: true, pay_to: worker.address });
    expect(statusOf(intent)).toBe(IntentStatus.Filled);
  });

  it("wallet_attest_split refuses a receipt with no review", async () => {
    const s = await setup();
    const worker = await keyed();
    const intent = await post(s, s.wallet);
    const first = await made(intent, worker, WORK, WORK_URL);
    await receipt(s, intent, s.wallet, first.announcement, routeOf({ signers: [s.r1.address] }));
    const split = { owner: s.w.owner.address, nonce: "0", recipients: [{ wallet: worker.address, weight: 10_000 }], delivered_sha256: WORK };
    const refused = await call(s.client, "wallet_attest_split", split);
    expect(refused).toMatchObject({ error: true, value: { code: "NoJudgeReceipt" } });
    expect(String(refused.value["hint"])).toContain("records no signed review");
  });

  it("wallet_committee_vote refuses a receipt with no review and an override that does not name the review gate", async () => {
    const s = await setup();
    const members = sortMembers([s.wallet, address()]);
    const payer = await funded();
    const created = await cli(["committee", "create", "--url", "devnet", "--keypair", "payer.json", "--members", members.join(","), "--threshold", "2", "--fee-wallet", payer.address, "--yes"], { "payer.json": payer });
    const committee = created.json()["committee"] as Address;
    const worker = await keyed();
    const intent = await post(s, committee);
    const first = await made(intent, worker, WORK, WORK_URL);
    await receipt(s, intent, s.wallet, first.announcement, routeOf());
    const ballot = { owner: s.w.owner.address, nonce: "0", result: "1", delivered_sha256: WORK };
    const reused = await call(s.client, "wallet_committee_vote", ballot);
    expect(reused).toMatchObject({ error: true, value: { code: "NoJudgeReceipt" } });
    expect(String(reused.value["hint"])).toContain("records no signed review");
    const plain = await call(s.client, "wallet_committee_vote", { ...ballot, without_receipt: "checked by hand" });
    expect(String(plain.value["hint"])).toContain(`names the ${REVIEW_GATE_WORDS}`);
    await receipt(s, intent, s.wallet, first.announcement, routeOf({ signers: [s.r1.address, s.r2.address] }));
    expect(await ok(s.client, "wallet_committee_vote", ballot)).toMatchObject({ intent, committee, signed: false });
  });

  it("wallet_judge_work judges nothing for a spec with a judge-review block", async () => {
    const s = await setup();
    const worker = await keyed();
    const intent = await post(s, s.wallet);
    await made(intent, worker, WORK, WORK_URL);
    expect(await call(s.client, "wallet_judge_work", { intent })).toMatchObject({ error: true, value: { code: "ReviewRequired", hint: REVIEW_GATED } });
  });

  it("get_spec shows the reviewers and the threshold of the judge-review block", async () => {
    const s = await setup();
    const intent = await post(s, s.wallet);
    expect(await ok(s.client, "get_spec", { intent })).toMatchObject({ matches: true, judge_review: { reviewers: [s.r1.address, s.r2.address], threshold: 2 } });
  });
});

describe("an unknown review gate on the wallet server's release paths", () => {
  const unblocked = (text: string) => text.slice(0, text.indexOf(`\`\`\`${REVIEW_FENCE}`));

  it("wallet_attest refuses a receipt and an override that does not name the review gate when the url now serves the spec without its block", async () => {
    const s = await setup();
    const worker = await keyed();
    const intent = await post(s, s.wallet);
    const edited = unblocked(s.text);
    h.specPages.set(SPEC_URL, encoded(edited));
    const first = await made(intent, worker, WORK, WORK_URL);
    const release = { owner: s.w.owner.address, nonce: "0", delivered_sha256: WORK };
    const why = specDiffers(SPEC_URL, sha(edited));
    const plain = await call(s.client, "wallet_attest", { ...release, without_receipt: "the hirer checked this by hand" });
    expect(plain).toMatchObject({ error: true, value: { code: "NoJudgeReceipt" } });
    expect(String(plain.value["hint"])).toContain(unknownOverrideRefused(why));
    await receipt(s, intent, s.wallet, first.announcement, routeOf());
    const receipted = await call(s.client, "wallet_attest", release);
    expect(receipted).toMatchObject({ error: true, value: { code: "NoJudgeReceipt" } });
    expect(String(receipted.value["hint"])).toContain(unknownReceiptRefused(why));
    const named = await ok(s.client, "wallet_attest", { ...release, without_receipt: `the ${REVIEW_GATE_WORDS} is skipped on purpose` });
    expect(named["unchecked"]["warning"]).toMatch(/^the review gate was not checked: the spec at https:\/\/example\.org\/jobs\/reviewed\.md now has sha256 /);
    expect(statusOf(intent)).toBe(IntentStatus.Open);
  });

  it("wallet_attest, wallet_attest_split and wallet_committee_vote treat an escrow without a spec url as unknown, not ungated", async () => {
    const s = await setup();
    const worker = await keyed();
    const intent = await post(s, s.wallet, false);
    const first = await made(intent, worker, WORK, WORK_URL);
    await receipt(s, intent, s.wallet, first.announcement, routeOf());
    const release = { owner: s.w.owner.address, nonce: "0", delivered_sha256: WORK };
    for (const [name, args] of [
      ["wallet_attest", release],
      ["wallet_attest", { ...release, without_receipt: "the hirer checked this by hand" }],
      ["wallet_attest_split", { ...release, recipients: [{ wallet: worker.address, weight: 10_000 }], without_receipt: "the hirer checked this by hand" }],
    ] as const) {
      const refused = await call(s.client, name, args);
      expect(refused, name).toMatchObject({ error: true, value: { code: "NoJudgeReceipt" } });
      expect(String(refused.value["hint"])).toContain(`the review gate is unknown because ${NO_SPEC_READ}`);
    }
    expect(await ok(s.client, "wallet_attest", { ...release, without_receipt: `no ${REVIEW_GATE_WORDS}: the hirer read the spec by hand` })).toMatchObject({ sent: false, unchecked: { warning: expect.stringMatching(/^the review gate was not checked: this escrow publishes no spec url/) } });
  });

  it("wallet_committee_vote refuses an unnamed override on an escrow without a spec url", async () => {
    const s = await setup();
    const members = sortMembers([s.wallet, address()]);
    const payer = await funded();
    const created = await cli(["committee", "create", "--url", "devnet", "--keypair", "payer.json", "--members", members.join(","), "--threshold", "2", "--fee-wallet", payer.address, "--yes"], { "payer.json": payer });
    const committee = created.json()["committee"] as Address;
    const worker = await keyed();
    const intent = await post(s, committee, false);
    await made(intent, worker, WORK, WORK_URL);
    const ballot = { owner: s.w.owner.address, nonce: "0", result: "1", delivered_sha256: WORK };
    const plain = await call(s.client, "wallet_committee_vote", { ...ballot, without_receipt: "checked by hand" });
    expect(plain).toMatchObject({ error: true, value: { code: "NoJudgeReceipt" } });
    expect(String(plain.value["hint"])).toContain(unknownOverrideRefused(NO_SPEC_READ));
  });

  it("wallet_attest answers a transient spec fetch failure as retryable SpecUnreadable and signs nothing, and a lasting one as NoJudgeReceipt", async () => {
    const s = await setup();
    const worker = await keyed();
    const intent = await post(s, s.wallet);
    const first = await made(intent, worker, WORK, WORK_URL);
    await receipt(s, intent, s.wallet, first.announcement, routeOf({ signers: [s.r1.address, s.r2.address] }));
    const release = { owner: s.w.owner.address, nonce: "0", delivered_sha256: WORK };
    h.specPages.delete(SPEC_URL);
    for (const args of [release, { ...release, without_receipt: `the ${REVIEW_GATE_WORDS} is skipped on purpose` }]) {
      const down = await s.client.callTool({ name: tool("wallet_attest"), arguments: args as Record<string, unknown> });
      expect(down.isError).toBe(true);
      expect(down.structuredContent).toMatchObject({ code: "SpecUnreadable", retryable: true, hint: gateUnread(intent) });
    }
    h.specReplies.set(SPEC_URL, async () => new Response("gone", { status: 404 }));
    const lasting = await call(s.client, "wallet_attest", release);
    expect(lasting).toMatchObject({ error: true, value: { code: "NoJudgeReceipt", retryable: false } });
    expect(String(lasting.value["hint"])).toContain("the review gate is unknown because the spec at");
    h.specReplies.delete(SPEC_URL);
    expect(statusOf(intent)).toBe(IntentStatus.Open);
  });

  it("wallet_attest keeps the review gate of a local record after the url is gone, and pays on a reviewed receipt", async () => {
    const s = await setup();
    const worker = await keyed();
    const intent = await post(s, s.wallet, false);
    const pins = { reviewers: [s.r1.address, s.r2.address], threshold: 2 };
    expect(await keepReviewRecord(HOME, { cluster: await transport.genesisHash(), intent, specSha256: sha(s.text), review: pins })).toBeUndefined();
    const first = await made(intent, worker, WORK, WORK_URL);
    const release = { owner: s.w.owner.address, nonce: "0", delivered_sha256: WORK };
    const plain = await call(s.client, "wallet_attest", { ...release, without_receipt: "the hirer checked this by hand" });
    expect(String(plain.value["hint"])).toContain(reviewOverrideRefused(pins));
    await receipt(s, intent, s.wallet, first.announcement, routeOf({ signers: [s.r1.address, s.r2.address] }));
    const shown = await ok(s.client, "wallet_attest", release);
    expect(shown).not.toHaveProperty("unchecked");
    expect(await ok(s.client, "wallet_attest", { ...release, approval: shown["approval"], send: true })).toMatchObject({ sent: true, pay_to: worker.address });
  });
});

describe("wallet_review", () => {
  it("previews, signs and co-signs a review that the judge's check accepts", async () => {
    const s = await setup();
    const intent = await post(s, s.wallet);
    const input = { owner: s.w.owner.address, nonce: "0", delivered_sha256: WORK, outcome: "pay", reason: REASON };
    const preview = await ok(s.client, "wallet_review", input);
    expect(preview).toMatchObject({ intent, spec_sha256: sha(s.text), delivered_sha256: WORK, signed: false, signers: [] });
    expect(await call(s.client, "wallet_review", { ...input, approval: "0".repeat(16), send: true })).toMatchObject({ error: true, value: { code: "ReviewRefused", hint: REVIEW_CHANGED } });
    const signed = await ok(s.client, "wallet_review", await approved(s.client, "wallet_review", input));
    expect(signed).toMatchObject({ signed: true, signers: [s.wallet] });
    const review = parsedReview(signed["review"] as string, "review");
    const cluster = await transport.genesisHash();
    const at = { cluster, intent, nonce: 0n, specSha256: sha(s.text), deliveredSha256: WORK };
    expect(await reviewedBy([{ path: "review", review }], at, { reviewers: [s.wallet], threshold: 1 })).toMatchObject({ verdict: "pay", signers: [s.wallet] });
    const other = await call(s.client, "wallet_review", { ...input, reason: "another reason", review: signed["review"] });
    expect(other).toMatchObject({ error: true, value: { code: "ReviewRefused", hint: REVIEW_OTHER } });
    const again = await ok(s.client, "wallet_review", await approved(s.client, "wallet_review", { ...input, review: signed["review"] }));
    expect(again["signers"]).toEqual([s.wallet]);
    expect(statusOf(intent)).toBe(IntentStatus.Open);
  });

  it("refuses a reason with a hidden character and an intent that is not a proof escrow", async () => {
    const s = await setup();
    await post(s, s.wallet);
    const input = { owner: s.w.owner.address, nonce: "0", delivered_sha256: WORK, outcome: "pay" };
    expect(await call(s.client, "wallet_review", { ...input, reason: "fine‮" })).toMatchObject({ error: true, value: { code: "ReviewRefused" } });
    expect(await call(s.client, "wallet_review", { ...input, nonce: "9", reason: REASON })).toMatchObject({ error: true, value: { code: "ReviewRefused" } });
  });
});
