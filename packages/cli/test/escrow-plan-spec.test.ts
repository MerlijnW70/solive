import { type Address, generateKeyPairSigner, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, NATIVE_MINT, specMemo } from "@intent-engine/core";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { NO_SPEC_HASH } from "../src/agent/wallet/escrow.js";
import { EXIT_OK } from "../src/main.js";
import { cli, h, world } from "./harness.js";

type Json = Record<string, unknown> & { [key: string]: any };

const SPEC_HASH = "5c".repeat(32);
const OTHER_HASH = "6d".repeat(32);
const SPEC_URL = "https://" + "example.org/jobs/spec.md";
const OTHER_URL = "https://" + "example.org/jobs/other.md";

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

async function connect(argv: string[]): Promise<Client> {
  h.served.length = 0;
  const started = await cli(argv, {});
  expect([started.code, started.err]).toEqual([EXIT_OK, WALLET_NOTICE.join("\n")]);
  const server = h.served[0];
  if (server === undefined) {
    throw new Error("no server was started");
  }
  const [near, far] = InMemoryTransport.createLinkedPair();
  await server.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return client;
}

async function call(client: Client, name: string, args: object = {}) {
  const result = await client.callTool({ name: `solive_${name}`, arguments: args as Record<string, unknown> });
  return { error: result.isError === true, value: result.structuredContent as Json };
}

async function ok(client: Client, name: string, args: object = {}): Promise<Json> {
  const { error, value } = await call(client, name, args);
  expect(error, JSON.stringify(value)).toBe(false);
  return value;
}

const memoSent = (memo: string) => h.wires.some((wire) => Buffer.from(wire, "base64").toString("latin1").includes(memo));

describe("escrow plans that workers can find", () => {
  let client: Client;
  let owner: Address;
  let judge: Address;

  beforeEach(async () => {
    await world();
    h.files.clear();
    for (const name of Object.keys(h.env)) {
      delete h.env[name];
    }
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    client = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    owner = (await ok(client, "wallet_setup"))["address"] as Address;
    h.watched.push(owner);
    judge = (await generateKeyPairSigner()).address;
  });

  it("lists a plan piece with spec_hash and spec_url in the scan find_jobs uses, and warns about a piece without spec_hash", async () => {
    const plan = {
      sell: "SOL",
      attestor: judge,
      pieces: [
        { name: "parser", amount: "0.01", spec_hash: SPEC_HASH, spec_url: SPEC_URL },
        { name: "page", amount: "0.01" },
      ],
    };
    const preview = await ok(client, "wallet_escrow_plan", plan);
    expect(preview["pieces"]).toEqual([
      { name: "parser", amount: "0.01", attestor: judge, spec_hash: SPEC_HASH, spec_url: SPEC_URL },
      { name: "page", amount: "0.01", attestor: judge },
    ]);
    expect(preview["summary"][1]).toBe(`Piece 1: parser, 0.01 of SOL, released by ${judge} against spec ${SPEC_HASH}`);
    expect(preview["warnings"]).toContain(`Piece 2 (page): ${NO_SPEC_HASH}`);
    expect(preview["warnings"].filter((line: string) => line.startsWith("Piece 1 (parser)") && line.includes("no spec_hash"))).toEqual([]);

    const sent = await ok(client, "wallet_escrow_plan", { ...plan, send: true });
    expect(sent).toMatchObject({ sent: true, pieces: [{ spec_hash: SPEC_HASH, spec_url: SPEC_URL }, { name: "page" }] });
    expect(memoSent(specMemo(SPEC_URL))).toBe(true);
    const [specced, plain] = sent["pieces"] as Json[];
    const jobs = (await ok(client, "find_jobs", { attestor: judge }))["jobs"] as Json[];
    expect(jobs.map((job) => [job["intent"], job["spec_hash"]])).toEqual([[specced?.["intent"], SPEC_HASH]]);
    expect(jobs.map((job) => job["intent"])).not.toContain(plain?.["intent"]);
  });

  it("gives every piece the plan's spec unless the piece names its own", async () => {
    const plan = {
      sell: "SOL",
      attestor: judge,
      spec_hash: SPEC_HASH,
      spec_url: SPEC_URL,
      pieces: [
        { name: "parser", amount: "0.01" },
        { name: "page", amount: "0.01", spec_hash: OTHER_HASH, spec_url: OTHER_URL },
      ],
    };
    const sent = await ok(client, "wallet_escrow_plan", { ...plan, send: true });
    expect(sent["pieces"]).toMatchObject([
      { name: "parser", spec_hash: SPEC_HASH, spec_url: SPEC_URL },
      { name: "page", spec_hash: OTHER_HASH, spec_url: OTHER_URL },
    ]);
    expect(sent["warnings"].filter((line: string) => line.includes(NO_SPEC_HASH))).toEqual([]);
    expect(memoSent(specMemo(SPEC_URL))).toBe(true);
    expect(memoSent(specMemo(OTHER_URL))).toBe(true);
    const jobs = (await ok(client, "find_jobs", { attestor: judge }))["jobs"] as Json[];
    const byIntent = new Map(jobs.map((job) => [job["intent"], job["spec_hash"]]));
    expect((sent["pieces"] as Json[]).map((piece) => byIntent.get(piece["intent"]))).toEqual([SPEC_HASH, OTHER_HASH]);
  });

  it("checks each piece's spec_url as wallet_escrow does, before anything is sent", async () => {
    const base = { sell: "SOL", attestor: judge };
    const wires = h.wires.length;
    const refusals = [
      [{ ...base, pieces: [{ name: "a", amount: "0.01", spec_url: SPEC_URL }, { name: "b", amount: "0.01" }] }, "pieces.0.spec_url"],
      [{ ...base, spec_url: SPEC_URL, pieces: [{ name: "a", amount: "0.01", spec_hash: SPEC_HASH }, { name: "b", amount: "0.01" }] }, "spec_url"],
      [{ ...base, spec_hash: SPEC_HASH, pieces: [{ name: "a", amount: "0.01" }, { name: "b", amount: "0.01", spec_url: "http://example.org/spec" }] }, "pieces.1.spec_url"],
      [{ ...base, pieces: [{ name: "a", amount: "0.01", spec_hash: "zz" }, { name: "b", amount: "0.01" }] }, "pieces.0.spec_hash"],
    ] as const;
    for (const [plan, path] of refusals) {
      for (const send of [false, true]) {
        const refused = await call(client, "wallet_escrow_plan", { ...plan, send });
        expect(refused.error).toBe(true);
        expect(refused.value).toMatchObject({ code: "InvalidInput", issues: [{ path }] });
      }
    }
    expect(h.wires.length).toBe(wires);
    expect((await ok(client, "wallet_intents"))["intents"]).toEqual([]);
  });

  it("wallet_escrow warns in its preview when the escrow has no spec_hash, and not when it has one", async () => {
    const terms = { sell: "SOL", amount: "0.05", attestor: judge };
    expect((await ok(client, "wallet_escrow", terms))["warnings"]).toContain(NO_SPEC_HASH);
    expect((await ok(client, "wallet_escrow", { ...terms, spec_hash: SPEC_HASH }))["warnings"]).not.toContain(NO_SPEC_HASH);
  });
});
