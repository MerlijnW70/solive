import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, getBase58Decoder, type KeyPairSigner, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, Kind, NATIVE_MINT } from "@intent-engine/core";
import { createClient } from "@intent-engine/client/node";
import { svmTransport } from "@intent-engine/client/svm";
import { tool } from "../src/agent/names.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { FAIL_RECEIPT_KIND, readReceipt } from "../src/judge-receipt.js";
import { CLI_REJECT_NEXT } from "../src/receipt-gate.js";
import { otherWork, unopened } from "../src/reject-check.js";
import { EXIT_FAILED, EXIT_OK, main } from "../src/main.js";
import { announced as announce, griefed, keyed } from "./announce.js";
import { cli, DOMAIN, h, HOME, NOW, runtime, transport, world } from "./harness.js";
import { approved } from "./approved.js";
import { job, type Job, judging } from "./judge-kit.js";

type Json = Record<string, unknown>;

const homes: string[] = [];
const tempDir = (prefix: string): string => {
  const made = mkdtempSync(join(tmpdir(), prefix));
  homes.push(made);
  return made;
};

afterAll(() => {
  for (const path of homes) {
    rmSync(path, { recursive: true, force: true });
  }
});

const svmStates = async (intent: Address) =>
  (await createClient({ url: "devnet", transport: svmTransport(h.svm, { genesisHash: getBase58Decoder().decode(DOMAIN) }) }).announcements(intent)).announcements.map(({ address, state }) => [address, state]);

const states = async (intent: Address) => (await createClient({ url: "http://cluster", transport }).announcements(intent)).announcements.map(({ address, state }) => [address, state]);

describe("intent-engine reject", () => {
  let j: Job;
  const keys = (): Record<string, KeyPairSigner> => ({ "judge.json": j.judge });
  const rejecting = (sha256: string, ...more: string[]) => ["reject", "--keypair", "judge.json", "--owner", j.w.owner.address, "--nonce", "0", "--announcement", j.first.announcement, "--sha256", sha256, ...more];

  beforeEach(async () => {
    j = await job();
  });

  it("rejects with the receipt a failing judge run saved, and with no other", async () => {
    const at = { cluster: await transport.genesisHash(), judge: j.judge.address, intent: j.intent, announcement: j.first.announcement, deliveredSha256: j.sha256 };
    const none = await cli(rejecting(j.sha256), keys());
    expect(none.code).toBe(EXIT_FAILED);
    expect(none.err).toContain(CLI_REJECT_NEXT);
    const failed = await cli(judging(j, "false"), keys());
    expect(failed.code).toBe(EXIT_FAILED);
    expect(await readReceipt(HOME, at, {}, FAIL_RECEIPT_KIND)).toMatchObject({ outcome: "fail", announcement: j.first.announcement });
    const preview = await cli(rejecting(j.sha256), keys());
    expect([preview.code, preview.err]).toEqual([EXIT_OK, ""]);
    expect(preview.json()).toMatchObject({ intent: j.intent, announcement: j.first.announcement, worker: j.worker.address, sent: false });
    const sent = await cli(rejecting(j.sha256, "--yes"), keys());
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
    expect(sent.json()).toMatchObject({ sent: true });
    expect(await states(j.intent)).toContainEqual([j.first.announcement, "rejected"]);
  });

  it("refuses the receipt of a passing run, and work the announcement does not commit to", async () => {
    const passed = await cli(judging(j, "true"), keys());
    expect([passed.code, passed.err]).toEqual([EXIT_OK, ""]);
    const refused = await cli(rejecting(j.sha256), keys());
    expect(refused.code).toBe(EXIT_FAILED);
    expect(refused.err).toContain("failed the work");
    const other = "c4".repeat(32);
    const wrong = await cli(rejecting(other, "--without-receipt", "the check is known to fail"), keys());
    expect(wrong.code).toBe(EXIT_FAILED);
    expect(wrong.err).toContain(otherWork(j.first.announcement, other));
    expect(await states(j.intent)).toContainEqual([j.first.announcement, "announced"]);
  });

  it("refuses an announcement none of the judge's keys opens, even with a reason and --yes, and rejects nothing", async () => {
    const griefer = await keyed();
    const sealed = await griefed(j.intent, griefer, j.judge.address, [griefer.address], j.sha256);
    const refused = await cli(["reject", "--keypair", "judge.json", "--owner", j.w.owner.address, "--nonce", "0", "--announcement", sealed, "--sha256", j.sha256, "--without-receipt", "the check is known to fail", "--yes"], keys());
    expect(refused.code).toBe(EXIT_FAILED);
    expect(refused.err).toContain(unopened(sealed, j.sha256));
    expect(await states(j.intent)).toContainEqual([sealed, "announced"]);
  });
});

