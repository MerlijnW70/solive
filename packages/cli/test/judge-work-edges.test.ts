import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, generateKeyPairSigner, getBase58Decoder, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, NATIVE_MINT } from "@intent-engine/core";
import { svmTransport } from "@intent-engine/client/svm";
import { tool } from "../src/agent/names.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { artifactDiffers, JUDGED_FAIL, JUDGED_PASS, NOT_TEXT_WORK } from "../src/agent/wallet/judge-work.js";
import { WORK_DIFFERS } from "../src/agent/wallet/work.js";
import { EXIT_OK, main } from "../src/main.js";
import { DOMAIN, h, runtime, world } from "./harness.js";
import { approved } from "./approved.js";

type Json = Record<string, unknown> & { [key: string]: any };

const DEMO = join(process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url)), "examples", "demo", "fizzbuzz");
const SPEC = readFileSync(join(DEMO, "SPEC.md"));
const SOLUTION = readFileSync(join(DEMO, "solution.mjs"));
const SOLVED = new TextDecoder().decode(SOLUTION).replace("export default", "const solved =");
const ONLY_ON_V8 = new TextEncoder().encode(`${SOLVED}\nexport default (n) => (typeof Error.captureStackTrace === "function" ? solved(n) : "");\n`);
const NOT_UTF8 = Uint8Array.from([0x65, 0x78, 0x70, 0xc3, 0x28, 0xff, 0x0a]);
const OTHER = new TextEncoder().encode("export default () => 1;\n");
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

async function call(client: Client, name: string, args: object = {}): Promise<{ error: boolean; value: Json }> {
  const result = await client.callTool({ name: tool(name), arguments: args as Record<string, unknown> });
  return { error: result.isError === true, value: result.structuredContent as Json };
}

async function ok(client: Client, name: string, args: object = {}): Promise<Json> {
  const { error, value } = await call(client, name, args);
  expect(error, JSON.stringify(value)).toBe(false);
  return value;
}

describe("wallet_judge_work at its edges", () => {
  let judge: Client;
  let worker: Client;
  let judgeWallet: Address;
  let workerWallet: Address;
  const roots: string[] = [];

  const saved = (bytes: Uint8Array) => {
    const dir = mkdtempSync(join(tmpdir(), "judge-edges-"));
    roots.push(dir);
    const path = join(dir, "work.mjs");
    writeFileSync(path, bytes);
    return path;
  };

  const escrow = async () => {
    h.specPages.set(SPEC_URL, SPEC);
    const made = await ok(judge, "wallet_escrow", await approved(judge, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: judgeWallet, spec_hash: sha(SPEC), spec_url: SPEC_URL }));
    return made["intent"] as Address;
  };

  const announce = async (by: Client, intent: Address, sha256: string, url: string) => {
    expect(await ok(by, "wallet_deliver", await approved(by, "wallet_deliver", { intent, sha256, url, send: true }))).toMatchObject({ sent: true });
  };

  const delivered = async (work: Uint8Array) => {
    const intent = await escrow();
    h.specPages.set(WORK_URL, work);
    await announce(worker, intent, sha(work), WORK_URL);
    return intent;
  };

  beforeEach(async () => {
    await world();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    h.through = svmTransport(h.svm, { genesisHash: getBase58Decoder().decode(DOMAIN) });
    judge = await server(mkdtempSync(join(tmpdir(), "judge-home-")));
    judgeWallet = (await ok(judge, "wallet_setup"))["address"] as Address;
    worker = await server(mkdtempSync(join(tmpdir(), "worker-home-")));
    workerWallet = (await ok(worker, "wallet_setup"))["address"] as Address;
    h.watched.push(judgeWallet);
  });

  afterEach(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("judges a local file against the announcement it opens, by default and when named, and refuses one named announcement it does not open", async () => {
    const intent = await delivered(SOLUTION);
    const artifact = saved(SOLUTION);
    const judged = await ok(judge, "wallet_judge_work", { intent, artifact });
    expect(judged).toMatchObject({ intent, worker: workerWallet, sha256: sha(SOLUTION), opens_commitment: true, verdict: "pass", next: JUDGED_PASS });
    const announcement = judged["announcement"] as Address;
    expect(await ok(judge, "wallet_judge_work", { intent, artifact, announcement })).toMatchObject({ announcement, verdict: "pass", next: JUDGED_PASS });
    const other = (await generateKeyPairSigner()).address;
    expect((await call(judge, "wallet_judge_work", { intent, artifact, announcement: other })).value).toMatchObject({ code: "NotAnnounced", hint: artifactDiffers(artifact, sha(SOLUTION)) });
  }, 120_000);

  it("refuses announced work that is not UTF-8 text before running anything, and keeps no receipt", async () => {
    const intent = await delivered(NOT_UTF8);
    const refused = await call(judge, "wallet_judge_work", { intent, artifact: saved(NOT_UTF8) });
    expect(refused.value).toMatchObject({ code: "NotJudged", hint: NOT_TEXT_WORK });
  });

  it("fails work that passes in the host engine only", async () => {
    const intent = await delivered(ONLY_ON_V8);
    const judged = await ok(judge, "wallet_judge_work", { intent, artifact: saved(ONLY_ON_V8) });
    expect(judged["host"]).toMatchObject({ total: 13, passed: 13 });
    expect(judged["cases"]["passed"]).toBe(0);
    expect(judged).toMatchObject({ verdict: "fail", next: JUDGED_FAIL });
  }, 120_000);

  it("does not call fetched work that its announcement did not commit to ready to pay, even when another announcement opens to it and it passes", async () => {
    const intent = await escrow();
    h.specPages.set(WORK_URL, SOLUTION);
    await announce(worker, intent, sha(OTHER), WORK_URL);
    const second = await server(mkdtempSync(join(tmpdir(), "second-home-")));
    const secondWallet = (await ok(second, "wallet_setup"))["address"] as Address;
    await announce(second, intent, sha(SOLUTION), WORK_URL);
    const judged = await ok(judge, "wallet_judge_work", { intent });
    expect(judged).toMatchObject({ worker: secondWallet, sha256: sha(SOLUTION), opens_commitment: false, verdict: "pass", next: WORK_DIFFERS });
  }, 120_000);
});
