import { createHash } from "node:crypto";
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
import { MARKET_LINES, JOB_PROMPTS } from "../src/agent/mcp.js";
import { getSpec, shownRunRead } from "../src/agent/spec.js";
import { PINNED_RUN, walletJudgeWork } from "../src/agent/wallet/judge-work.js";
import { RUN_UNJUDGEABLE } from "../src/agent/wallet/seal.js";
import { TIMEOUT_RULE } from "../src/judge-run.js";
import { strayFence } from "../src/spec-blocks.js";
import { SANDBOX_IMAGE } from "../src/sandbox.js";
import { EXIT_OK, main } from "../src/main.js";
import { DOMAIN, h, runtime, world } from "./harness.js";
import { approved } from "./approved.js";

type Json = Record<string, unknown> & { [key: string]: any };

const RUN = "node check/check.mjs";
const BLOCK = { image: SANDBOX_IMAGE, run: RUN, timeout: 60 };
const specWith = (fields: object) => new TextEncoder().encode(`# Job\n\nCount words.\n\n\`\`\`judge-run\n${JSON.stringify(fields)}\n\`\`\`\n`);
const GOOD = specWith({ ...BLOCK, memory: "512m" });
const BAD = specWith({ ...BLOCK, timeout: 0 });
const BAD_WHY = `the spec's judge-run block has timeout 0, which is not ${TIMEOUT_RULE}`;
const WORK = new TextEncoder().encode("export default (text) => text.split(' ').length;\n");
const SPEC_URL = "https://" + "spec.example.org/" + "s".repeat(32) + ".md";
const BAD_URL = "https://" + "spec.example.org/" + "b".repeat(32) + ".md";
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

async function refusal(client: Client, name: string, args: object): Promise<Json> {
  const result = await client.callTool({ name: tool(name), arguments: args as Record<string, unknown> });
  expect(result.isError).toBe(true);
  return result.structuredContent as Json;
}

const status = (intent: Address) => {
  const account = h.svm.getAccount(intent);
  return account.exists ? getIntentDecoder().decode(account.data).status : undefined;
};

