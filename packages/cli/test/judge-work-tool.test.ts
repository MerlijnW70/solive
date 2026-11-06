import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, getBase58Decoder, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEVNET_TEST_MINT, IntentStatus, NATIVE_MINT } from "@intent-engine/core";
import { getIntentDecoder } from "@intent-engine/core/internal";
import { svmTransport } from "@intent-engine/client/svm";
import { tool } from "../src/agent/names.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { servedActions } from "../src/agent/everyday.js";
import { JOB_PROMPTS } from "../src/agent/mcp.js";
import { DRAWS_CASES, JUDGED_FAIL, JUDGED_INFRA, JUDGED_PASS, NO_CASES, walletJudgeWork } from "../src/agent/wallet/judge-work.js";
import { HOST_RUNNER } from "../src/host-judge.js";
import { RUNNER, VIPER_ENGINE_COMMIT, VIPER_WASM_SHA256 } from "../src/viper.js";
import { EXIT_OK, main } from "../src/main.js";
import { DOMAIN, h, runtime, world } from "./harness.js";
import { approved } from "./approved.js";
import { guideOf } from "./served-texts.js";
import { receiptsDir } from "../src/judge-receipt.js";

type Json = Record<string, unknown> & { [key: string]: any };

const faults = vi.hoisted(() => ({ marks: [] as string[] }));

vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof import("node:child_process")>();
  const spawn = (...all: Parameters<typeof actual.spawn>) => {
    const [, args, options] = all as unknown as [string, unknown, object | undefined];
    const broken = Array.isArray(args) && faults.marks.some((mark) => args.includes(mark));
    return broken ? actual.spawn(process.execPath, ["-e", "process.exit(9)"], options ?? {}) : actual.spawn(...all);
  };
  return { ...actual, spawn: vi.fn(spawn) };
});

afterEach(() => {
  faults.marks.length = 0;
});

const DEMO = join(process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url)), "examples", "demo", "fizzbuzz");
const SPEC = readFileSync(join(DEMO, "SPEC.md"));
const SOLUTION = readFileSync(join(DEMO, "solution.mjs"));
const WRONG = new TextEncoder().encode('export default (n) => (n % 15 === 0 ? "FizzBuzz" : n % 3 === 0 ? "Buzz" : n % 5 === 0 ? "Fizz" : String(n));\n');
const NO_CASES_SPEC = new TextEncoder().encode("# Job\n\nDeliver a module that prints hello. The judge runs it in a container.\n");
const DRAW_SPEC = new TextEncoder().encode(
  '# Job\n\n```judge-cases\n{"cases": [{"args": [1], "expected": "1"}], "draw": {"count": 1, "generator": "export default () => [[1]];", "checker": "export default () => true;", "k": 1}}\n```\n',
);
const SPEC_URL = "https://" + "spec.example.org/" + "s".repeat(32) + ".md";
const WORK_URL = "https://" + "work.example.org/" + "w".repeat(32) + ".mjs";

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

async function ok(client: Client, name: string, args: object = {}): Promise<Json> {
  const result = await client.callTool({ name: tool(name), arguments: args as Record<string, unknown> });
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
  return result.structuredContent as Json;
}

const status = (intent: Address) => {
  const account = h.svm.getAccount(intent);
  return account.exists ? getIntentDecoder().decode(account.data).status : undefined;
};

const lamportsOf = (wallet: Address) => {
  const account = h.svm.getAccount(wallet);
  return account.exists ? account.lamports : 0n;
};

const NAMES = /\bsolive_\w+/g;

