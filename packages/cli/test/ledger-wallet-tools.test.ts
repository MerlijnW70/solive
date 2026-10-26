import { createHash } from "node:crypto";
import { type Address, generateKeyPairSigner, type KeyPairSigner, lamports } from "@solana/kit";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { testSignature } from "@intent-engine/client/testing";
import { Kind } from "@intent-engine/core";
import { claimBoardAddress, EVENT_IX_TAG, getIntentAttestedEventEncoder, profileAddress } from "@intent-engine/core/internal";
import { createClient, messageHash } from "@intent-engine/client/node";
import { tool } from "../src/agent/names.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { ENV_KEYPAIR } from "../src/clusters.js";
import { EXIT_OK, main } from "../src/main.js";
import { cli, creation, h, NOW, runtime, transport, world } from "./harness.js";
import { type Device, device, deviceKey, found, type Key, SIGN, transactionThen } from "./ledger-device.js";

type Json = Record<string, unknown>;

const PATH = "usb://ledger?key=4";
const LEVELS = [44, 501, 4];

async function served(ledger: Device): Promise<Client> {
  h.served.length = 0;
  const err: string[] = [];
  const code = await main(["mcp", "--url", "devnet", "--wallet", "--all-tools"], { ...runtime({}), ledger: ledger.open }, { out: () => undefined, err: (t) => err.push(t) });
  expect([code, err.join("\n")]).toEqual([EXIT_OK, WALLET_NOTICE.join("\n")]);
  const [near, far] = InMemoryTransport.createLinkedPair();
  await h.served[0]?.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return client;
}

async function call(client: Client, name: string, args: object = {}) {
  const result = await client.callTool({ name: tool(name), arguments: args as Record<string, unknown> });
  return { error: result.isError === true, value: result.structuredContent as Json };
}

async function onDevice(): Promise<{ key: Key; owner: KeyPairSigner; intent: Address; ledger: Device; client: Client }> {
  const w = await world();
  const key = await deviceKey();
  h.svm.airdrop(key.address, lamports(10_000_000_000n));
  const judge = (await generateKeyPairSigner()).address;
  const specHash = new Uint8Array(createHash("sha256").update("a ledger job").digest());
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge, specHash, judgeFee: 0n } as const;
  const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  h.env[ENV_KEYPAIR] = PATH;
  const ledger = device(key, [...found(LEVELS, key), ...transactionThen()]);
  return { key, owner: w.owner, intent, ledger, client: await served(ledger) };
}

async function previewThenSend(d: { ledger: Device; client: Client }, name: string, args: object): Promise<Json> {
  const shown = await call(d.client, name, args);
  expect(shown.error, JSON.stringify(shown.value)).toBe(false);
  expect(d.ledger.signed).toEqual([]);
  expect(shown.value).toMatchObject({ sent: false, message_hash: expect.any(String) });
  const sent = await call(d.client, name, { ...args, approval: shown.value["approval"], send: true });
  expect(sent.error, JSON.stringify(sent.value)).toBe(false);
  d.ledger.store.ensureQueueEmpty();
  expect(d.ledger.signed.map(({ kind }) => kind)).toEqual([SIGN]);
  expect(messageHash(d.ledger.signed[0]?.bytes ?? new Uint8Array())).toBe(shown.value["message_hash"]);
  expect(sent.value).toMatchObject({ sent: true, signature: expect.any(String), message_hash: shown.value["message_hash"], as_previewed: true });
  return sent.value;
}

describe("approval tools on a Ledger wallet", () => {
  it("wallet_profile previews the message hash the device then signs, and publishes", async () => {
    const d = await onDevice();
    await previewThenSend(d, "wallet_profile", { skills: ["rust"], endpoint: "https://" + "agent.example/work" });
    expect(h.svm.getAccount(await profileAddress(d.key.address)).exists).toBe(true);
  });

  it("wallet_claim previews the message hash the device then signs, and takes the claim", async () => {
    const d = await onDevice();
    const opened = await cli(["claims", "open", "--keypair", "owner.json", "--nonce", "0", "--max-secs", "3600", "--stake", "0.05", "--yes"], { "owner.json": d.owner });
    expect([opened.code, opened.err]).toEqual([EXIT_OK, ""]);
    await previewThenSend(d, "wallet_claim", { owner: d.owner.address, nonce: "0", action: "take", secs: 600 });
    expect(h.svm.getAccount(await claimBoardAddress(d.intent)).exists).toBe(true);
    const board = await call(d.client, "get_claims", { owner: d.owner.address, nonce: "0" });
    expect(board.value).toMatchObject({ state: "held", worker: d.key.address });
  });

  it("wallet_feedback previews the message hash the device then signs, and rates the release", async () => {
    const d = await onDevice();
    const payee = (await generateKeyPairSigner()).address;
    const attested = getIntentAttestedEventEncoder().encode({
      intent: d.intent,
      owner: d.key.address,
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
    h.engineLog = [{ signature: testSignature("release"), slot: 3n, blockTime: null, failed: false, emitted: [new Uint8Array([...EVENT_IX_TAG, ...attested])], memos: [] }, creation(d.intent)];
    const sent = await previewThenSend(d, "wallet_feedback", { intent: d.intent, score: 90 });
    expect(sent).toMatchObject({ intent: d.intent, score: 90 });
  });
});
