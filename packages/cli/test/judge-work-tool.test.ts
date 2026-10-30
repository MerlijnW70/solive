import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, getBase58Decoder, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, IntentStatus, NATIVE_MINT } from "@intent-engine/core";
import { getIntentDecoder } from "@intent-engine/core/internal";
import { svmTransport } from "@intent-engine/client/svm";
import { tool } from "../src/agent/names.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { servedActions } from "../src/agent/everyday.js";
import { JOB_PROMPTS, MARKET_GUIDE } from "../src/agent/mcp.js";
import { DRAWS_CASES, JUDGED_FAIL, JUDGED_PASS, NO_CASES, walletJudgeWork } from "../src/agent/wallet/judge-work.js";
import { VIPER_ENGINE_COMMIT, VIPER_WASM_SHA256 } from "../src/viper.js";
import { EXIT_OK, main } from "../src/main.js";
import { DOMAIN, h, runtime, world } from "./harness.js";
import { approved } from "./approved.js";

type Json = Record<string, unknown> & { [key: string]: any };

const DEMO = join(fileURLToPath(new URL("../../..", import.meta.url)), "examples", "demo", "fizzbuzz");
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
  let workerWallet: Address;

  beforeEach(async () => {
    await world();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    h.through = svmTransport(h.svm, { genesisHash: getBase58Decoder().decode(DOMAIN) });
    judge = await server("/home/judge");
    judgeWallet = (await ok(judge, "wallet_setup"))["address"] as Address;
    worker = await server("/home/worker");
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
    expect(await ok(worker, "wallet_deliver", { intent, sha256: sha(work), url: WORK_URL, send: true })).toMatchObject({ sent: true });
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
    });
    expect(lamportsOf(judgeWallet)).toBe(before);
    expect(status(intent)).toBe(IntentStatus.Open);
    const attested = await ok(judge, "wallet_attest", await approved(judge, "wallet_attest", { owner: judgeWallet, nonce, delivered_sha256: judged["sha256"] }));
    expect(attested).toMatchObject({ sent: true, pay_to: workerWallet });
    expect(status(intent)).not.toBe(IntentStatus.Open);
  }, 120_000);

  it("fails a wrong solution, names its failed cases in both engines and sends nothing", async () => {
    const { intent } = await delivered(SPEC, WRONG);
    const before = lamportsOf(judgeWallet);
    const judged = await ok(judge, "wallet_judge_work", { intent });
    expect(judged).toMatchObject({ verdict: "fail", sha256: sha(WRONG), sent: false, next: JUDGED_FAIL });
    expect(judged["cases"]["passed"]).toBeLessThan(13);
    expect(judged["host"]["passed"]).toBeLessThan(13);
    expect(judged["cases"]["failures"][0]).toMatchObject({ case: 2, verdict: "wrong", detail: "Buzz" });
    expect(lamportsOf(judgeWallet)).toBe(before);
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
    const texts = [walletJudgeWork.description, JUDGED_PASS, JUDGED_FAIL, NO_CASES, DRAWS_CASES, MARKET_GUIDE, ...JOB_PROMPTS.map((prompt) => prompt.text)];
    for (const text of texts) {
      expect([...text.matchAll(NAMES)].map(([name]) => name).filter((name) => !served.has(name))).toEqual([]);
    }
    for (const text of [MARKET_GUIDE, ...JOB_PROMPTS.filter((prompt) => prompt.name !== "earn").map((prompt) => prompt.text)]) {
      expect(text).toContain(tool("wallet_judge_work"));
      expect(text).not.toContain("judge --sandbox viper");
    }
  });
});
