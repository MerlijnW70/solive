import { createHash } from "node:crypto";
import { type Address, generateKeyPairSigner, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { deliveryMemo, DEVNET_TEST_MINT, IntentStatus, getIntentDecoder, NATIVE_MINT } from "@intent-engine/core";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { SERVER_PROBLEMS } from "../src/agent/problems.js";
import { EXIT_OK } from "../src/main.js";
import { creation, h, world } from "./harness.js";
import { announced, cliWith, disagreements, SECOND, secondNode, type SecondNode, UNREADABLE, WORK_URL } from "./confirm-node.js";

type Json = Record<string, unknown>;

const SPEC = "# Count words\n";
const WORK = "c4".repeat(32);

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

async function connect(argv: string[], node: SecondNode): Promise<Client> {
  h.served.length = 0;
  const started = await cliWith(argv, {}, node);
  expect([started.code, started.err]).toEqual([EXIT_OK, WALLET_NOTICE.join("\n")]);
  const [near, far] = InMemoryTransport.createLinkedPair();
  await h.served[0]?.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return client;
}

async function call(client: Client, name: string, args: object = {}) {
  const result = await client.callTool({ name: `solive_${name}`, arguments: args as Record<string, unknown> });
  return { error: result.isError === true, value: result.structuredContent as Json };
}

async function escrowed(more: string[]) {
  await world();
  preset(NATIVE_MINT);
  preset(DEVNET_TEST_MINT);
  const node = secondNode();
  const client = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools", ...more], node);
  const owner = (await call(client, "wallet_setup")).value["address"] as Address;
  const spec_hash = createHash("sha256").update(SPEC).digest("hex");
  const escrow = await call(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: owner, spec_hash, send: true });
  expect(escrow.error, JSON.stringify(escrow.value)).toBe(false);
  const intent = escrow.value["intent"] as Address;
  const worker = (await generateKeyPairSigner()).address;
  h.engineLog = [announced("first", 5n, worker, deliveryMemo({ intent, sha256: WORK, url: WORK_URL })), creation(intent)];
  const release = { owner, nonce: escrow.value["nonce"], pay_to: worker, delivered_sha256: WORK };
  const status = () => {
    const account = h.svm.getAccount(intent);
    return account.exists ? getIntentDecoder().decode(account.data).status : undefined;
  };
  return { node, client, owner, intent, release, status };
}

describe("mcp --confirm-url", () => {
  it("lets wallet_attest release only when both nodes agree, refusing each disagreement before anything is sent", async () => {
    const { node, client, owner, intent, release, status } = await escrowed(["--confirm-url", SECOND]);
    const shown = await call(client, "wallet_attest", release);
    expect(shown.error, JSON.stringify(shown.value)).toBe(false);
    expect(node.reads).toBeGreaterThan(0);
    const approval = shown.value["approval"];
    for (const { field, lie, second } of [...disagreements(intent, owner, WORK), UNREADABLE]) {
      node.lie = lie;
      const wires = h.wires.length;
      for (const args of [release, { ...release, approval, send: true }]) {
        const refused = await call(client, "wallet_attest", args);
        expect(refused, field).toMatchObject({ error: true, value: { code: "ConfirmMismatch", retryable: SERVER_PROBLEMS.ConfirmMismatch.retryable } });
        expect(refused.value["hint"]).toContain(field === "second node" ? second : `the two RPC nodes report a different ${field}`);
        expect(refused.value["hint"]).toContain(second);
        expect(refused.value["hint"]).toContain("nothing was signed or sent");
      }
      expect(h.wires.length).toBe(wires);
      expect(status()).toBe(IntentStatus.Open);
    }
    node.lie = {};
    const sent = await call(client, "wallet_attest", { ...release, approval, send: true });
    expect(sent.error, JSON.stringify(sent.value)).toBe(false);
    expect(sent.value).toMatchObject({ sent: true, signature: expect.any(String) });
    expect(status()).toBe(IntentStatus.Filled);
  });

  it("releases on one node, as today, without the flag", async () => {
    const { node, client, release, status } = await escrowed([]);
    node.lie = { down: true };
    const shown = await call(client, "wallet_attest", release);
    expect(shown.error, JSON.stringify(shown.value)).toBe(false);
    const sent = await call(client, "wallet_attest", { ...release, approval: shown.value["approval"], send: true });
    expect(sent.value).toMatchObject({ sent: true });
    expect(node.reads).toBe(0);
    expect(status()).toBe(IntentStatus.Filled);
  });
});