describe("intent-engine reject for a committee", () => {
  it("signs member votes, refuses a stranger and a vote for other work, and relays a quorum", async () => {
    const w = await world();
    const members = await Promise.all(["m0.json", "m1.json", "m2.json"].map((path) => keyed(path)));
    const stranger = await keyed("stranger.json");
    const relayer = await keyed("relayer.json");
    const client = createClient({ url: "http://cluster", transport });
    const { committee } = await client.createCommittee({ payer: relayer, members: members.map(({ address }) => address), threshold: 2, feeWallet: relayer.address });
    const specHash = new Uint8Array(createHash("sha256").update("the committee's spec").digest());
    const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: committee, specHash, judgeFee: 0n } as const;
    const { intent } = await client.createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
    const work = "d5".repeat(32);
    const made = await announce(intent, await keyed(), work);
    const dir = tempDir("reject-votes-");
    const keys = Object.fromEntries([...members.map((m, i) => [`m${i}.json`, m] as const), ["stranger.json", stranger], ["relayer.json", relayer]]);
    const base = (path: string) => ["reject", "--keypair", path, "--owner", w.owner.address, "--nonce", "0", "--announcement", made.announcement, "--sha256", work, "--without-receipt", "the members ran the check by hand"];
    const strange = await cli([...base("stranger.json"), "--yes"], keys);
    expect(strange.code).toBe(EXIT_FAILED);
    expect(strange.err).toContain(`${stranger.address} is not the judge of escrow ${intent} nor a member of its committee`);
    const files: string[] = [];
    for (const i of [0, 1]) {
      const out = join(dir, `vote-${i}.json`);
      const voted = await cli([...base(`m${i}.json`), "--out", out, "--yes"], keys);
      expect(voted.code).toBe(EXIT_OK);
      expect(voted.err).toContain("nothing checked that a judge run on this machine failed the work");
      expect(voted.json()).toMatchObject({ sent: false, vote: { kind: "reject-vote", member: members[i]?.address, sha256: work } });
      files.push(out);
    }
    const forged = join(dir, "vote-forged.json");
    const second = JSON.parse(readFileSync(files[1] ?? "", "utf8")) as Json;
    writeFileSync(forged, JSON.stringify({ ...second, sha256: "e6".repeat(32) }));
    const relay = (votes: string[], yes: boolean) =>
      cli(["reject", "--keypair", "relayer.json", "--owner", w.owner.address, "--nonce", "0", "--announcement", made.announcement, "--sha256", work, ...votes.flatMap((file) => ["--vote", file]), ...(yes ? ["--yes"] : [])], keys);
    const mixed = await relay([files[0] ?? "", forged], true);
    expect(mixed.code).toBe(EXIT_FAILED);
    expect(mixed.err).toContain("rejects another escrow, announcement or work than this reject");
    expect(await states(intent)).toEqual([[made.announcement, "announced"]]);
    const relayed = await relay(files, true);
    expect([relayed.code, relayed.err]).toEqual([EXIT_OK, ""]);
    expect(relayed.json()).toMatchObject({ sent: true, voters: expect.arrayContaining([members[0]?.address, members[1]?.address]) });
    expect(await states(intent)).toEqual([[made.announcement, "rejected"]]);
  });
});