describe("the MCP tools under a judge-run block", () => {
  let judge: Client;
  let worker: Client;
  let judgeWallet: Address;

  beforeEach(async () => {
    await world();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    h.through = svmTransport(h.svm, { genesisHash: getBase58Decoder().decode(DOMAIN) });
    judge = await server("/home/judge");
    judgeWallet = (await ok(judge, "wallet_setup"))["address"] as Address;
    worker = await server("/home/worker");
    await ok(worker, "wallet_setup");
    h.watched.push(judgeWallet);
    h.specPages.set(SPEC_URL, GOOD);
    h.specPages.set(BAD_URL, BAD);
    h.specPages.set(WORK_URL, WORK);
  });

  async function escrowed(): Promise<Address> {
    const escrow = await ok(judge, "wallet_escrow", await approved(judge, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: judgeWallet, spec_hash: sha(GOOD), spec_url: SPEC_URL }));
    const intent = escrow["intent"] as Address;
    expect(await ok(worker, "wallet_deliver", await approved(worker, "wallet_deliver", { intent, sha256: sha(WORK), url: WORK_URL, send: true }))).toMatchObject({ sent: true });
    return intent;
  }

  it("get_spec shows the pinned check a worker will be judged by", async () => {
    const intent = await escrowed();
    const read = await ok(worker, "get_spec", { intent });
    expect(read).toMatchObject({ matches: true, judge_run: { image: SANDBOX_IMAGE, run: RUN, timeout: 60, memory: "512m", cpus: null, check_files_pinned: false, check_sha256: null } });
    expect(read).not.toHaveProperty("judge_run_refused");
    expect(getSpec.description).toContain("judge_run is the check a judge-run block pins, which judge runs exactly");
  });

  it("wallet_judge_work refuses a spec with a judge-run block and says to use judge, running and sending nothing", async () => {
    const intent = await escrowed();
    const refused = await refusal(judge, "wallet_judge_work", { intent });
    expect(refused).toMatchObject({ code: "NoJudgeCases", retryable: false, hint: PINNED_RUN });
    expect(PINNED_RUN).toContain("the CLI command judge, which runs exactly the pinned check");
    expect(walletJudgeWork.description).toContain("Without judge cases, use judge --sandbox docker.");
    expect(status(intent)).toBe(IntentStatus.Open);
  });

  it("wallet_escrow refuses a malformed block at spec_url or in spec_text, on preview and on send, before money moves", async () => {
    const before = h.wires.length;
    for (const send of [false, true]) {
      const fromUrl = await refusal(judge, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: judgeWallet, spec_hash: sha(BAD), spec_url: BAD_URL, send });
      expect(JSON.stringify(fromUrl)).toContain(`${BAD_WHY}; ${RUN_UNJUDGEABLE}`);
      const fromText = await refusal(judge, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: judgeWallet, spec_hash: sha(BAD), spec_text: new TextDecoder().decode(BAD), send });
      expect(JSON.stringify(fromText)).toContain(`${BAD_WHY}; ${RUN_UNJUDGEABLE}`);
    }
    const plan = await refusal(judge, "wallet_escrow_plan", { sell: "SOL", attestor: judgeWallet, pieces: [{ name: "one", amount: "0.01", spec_hash: sha(BAD), spec_url: BAD_URL }, { name: "two", amount: "0.01", spec_hash: sha(GOOD), spec_url: SPEC_URL }] });
    expect(JSON.stringify(plan)).toContain(`Piece 1 (one): ${BAD_WHY}; ${RUN_UNJUDGEABLE}`);
    expect(h.wires.length).toBe(before);
    expect((await ok(judge, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: judgeWallet, spec_hash: sha(GOOD), spec_url: SPEC_URL }))["sent"]).toBe(false);
  });

  it("wallet_seal_spec refuses a malformed block and seals a good one", async () => {
    const refused = await refusal(judge, "wallet_seal_spec", { text: new TextDecoder().decode(BAD), invite: [judgeWallet] });
    expect(JSON.stringify(refused)).toContain(`${BAD_WHY}; ${RUN_UNJUDGEABLE}`);
    expect(await ok(judge, "wallet_seal_spec", { text: new TextDecoder().decode(GOOD), invite: [judgeWallet] })).toMatchObject({ sha256: sha(GOOD) });
  });

  it("get_spec shows, and wallet_escrow and wallet_seal_spec refuse, a quoted or listed fence of either kind before money moves", async () => {
    const forms = [
      ["https://" + "spec.example.org/" + "q".repeat(32) + ".md", `# Job\n\n> \`\`\`judge-run\n> ${JSON.stringify(BLOCK)}\n> \`\`\`\n`, "judge-run"],
      ["https://" + "spec.example.org/" + "l".repeat(32) + ".md", '# Job\n\n- ```judge-cases\n  {"cases": [{"args": [], "expected": 1}]}\n  ```\n', "judge-cases"],
    ] as const;
    const before = h.wires.length;
    for (const [url, text, kind] of forms) {
      const bytes = new TextEncoder().encode(text);
      h.specPages.set(url, bytes);
      const why = `the spec ${strayFence(kind, 1, 0)}`;
      const refused = await refusal(judge, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: judgeWallet, spec_hash: sha(bytes), spec_url: url });
      expect(JSON.stringify(refused), kind).toContain(JSON.stringify(`${why}; ${RUN_UNJUDGEABLE}`).slice(1, -1));
      const sealed = await refusal(judge, "wallet_seal_spec", { text, invite: [judgeWallet] });
      expect(JSON.stringify(sealed), kind).toContain("plain top-level");
    }
    expect(h.wires.length).toBe(before);
    for (const [, text, kind] of forms) {
      expect(shownRunRead(new TextEncoder().encode(text)), kind).toStrictEqual({ judge_run_refused: `the spec ${strayFence(kind, 1, 0)}` });
    }
  });

  it("names when the check is pinned in the market guide and the judge prompt", () => {
    expect(MARKET_LINES.join("\n")).toContain("exactly the one a judge-run block in the spec pins, else its own");
    expect(JOB_PROMPTS.find((prompt) => prompt.name === "judge")?.text).toContain("which runs exactly the check a judge-run block pins");
  });
});