describe("wallet_judge_work", () => {
  let judge: Client;
  let worker: Client;
  let judgeWallet: Address;
  let judgeHome: string;
  const receipts = () => (existsSync(receiptsDir(judgeHome)) ? readdirSync(receiptsDir(judgeHome)).filter((name) => name.endsWith(".json")) : []);
  let workerWallet: Address;

  beforeEach(async () => {
    await world();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    h.through = svmTransport(h.svm, { genesisHash: getBase58Decoder().decode(DOMAIN) });
    judgeHome = mkdtempSync(join(tmpdir(), "judge-home-"));
    judge = await server(judgeHome);
    judgeWallet = (await ok(judge, "wallet_setup"))["address"] as Address;
    worker = await server(mkdtempSync(join(tmpdir(), "worker-home-")));
    workerWallet = (await ok(worker, "wallet_setup"))["address"] as Address;
    h.watched.push(judgeWallet);
  });

  async function delivered(spec: Uint8Array, work: Uint8Array): Promise<{ intent: Address; nonce: string }> {
    h.specPages.set(SPEC_URL, spec);
    h.specPages.set(WORK_URL, work);
    const escrow = await ok(judge, "wallet_escrow", await approved(judge, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: judgeWallet, spec_hash: sha(spec), spec_url: SPEC_URL }));
    const intent = escrow["intent"] as Address;
    const preview = await ok(worker, "wallet_deliver", { intent, sha256: sha(work), url: WORK_URL });
    expect(preview["sent"]).toBe(false);
    expect(await ok(worker, "wallet_deliver", await approved(worker, "wallet_deliver", { intent, sha256: sha(work), url: WORK_URL, send: true }))).toMatchObject({ sent: true });
    return { intent, nonce: escrow["nonce"] as string };
  }

  it("passes the demo's own solution in both engines, returns the work's sha256, sends nothing, and wallet_attest then pays", async () => {
    const { intent, nonce } = await delivered(SPEC, SOLUTION);
    const before = lamportsOf(judgeWallet);
    const judged = await ok(judge, "wallet_judge_work", { intent });
    expect(judged).toMatchObject({
      intent,
      worker: workerWallet,
      sha256: sha(SOLUTION),
      opens_commitment: true,
      verdict: "pass",
      engine: { wasm_sha256: VIPER_WASM_SHA256, commit: VIPER_ENGINE_COMMIT },
      cases: { total: 13, passed: 13, failures: [] },
      host: { total: 13, passed: 13, failures: [] },
      sent: false,
      next: JUDGED_PASS,
      receipt: expect.stringContaining(receiptsDir(judgeHome)),
    });
    expect(receipts()).toHaveLength(1);
    expect(lamportsOf(judgeWallet)).toBe(before);
    expect(status(intent)).toBe(IntentStatus.Open);
    const attested = await ok(judge, "wallet_attest", await approved(judge, "wallet_attest", { owner: judgeWallet, nonce, delivered_sha256: judged["sha256"] }));
    expect(attested).toMatchObject({ sent: true, pay_to: workerWallet });
    expect(status(intent)).not.toBe(IntentStatus.Open);
  }, 120_000);

  it("fails a wrong solution, names its failed cases in both engines and sends nothing", async () => {
    const { intent, nonce } = await delivered(SPEC, WRONG);
    const before = lamportsOf(judgeWallet);
    const judged = await ok(judge, "wallet_judge_work", { intent });
    expect(judged).toMatchObject({ verdict: "fail", sha256: sha(WRONG), sent: false, next: JUDGED_FAIL });
    expect(judged["cases"]["passed"]).toBeLessThan(13);
    expect(judged["host"]["passed"]).toBeLessThan(13);
    expect(judged["cases"]["failures"][0]).toMatchObject({ case: 2, verdict: "wrong", detail: "Buzz" });
    expect(judged).not.toHaveProperty("receipt");
    expect(receipts()).toEqual([]);
    const attest = await judge.callTool({ name: tool("wallet_attest"), arguments: { owner: judgeWallet, nonce, delivered_sha256: sha(WRONG) } });
    expect([attest.isError, (attest.structuredContent as Json)["code"]]).toEqual([true, "NoJudgeReceipt"]);
    expect(lamportsOf(judgeWallet)).toBe(before);
    expect(status(intent)).toBe(IntentStatus.Open);
  }, 120_000);

  it("returns infra, never pass or fail, when an engine crashes, never tells the caller to attest, and sends nothing", async () => {
    const { intent } = await delivered(SPEC, SOLUTION);
    for (const mark of [RUNNER, HOST_RUNNER]) {
      faults.marks.splice(0, faults.marks.length, mark);
      const judged = await ok(judge, "wallet_judge_work", { intent });
      expect(judged, mark.slice(0, 40)).toMatchObject({ verdict: "infra", sent: false, next: JUDGED_INFRA });
      expect(String(judged["reason"])).toContain("ended with exit code 9");
      expect(judged["next"]).not.toContain(tool("wallet_attest"));
      expect(judged).not.toHaveProperty("receipt");
    }
    expect(receipts()).toEqual([]);
    faults.marks.length = 0;
    const pending = new TextEncoder().encode(`if (typeof Intl !== "undefined") await new Promise(() => {});\n${new TextDecoder().decode(SOLUTION)}`);
    const { intent: unsettled } = await delivered(SPEC, pending);
    const loaded = await ok(judge, "wallet_judge_work", { intent: unsettled });
    expect(loaded).toMatchObject({ verdict: "fail", next: JUDGED_FAIL, host: { passed: 0 } });
    expect(loaded["host"]["failures"][0]).toMatchObject({ case: 0, verdict: "no-module" });
    const { intent: wrong } = await delivered(SPEC, WRONG);
    faults.marks.push(HOST_RUNNER);
    expect(await ok(judge, "wallet_judge_work", { intent: wrong })).toMatchObject({ verdict: "fail", next: JUDGED_FAIL });
    expect(status(intent)).toBe(IntentStatus.Open);
  }, 120_000);

  it("refuses a spec without judge cases and says to use judge --sandbox docker, running and sending nothing", async () => {
    const { intent } = await delivered(NO_CASES_SPEC, SOLUTION);
    const result = await judge.callTool({ name: tool("wallet_judge_work"), arguments: { intent } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ code: "NoJudgeCases", retryable: false, hint: NO_CASES });
    expect(NO_CASES).toContain("judge --sandbox docker");
    expect(status(intent)).toBe(IntentStatus.Open);
  });

  it("refuses a spec that draws its cases, and a spec that does not match the escrow", async () => {
    const drawn = await delivered(DRAW_SPEC, SOLUTION);
    const refused = await judge.callTool({ name: tool("wallet_judge_work"), arguments: { intent: drawn.intent } });
    expect(refused.structuredContent).toMatchObject({ code: "NotJudged", hint: DRAWS_CASES });
    const { intent } = await delivered(SPEC, SOLUTION);
    h.specPages.set(SPEC_URL, NO_CASES_SPEC);
    const differs = await judge.callTool({ name: tool("wallet_judge_work"), arguments: { intent } });
    expect(differs.structuredContent).toMatchObject({ code: "NotJudged" });
    expect((differs.structuredContent as Json)["hint"]).toContain(sha(NO_CASES_SPEC));
  });

  it("is served with --wallet, and it, the guide and the judge and hire prompts name only served tools", async () => {
    const listed = (await judge.listTools()).tools.map((one) => one.name);
    expect(listed).toContain(tool("wallet_judge_work"));
    const served = new Set(servedActions({ wallet: true, allTools: false, relay: false, agent: false }).map((action) => action.name));
    const texts = [walletJudgeWork.description, JUDGED_PASS, JUDGED_FAIL, JUDGED_INFRA, NO_CASES, DRAWS_CASES, guideOf(), ...JOB_PROMPTS.map((prompt) => prompt.text)];
    for (const text of texts) {
      expect([...text.matchAll(NAMES)].map(([name]) => name).filter((name) => !served.has(name))).toEqual([]);
    }
    for (const text of [guideOf(), ...JOB_PROMPTS.filter((prompt) => prompt.name !== "earn").map((prompt) => prompt.text)]) {
      expect(text).toContain(tool("wallet_judge_work"));
      expect(text).not.toContain("judge --sandbox viper");
    }
  });
});
