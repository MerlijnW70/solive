import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, createKeyPairSignerFromPrivateKeyBytes, getAddressEncoder, getBase58Decoder, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, findAssociatedTokenAddress, IntentStatus, NATIVE_MINT } from "@intent-engine/core";
import { findIntentPda, getIntentDecoder } from "@intent-engine/core/internal";
import { svmTransport } from "@intent-engine/client/svm";
import { FETCH_FAILED } from "../src/agent/spec.js";
import { ENV_KEYPAIR } from "../src/clusters.js";
import { EXIT_OK } from "../src/main.js";
import {
  SMOKE_NOT_MAINNET,
  SMOKE_SAME_KEY,
  SMOKE_SOL,
  SMOKE_SPEC_HTTPS,
  SMOKE_USAGE,
  SmokeFailed,
  type SmokeRun,
  type ToolCaller,
  serverArgs,
  smoke,
  smokeOptions,
  smokeWork,
  tooPoor,
} from "../src/mcp-smoke.js";
import { main } from "../src/main.js";
import { DOMAIN, h, HOME, runtime, world } from "./harness.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const SCRIPT = join(ROOT, "scripts/mcp-smoke.sh");
const SOL = 1_000_000_000n;
const SPEC_URL = "https://" + "example.org/jobs/smoke.md";
const SPEC = "the smoke job: announce any work\n";
const STEPS = [
  "hirer wallet",
  "worker wallet",
  "spec hash",
  "escrow preview",
  "escrow",
  "find job",
  "get spec",
  "hash work",
  "deliver preview",
  "deliver",
  "check delivery",
  "attest preview",
  "attest",
  "receipt",
  "unwrap preview",
  "unwrap",
];

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

async function party(name: string, sol: bigint): Promise<{ caller: ToolCaller; address: Address }> {
  const seed = crypto.getRandomValues(new Uint8Array(32));
  const signer = await createKeyPairSignerFromPrivateKeyBytes(seed);
  const path = `${HOME}/${name}.json`;
  h.files.set(path, JSON.stringify([...seed, ...getAddressEncoder().encode(signer.address)]));
  h.svm.airdrop(signer.address, lamports(sol));
  h.served.length = 0;
  const code = await main(serverArgs("devnet"), { ...runtime({}), env: { [ENV_KEYPAIR]: path } }, { out: () => undefined, err: () => undefined });
  expect(code).toBe(EXIT_OK);
  const server = h.served[0];
  if (server === undefined) {
    throw new Error("no server was started");
  }
  const [near, far] = InMemoryTransport.createLinkedPair();
  await server.connect(near);
  const client = new Client({ name: "smoke-test", version: "0.0.0" });
  await client.connect(far);
  return { caller: (tool, args) => client.callTool({ name: tool, arguments: args }), address: signer.address };
}

const run: SmokeRun = { specUrl: SPEC_URL, specText: SPEC, workUrl: SPEC_URL, work: smokeWork(SPEC_URL, 1n), wait: 1 };