const DEMO = join(process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url)), "examples", "demo", "fizzbuzz");
const SPEC = readFileSync(join(DEMO, "SPEC.md"));
const SOLUTION = readFileSync(join(DEMO, "solution.mjs"));
const WRONG = new TextEncoder().encode('export default (n) => (n % 15 === 0 ? "FizzBuzz" : n % 3 === 0 ? "Buzz" : n % 5 === 0 ? "Fizz" : String(n));\n');
const SPEC_URL = "https://" + "spec.example.org/" + "r".repeat(32) + ".md";
const WORK_URL = "https://" + "work.example.org/" + "r".repeat(32) + ".mjs";
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function preset(at: Address): void {
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

async function server(home: string): Promise<Client> {
  h.served.length = 0;
  const err: string[] = [];
  const code = await main(["mcp", "--url", "devnet", "--wallet"], { ...runtime({}), home }, { out: () => undefined, err: (t) => err.push(t) });
  expect([code, err.join("\n")]).toEqual([EXIT_OK, WALLET_NOTICE.join("\n")]);
  const [near, far] = InMemoryTransport.createLinkedPair();
  await h.served[0]?.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return client;
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

describe("wallet_reject behind wallet_judge_work", () => {
  let judge: Client;
  let worker: Client;
  let judgeWallet: Address;

  beforeEach(async () => {
    await world();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    h.through = svmTransport(h.svm, { genesisHash: getBase58Decoder().decode(DOMAIN) });
    judge = await server(tempDir("reject-judge-"));
    judgeWallet = (await ok(judge, "wallet_setup"))["address"] as Address;
    worker = await server(tempDir("reject-worker-"));
    await ok(worker, "wallet_setup");
  });

  async function delivered(work: Uint8Array) {
    h.specPages.set(SPEC_URL, SPEC);
    h.specPages.set(WORK_URL, work);
    const escrow = await ok(judge, "wallet_escrow", await approved(judge, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: judgeWallet, spec_hash: sha(SPEC), spec_url: SPEC_URL }));
    const intent = escrow["intent"] as Address;
    const done = await ok(worker, "wallet_deliver", await approved(worker, "wallet_deliver", { intent, sha256: sha(work), url: WORK_URL }));
    return { intent, nonce: escrow["nonce"], announcement: done["announcement"] as Address };
  }

  it("rejects work wallet_judge_work failed, on the receipt that run saved", async () => {
    const job = await delivered(WRONG);
    const judged = await ok(judge, "wallet_judge_work", { intent: job.intent });
    expect(judged).toMatchObject({ verdict: "fail", fail_receipt: expect.any(String) });
    const target = { owner: judgeWallet, nonce: job.nonce, announcement: job.announcement, delivered_sha256: sha(WRONG) };
    const sent = await ok(judge, "wallet_reject", await approved(judge, "wallet_reject", target));
    expect(sent).toMatchObject({ sent: true });
    expect(sent).not.toHaveProperty("unchecked");
    expect(await svmStates(job.intent)).toEqual([[job.announcement, "rejected"]]);
  });

  it("refuses to reject on the receipt of a pass", async () => {
    const job = await delivered(SOLUTION);
    expect(await ok(judge, "wallet_judge_work", { intent: job.intent })).toMatchObject({ verdict: "pass" });
    const refused = await call(judge, "wallet_reject", { owner: judgeWallet, nonce: job.nonce, announcement: job.announcement, delivered_sha256: sha(SOLUTION) });
    expect(refused).toMatchObject({ error: true, value: { code: "NoJudgeReceipt", hint: expect.stringContaining("failed the work") } });
  });

  it("refuses an announcement the judge's keys cannot open, with a reason, and signs and sends nothing", async () => {
    const job = await delivered(WRONG);
    const griefer = await keyed();
    const sealed = await griefed(job.intent, griefer, judgeWallet, [griefer.address], sha(WRONG));
    const target = { owner: judgeWallet, nonce: job.nonce, announcement: sealed, delivered_sha256: sha(WRONG), without_receipt: "the check is known to fail" };
    for (const send of [false, true]) {
      const refused = await call(judge, "wallet_reject", { ...target, send });
      expect(refused).toMatchObject({ error: true, value: { code: "NotRejectable" } });
      expect(JSON.stringify(refused.value)).toContain(unopened(sealed, sha(WRONG)));
    }
    expect(await svmStates(job.intent)).toContainEqual([sealed, "announced"]);
  });

  it("refuses a send whose reason or approval differs from its preview", async () => {
    const job = await delivered(WRONG);
    const target = { owner: judgeWallet, nonce: job.nonce, announcement: job.announcement, delivered_sha256: sha(WRONG) };
    const preview = await ok(judge, "wallet_reject", { ...target, without_receipt: "the first reason" });
    const changed = await call(judge, "wallet_reject", { ...target, without_receipt: "another reason", approval: preview["approval"], send: true });
    expect(changed).toMatchObject({ error: true, value: { code: "ReleaseChanged" } });
    const forged = await call(judge, "wallet_reject", { ...target, without_receipt: "the first reason", approval: "0".repeat(16), send: true });
    expect(forged).toMatchObject({ error: true, value: { code: "ReleaseChanged" } });
    expect(await svmStates(job.intent)).toEqual([[job.announcement, "announced"]]);
    const sent = await ok(judge, "wallet_reject", { ...target, without_receipt: "the first reason", approval: preview["approval"], send: true });
    expect(sent).toMatchObject({ sent: true, unchecked: { reason: "the first reason" } });
  });

});
