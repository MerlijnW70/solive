import { type Address, generateKeyPairSigner, type KeyPairSigner, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, NATIVE_MINT } from "@intent-engine/core";
import { findIntentPda } from "@intent-engine/core/internal";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { pieceUnsettled } from "../src/agent/wallet/escrow.js";
import { EXIT_FAILED, EXIT_OK } from "../src/main.js";
import { balance, cli, h, world, type World } from "./harness.js";
import { approved } from "./approved.js";

type Json = Record<string, unknown> & { [key: string]: any };

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

describe("create attested refuses an escrow no release could settle", () => {
  let w: World;
  let keys: Record<string, KeyPairSigner>;

  beforeEach(async () => {
    w = await world();
    keys = { "owner.json": w.owner };
  });

  const attested = (attestor: Address, amountIn: string, judgeFee: string, ...more: string[]) => [
    "create",
    "attested",
    "--keypair",
    "owner.json",
    "--input-mint",
    w.inputMint,
    "--output-mint",
    w.outputMint,
    "--expires-in",
    "3600",
    "--units",
    "raw",
    "--amount-in",
    amountIn,
    "--min-result",
    "1",
    "--max-result",
    "1",
    "--attestor",
    attestor,
    "--spec-hash",
    "ab".repeat(32),
    "--judge-fee",
    judgeFee,
    "--partner",
    w.authority.address,
    "--partner-bps",
    "50",
    ...more,
  ];

  it("refuses with nothing sent when the judge fee leaves too little for the rounded-up fees", async () => {
    const judge = await generateKeyPairSigner();
    const [intent] = await findIntentPda({ owner: w.owner.address, nonce: 0n });
    const held = balance(w.ownerInput);
    const wires = h.wires.length;
    const refused = await cli(attested(judge.address, "2", "1", "--yes"), keys);
    expect(refused.code).toBe(EXIT_FAILED);
    expect(refused.err).toContain("NeverSettles: no release of this escrow could settle");
    expect(refused.err).toContain("escrow at least 0.000003, or lower the judge fee to at most 0");
    expect(h.svm.getAccount(intent).exists).toBe(false);
    expect(balance(w.ownerInput)).toBe(held);
    expect(h.wires.length).toBe(wires);
  });

  it("creates the boundary escrow that settles", async () => {
    const judge = await generateKeyPairSigner();
    const made = await cli(attested(judge.address, "3", "1", "--yes"), keys);
    expect([made.code, made.err]).toEqual([EXIT_OK, ""]);
    const [intent] = await findIntentPda({ owner: w.owner.address, nonce: 0n });
    expect(h.svm.getAccount(intent).exists).toBe(true);
    expect(balance(w.ownerInput)).toBe(997n);
  });
});

describe("the wallet escrow tools refuse an escrow no release could settle", () => {
  let client: Client;
  let owner: Address;

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
  });

  const escrow = { sell: "SOL", amount: "0.05", attestor: "", min_result: "1", max_result: "1", spec_hash: "5e".repeat(32) };

  it("wallet_escrow refuses a judge fee that leaves nothing, with nothing sent, and creates the boundary that settles", async () => {
    const terms = { ...escrow, attestor: owner };
    const wires = h.wires.length;
    for (const send of [false, true]) {
      const refused = await call(client, "wallet_escrow", { ...terms, judge_fee: "0.05", send });
      expect(refused.error).toBe(true);
      expect(refused.value).toMatchObject({ code: "NeverSettles" });
      expect(refused.value["hint"]).toContain("escrow at least 0.050000001, or lower the judge fee to at most 0.049999999");
    }
    expect(h.wires.length).toBe(wires);
    expect((await ok(client, "wallet_intents"))["intents"]).toEqual([]);
    const made = await ok(client, "wallet_escrow", await approved(client, "wallet_escrow", { ...terms, judge_fee: "0.049999999" }));
    expect(made).toMatchObject({ sent: true, signature: expect.any(String) });
    expect((await ok(client, "wallet_intents"))["intents"]).toHaveLength(1);
  });

  it("wallet_escrow_plan refuses the whole plan when one piece cannot settle, and escrows the least piece that settles", async () => {
    const plan = { sell: "SOL", attestor: owner, pieces: [{ name: "parser", amount: "0.01" }, { name: "empty", amount: "0" }, { name: "page", amount: "0.01" }] };
    const wires = h.wires.length;
    for (const send of [false, true]) {
      const refused = await call(client, "wallet_escrow_plan", { ...plan, send });
      expect(refused.error).toBe(true);
      expect(refused.value).toMatchObject({ code: "NeverSettles" });
      expect(refused.value["hint"]).toContain(pieceUnsettled(2, "empty"));
      expect(refused.value["hint"]).toContain("escrow at least 0.000000001");
    }
    expect(h.wires.length).toBe(wires);
    expect((await ok(client, "wallet_intents"))["intents"]).toEqual([]);
    const least = { ...plan, pieces: [plan.pieces[0], { name: "least", amount: "0.000000001" }], send: true };
    const made = await ok(client, "wallet_escrow_plan", await approved(client, "wallet_escrow_plan", least));
    expect(made).toMatchObject({ sent: true, total: "0.010000001" });
    expect((await ok(client, "wallet_intents"))["intents"]).toHaveLength(2);
  });
});