describe("the MCP smoke run", () => {
  beforeEach(async () => {
    await world();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    h.through = svmTransport(h.svm, { genesisHash: getBase58Decoder().decode(DOMAIN) });
    h.specPages.set(SPEC_URL, new TextEncoder().encode(SPEC));
  });

  it("hires and pays a worker through two wallet servers, one line per step, and ends with the release", async () => {
    const hirer = await party("hirer", 2n * SOL);
    const worker = await party("worker", SOL);
    const lines: string[] = [];
    const result = await smoke({ hirer: hirer.caller, worker: worker.caller }, run, (line) => lines.push(line));
    expect(result.steps).toEqual(STEPS);
    expect(lines.map((line) => line.slice(0, line.indexOf(":")))).toEqual(STEPS.map((step) => `ok ${step}`));
    expect(result.release).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
    expect(lines.find((line) => line.startsWith("ok attest:"))).toContain(result.release);
    const [intent] = await findIntentPda({ owner: hirer.address, nonce: 0n });
    expect(result.intent).toBe(intent);
    const held = h.svm.getAccount(intent);
    expect(held.exists && getIntentDecoder().decode(held.data).status).toBe(IntentStatus.Filled);
    expect(held.exists && getIntentDecoder().decode(held.data).filled).toBe(SOL / 100n);
    expect(SMOKE_SOL).toBe("0.01");
    const wrapped = await findAssociatedTokenAddress({ owner: worker.address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(h.svm.getAccount(wrapped).exists).toBe(false);
    expect(h.svm.getBalance(worker.address) ?? 0n).toBeGreaterThan(SOL);
  });

  it("stops at the first failing step and names it with the tool's problem", async () => {
    const hirer = await party("hirer", 2n * SOL);
    const worker = await party("worker", SOL);
    const lines: string[] = [];
    const flaky: ToolCaller = (tool, args) => {
      if (tool.endsWith("_get_spec")) {
        h.specPages.delete(SPEC_URL);
      }
      return worker.caller(tool, args);
    };
    const failed = await smoke({ hirer: hirer.caller, worker: flaky }, run, (line) => lines.push(line)).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(SmokeFailed);
    const { step, problem, message } = failed as SmokeFailed;
    expect(step).toBe("get spec");
    expect(problem).toMatch(/^SpecUnreadable: /);
    expect(problem).toContain(FETCH_FAILED);
    expect(message).toBe(`get spec failed: ${problem}`);
    expect(lines.at(-1)).toMatch(/^ok find job: /);
    const [intent] = await findIntentPda({ owner: hirer.address, nonce: 0n });
    const held = h.svm.getAccount(intent);
    expect(held.exists && getIntentDecoder().decode(held.data).status).toBe(IntentStatus.Open);
  });

  it("refuses a hirer too poor for the escrow before any preview", async () => {
    const hirer = await party("hirer", SOL / 100n);
    const worker = await party("worker", SOL);
    const failed = await smoke({ hirer: hirer.caller, worker: worker.caller }, run).catch((error: unknown) => error);
    expect(failed).toMatchObject({ step: "hirer wallet", problem: tooPoor("0.01", "0.02") });
  });

  it("starts each server with its wallet capped at the smoke escrow per trade", () => {
    expect(serverArgs("devnet")).toEqual(["mcp", "--url", "devnet", "--wallet", "--wallet-per-trade", `SOL=${SMOKE_SOL}`]);
  });
});

describe("the smoke script", () => {
  it("refuses mainnet, a shared key, a plain http spec and missing arguments", () => {
    const spec = SPEC_URL;
    expect(() => smokeOptions(["mainnet-beta", "h.json", "w.json", spec])).toThrow(SMOKE_NOT_MAINNET);
    expect(() => smokeOptions(["https://" + "mainnet.example-rpc.com/?api-key=x", "h.json", "w.json", spec])).toThrow(SMOKE_NOT_MAINNET);
    expect(() => smokeOptions(["devnet", "k.json", "k.json", spec])).toThrow(SMOKE_SAME_KEY);
    expect(() => smokeOptions(["devnet", "h.json", "w.json", "http://" + "example.org/spec.md"])).toThrow(SMOKE_SPEC_HTTPS);
    expect(() => smokeOptions(["devnet", "h.json", "w.json"])).toThrow(SMOKE_USAGE);
    expect(smokeOptions(["devnet", "h.json", "w.json", spec])).toEqual({ url: "https://api.devnet.solana.com", hirerKey: "h.json", workerKey: "w.json", specUrl: spec });
  });

  it("exits before starting any server when given a mainnet url", () => {
    const refused = spawnSync("bash", [SCRIPT, "mainnet-beta", "h.json", "w.json", SPEC_URL], { encoding: "utf8" });
    expect(refused.status).toBe(2);
    expect(refused.stderr.trim()).toBe(SMOKE_NOT_MAINNET);
    expect(refused.stdout).toBe("");
  });
});
