import { type Address, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, formatAmount, getClaimBoardSize, getIntentSize, NATIVE_MINT } from "@intent-engine/core";
import { SIGNATURE_FEE } from "../src/agent/budget.js";
import { CLAIMS_ADVICE, SPEC_ANSWER_OUT, SPEC_NO_ANSWER } from "../src/agent/wallet/escrow.js";
import { TOTAL } from "../src/agent/wallet/costs.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { EXIT_OK } from "../src/main.js";
import { LAMPORTS_PER_SOL } from "../src/wallet.js";
import { cli, h, world } from "./harness.js";

type Json = Record<string, unknown>;

const SPEC_HASH = "6e".repeat(32);

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

async function connect(): Promise<Client> {
  h.served.length = 0;
  const started = await cli(["mcp", "--url", "devnet", "--wallet"], {});
  expect([started.code, started.err]).toEqual([EXIT_OK, WALLET_NOTICE.join("\n")]);
  const [near, far] = InMemoryTransport.createLinkedPair();
  await h.served[0]?.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return client;
}

async function ok(client: Client, name: string, args: object = {}): Promise<Json> {
  const result = await client.callTool({ name: `solive_${name}`, arguments: args as Record<string, unknown> });
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
  return result.structuredContent as Json;
}

const lamportsOf = (sol: string): bigint => {
  const [whole = "0", part = ""] = sol.split(".");
  return BigInt(whole) * LAMPORTS_PER_SOL + BigInt(part.padEnd(9, "0"));
};

function totalOf(summary: unknown): bigint {
  const line = (summary as string[]).find((text) => text.startsWith(TOTAL));
  expect(line, JSON.stringify(summary)).toBeDefined();
  const found = /^Total: this (?:send|plan) takes ([0-9.]+) SOL from this wallet: /.exec(line ?? "");
  expect(found, line).not.toBeNull();
  return lamportsOf(found?.[1] ?? "");
}

const rentOf = (bytes: number) => `${formatAmount(h.svm.minimumBalanceForRentExemption(BigInt(bytes)), 9)} SOL`;

const balance = (address: Address) => h.svm.getBalance(address) ?? 0n;

describe("the costs an escrow preview names", () => {
  let client: Client;
  let wallet: Address;

  beforeEach(async () => {
    const w = await world();
    const economics = await cli(["set-economics", "--keypair", "a.json", "--yes", "--bounty", "7000", "--create-fee", "9000"], { "a.json": w.authority });
    expect([economics.code, economics.err]).toEqual([EXIT_OK, ""]);
    h.files.clear();
    for (const name of Object.keys(h.env)) {
      delete h.env[name];
    }
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    client = await connect();
    wallet = (await ok(client, "wallet_setup"))["address"] as Address;
  });

  it("totals what wallet_escrow takes, and the total matches the drop in this wallet's SOL after each send", async () => {
    const args = { sell: "SOL", amount: "0.05", attestor: wallet, spec_hash: SPEC_HASH, claim_stake: "0.01", claim_secs: 600 };
    for (const round of [0, 1]) {
      const preview = await ok(client, "wallet_escrow", args);
      const summary = preview["summary"] as string[];
      const rent = summary.find((line) => line.startsWith("Rent: ")) ?? "";
      expect(rent).toContain(`${rentOf(getIntentSize())} for the escrow account, ${rentOf(165)} for its token vault, ${rentOf(getClaimBoardSize())} for the claims board`);
      expect(rent.includes("for your wrapped SOL account")).toBe(round === 0);
      expect(rent.includes(`for your token account for ${DEVNET_TEST_MINT}`)).toBe(round === 0);
      expect(summary).toContain("Fees: 0.000009 SOL create fee to the treasury, 0.000007 SOL crank bounty the escrow holds for whoever closes it, 0.000005 SOL network fee");
      const total = totalOf(summary);
      expect(total).toBeGreaterThan(LAMPORTS_PER_SOL / 20n);
      const before = balance(wallet);
      expect(await ok(client, "wallet_escrow", { ...args, send: true })).toMatchObject({ sent: true });
      const drop = before - balance(wallet);
      expect(drop - total <= SIGNATURE_FEE && total - drop <= SIGNATURE_FEE, `${drop} vs ${total}`).toBe(true);
    }
  });

  it("totals what wallet_escrow_plan takes across its pieces, setup once", async () => {
    const plan = { sell: "SOL", attestor: wallet, spec_hash: SPEC_HASH, pieces: [{ name: "parser", amount: "0.02" }, { name: "page", amount: "0.03" }] };
    const preview = await ok(client, "wallet_escrow_plan", plan);
    const summary = preview["summary"] as string[];
    expect(summary).toContain("Fees per piece: 0.000009 SOL create fee to the treasury, 0.000007 SOL crank bounty the escrow holds for whoever closes it, 0.000005 SOL network fee");
    expect(summary).toContain(`Rent per piece: ${rentOf(getIntentSize())} for the escrow account, ${rentOf(165)} for its token vault`);
    expect(summary).toContainEqual(expect.stringMatching(/^Rent once: .*for your wrapped SOL account$/));
    const total = totalOf(summary);
    const before = balance(wallet);
    expect(await ok(client, "wallet_escrow_plan", { ...plan, send: true })).toMatchObject({ sent: true });
    const drop = before - balance(wallet);
    expect(drop - total <= 2n * SIGNATURE_FEE && total - drop <= 2n * SIGNATURE_FEE, `${drop} vs ${total}`).toBe(true);
  });

  it("leaves out the claims advice when the call opens claims", async () => {
    const base = { sell: "SOL", amount: "0.05", attestor: wallet, spec_hash: SPEC_HASH };
    expect((await ok(client, "wallet_escrow", base))["warnings"]).toContain(SPEC_NO_ANSWER);
    const claimed = (await ok(client, "wallet_escrow", { ...base, claim_stake: "0.01", claim_secs: 600 }))["warnings"];
    expect(claimed).toContain(SPEC_ANSWER_OUT);
    expect(JSON.stringify(claimed)).not.toContain(CLAIMS_ADVICE);
    const plan = { sell: "SOL", attestor: wallet, spec_hash: SPEC_HASH, pieces: [{ name: "a", amount: "0.01" }, { name: "b", amount: "0.01" }], claim_stake: "0.01", claim_secs: 600 };
    expect(JSON.stringify(await ok(client, "wallet_escrow_plan", plan))).not.toContain(CLAIMS_ADVICE);
  });
});
