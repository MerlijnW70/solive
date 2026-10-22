import { type Address, generateKeyPairSigner, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { DEVNET_TEST_MINT as TEST_TOKEN, NATIVE_MINT } from "@intent-engine/core";
import { noJudgeKey, WARN_NO_JUDGE_KEY } from "@intent-engine/client";
import { beforeEach, describe, expect, it } from "vitest";
import { findJobs } from "../src/agent/jobs.js";
import { RESULT_MEANS, walletAttest } from "../src/agent/wallet/attest.js";
import { CHECK_MEANS, checkDelivery, walletCheckDelivery } from "../src/agent/wallet/delivery.js";
import { SPEC_NO_ANSWER } from "../src/agent/wallet/escrow.js";
import { getReceipt, walletReceipt } from "../src/agent/wallet/receipt.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { EXIT_OK } from "../src/main.js";
import { cli, h, world } from "./harness.js";

type Json = Record<string, unknown>;
type Schema = { description?: string; properties?: Record<string, Schema>; items?: Schema; anyOf?: Schema[] };

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

async function ok(client: Client, name: string, args: object = {}): Promise<Json> {
  const result = await client.callTool({ name: `solive_${name}`, arguments: args as Record<string, unknown> });
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
  return result.structuredContent as Json;
}

const field = (schema: unknown, ...path: string[]): string =>
  ((found) => found?.description ?? found?.anyOf?.[0]?.description ?? "")(
    path.reduce<Schema | undefined>((at, key) => (key === "[]" ? at?.items : at?.properties?.[key]), schema as Schema),
  );

describe("the gaps a second blind hire left", () => {
  let client: Client;
  let owner: Address;

  beforeEach(async () => {
    await world();
    h.files.clear();
    for (const name of Object.keys(h.env)) {
      delete h.env[name];
    }
    preset(NATIVE_MINT);
    preset(TEST_TOKEN);
    client = await connect(["mcp", "--url", "devnet", "--wallet"]);
    owner = (await ok(client, "wallet_setup"))["address"] as Address;
  });

  it("tells a hirer to keep the answer and its hash out of a spec and to use claims", async () => {
    const { tools } = await client.listTools();
    const escrow = tools.find((t) => t.name === "solive_wallet_escrow");
    expect(field(escrow?.inputSchema, "spec_hash")).toContain("never put the answer or its sha256 in the spec of work others could compute");
    const preview = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: owner, spec_hash: "71".repeat(32) });
    expect(preview["warnings"]).toContain(SPEC_NO_ANSWER);
    expect(SPEC_NO_ANSWER).toContain("keep the answer and its sha256 out of the spec");
    expect(SPEC_NO_ANSWER).toContain("open claims with intent-engine claims open, which reserve the job for one worker");
    const unlisted = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: owner });
    expect(unlisted["warnings"]).not.toContain(SPEC_NO_ANSWER);
  });

  it("leaves out the Ledger warning when this key-file wallet judges, and says whom it affects and what to do otherwise", async () => {
    const own = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: owner, spec_hash: "72".repeat(32) });
    expect(JSON.stringify(own["warnings"])).not.toContain(WARN_NO_JUDGE_KEY);
    const other = (await generateKeyPairSigner()).address;
    const hired = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: other, spec_hash: "73".repeat(32) });
    expect(hired["warnings"]).toContain(noJudgeKey(other));
    expect(noJudgeKey(other)).toContain(`It matters only if ${other} judges on a Ledger`);
    expect(noJudgeKey(other)).toContain("publishes it with profile set --encryption-key before this escrow is sent. A judge with a key file can ignore this");
  });

  it("describes result, pay_to, payee, paid_to and check", () => {
    expect(RESULT_MEANS).toContain("On a proof escrow it records that the work passed the spec");
    expect(RESULT_MEANS).toContain("it does not change the amount paid");
    const attest = walletAttest.output.json;
    expect(field(attest, "result")).toBe(RESULT_MEANS);
    expect(field(attest, "pay_to")).toBe("the wallet this release pays, as given");
    expect(field(attest, "payee")).toContain("pay_to's token account for the escrowed token, where the tokens land");
    for (const receipt of [walletReceipt.output.json, getReceipt.output.json]) {
      expect(field(receipt, "result")).toBe(RESULT_MEANS);
      expect(field(receipt, "paid_to")).toBe("the wallet the release paid, the pay_to its attestor gave; it owns payee");
      expect(field(receipt, "payee")).toContain("owned by paid_to");
    }
    for (const listing of [walletCheckDelivery.output.json, checkDelivery.output.json]) {
      expect(field(listing, "deliveries", "[]", "check")).toBe(CHECK_MEANS);
    }
    expect(CHECK_MEANS).toContain("a judge does nothing with it and never passes it on");
  });

  it("names what a job pays in whole tokens next to net_pay", () => {
    expect(field(findJobs.output.json, "jobs", "[]", "pays")).toContain("sells in whole tokens of input_mint");
    expect(field(findJobs.output.json, "jobs", "[]", "sells")).toBe("raw units of input_mint still escrowed");
    expect(findJobs.description).toContain("each pays sells, in raw units of input_mint, shown in whole tokens as pays");
  });
});
