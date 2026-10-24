import { type Address, generateKeyPairSigner, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, EVENT_IX_TAG, getIntentAttestedEventEncoder, Kind, NATIVE_MINT } from "@intent-engine/core";
import { createClient, keepsKey } from "@intent-engine/client";
import { tool } from "../src/agent/names.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { ENV_KEYPAIR } from "../src/clusters.js";
import { EXIT_OK } from "../src/main.js";
import { call as callOn, ENDPOINT, job, LEVELS, logged, PATH, publish, served } from "./encryption-job.js";
import { cli, creation, h, NOW, transport, world } from "./harness.js";
import { device, found } from "./ledger-device.js";

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

async function connect(): Promise<Client> {
  h.served.length = 0;
  const started = await cli(["mcp", "--url", "devnet", "--wallet", "--all-tools"], {});
  expect([started.code, started.err]).toEqual([EXIT_OK, WALLET_NOTICE.join("\n")]);
  const [near, far] = InMemoryTransport.createLinkedPair();
  await h.served[0]?.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return client;
}

async function ok(client: Client, name: string, args: object = {}): Promise<Json> {
  const result = await client.callTool({ name: tool(name), arguments: args as Record<string, unknown> });
  expect(result.isError === true, JSON.stringify(result.structuredContent)).toBe(false);
  return result.structuredContent as Json;
}

async function keypairWallet() {
  const w = await world();
  h.files.clear();
  preset(NATIVE_MINT);
  preset(DEVNET_TEST_MINT);
  const client = await connect();
  const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
  return { w, client, wallet };
}

describe("wallet_profile and the encryption key", () => {
  it("lists a new key, the removal of one, and nothing about a key when none is given or kept", async () => {
    const { client, wallet } = await keypairWallet();
    const made = await cli(["profile", "encryption-key", "new", "--out", "judge.enc"], {});
    expect([made.code, made.err]).toEqual([EXIT_OK, ""]);
    const key = String(made.json()["encryption_key"]);
    const fields = { skills: ["rust"], endpoint: ENDPOINT };
    expect((await ok(client, "wallet_profile", fields))["summary"]).toEqual([`Creates: the profile of this wallet ${wallet}`, "Skills: rust", `Endpoint: ${ENDPOINT}`, "Document: none"]);
    const keyed = await ok(client, "wallet_profile", { ...fields, encryption_key: key });
    expect(keyed["summary"]).toEqual([`Creates: the profile of this wallet ${wallet}`, "Skills: rust", `Endpoint: ${ENDPOINT}`, "Document: none", `Encryption key: ${key}; deliveries are sealed to it`]);
    expect(await ok(client, "wallet_profile", { ...fields, encryption_key: key, approval: keyed["approval"], send: true })).toMatchObject({ sent: true });
    expect((await ok(client, "wallet_profile", { ...fields, encryption_key: "none" }))["summary"]).toContain("Encryption key: none; deliveries are sealed to the key derived from the wallet");
  });

  it("refuses only a Ledger wallet that judges an open escrow to drop its key, and lets it update its profile keeping the key", async () => {
    const j = await job();
    logged(j, [await publish(j, j.publicKey, 0)]);
    h.env[ENV_KEYPAIR] = PATH;
    const client = await served(device(j.key, found(LEVELS, j.key)), []);
    const kept = await callOn(client, "wallet_profile", { skills: ["judge"], endpoint: ENDPOINT });
    expect(kept.error, JSON.stringify(kept.value)).toBe(false);
    expect(kept.value["summary"]).toContain(`Encryption key: ${j.publicKey}; deliveries are sealed to it`);
    expect(await callOn(client, "wallet_profile", { close: true })).toMatchObject({ error: true, value: { code: "KeyInUse", hint: keepsKey(j.key.address, [j.intent]) } });
  });
});

describe("wallet_feedback", () => {
  it("builds no transaction for a preview and sends the one it builds when told to", async () => {
    const { w, client, wallet } = await keypairWallet();
    const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: w.owner.address, specHash: new Uint8Array(32).fill(3), judgeFee: 0n } as const;
    const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
    const payee = (await generateKeyPairSigner()).address;
    const attested = getIntentAttestedEventEncoder().encode({
      intent,
      owner: wallet,
      solver: payee,
      payee,
      attestor: payee,
      amountIn: 100n,
      result: 1n,
      fee: 0n,
      net: 100n,
      filled: 100n,
      remaining: 0n,
      partnerFee: 0n,
    });
    h.engineLog = [{ signature: "release", slot: 3n, blockTime: null, failed: false, emitted: [new Uint8Array([...EVENT_IX_TAG, ...attested])], memos: [] }, creation(intent)];
    h.simulated.length = 0;
    const shown = await ok(client, "wallet_feedback", { intent, score: 80 });
    expect(shown).toMatchObject({ intent, score: 80, sent: false });
    expect(h.simulated).toEqual([]);
    expect(await ok(client, "wallet_feedback", { intent, score: 80, approval: shown["approval"], send: true })).toMatchObject({ sent: true, signature: expect.any(String) });
  });
});
