import { createHash } from "node:crypto";
import { type Address, generateKeyPairSigner, getBase58Decoder, getBase64Encoder, getTransactionDecoder, lamports } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { findAssociatedTokenAddress, getIntentDecoder, IntentStatus, Kind } from "@intent-engine/core";
import { createClient, LEDGER_ERRORS } from "@intent-engine/client";
import { SERVER_PROBLEMS } from "../src/agent/problems.js";
import { tool } from "../src/agent/names.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { ENV_KEYPAIR } from "../src/clusters.js";
import { needsKeyFile } from "../src/ledger-keys.js";
import { EXIT_OK, main } from "../src/main.js";
import { sealedDelivery } from "./announce.js";
import { balance, creation, h, NOW, runtime, transport, world } from "./harness.js";
import { BLIND_ON, CONFIG, type Device, device, deviceKey, found, type Key, MESSAGE, messageThen, OK, REJECT, SIGN, transactionThen } from "./ledger-device.js";

type Json = Record<string, unknown>;

const PATH = "usb://ledger?key=2";
const LEVELS = [44, 501, 2];
const WORK = createHash("sha256").update("work").digest("hex");

type Escrow = { key: Key; owner: Address; worker: Address; intent: Address; mint: Address };

async function escrow(): Promise<Escrow> {
  const w = await world();
  const key = await deviceKey();
  h.svm.airdrop(key.address, lamports(10_000_000_000n));
  const worker = (await generateKeyPairSigner()).address;
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: key.address, specHash: new Uint8Array(32).fill(7), judgeFee: 0n } as const;
  const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  const announced = await sealedDelivery(intent, worker, WORK, "https://" + "example.org/work", [key.address]);
  h.engineLog = [{ signature: "first", slot: 5n, blockTime: null, failed: false, emitted: [], memos: [announced], feePayer: worker }, creation(intent)];
  h.env[ENV_KEYPAIR] = PATH;
  return { key, owner: w.owner.address, worker, intent, mint: w.inputMint };
}

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

const statusOf = (intent: Address) => {
  const view = h.svm.getAccount(intent);
  return view.exists ? getIntentDecoder().decode(view.data).status : undefined;
};

const wireSigner = (key: Key) => {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(h.wires.at(-1) ?? ""));
  const signature = tx.signatures[key.address];
  return signature === null || signature === undefined ? null : getBase58Decoder().decode(signature);
};

describe("an MCP wallet on a Ledger", () => {
  it("previews without the device and sends a release only after the mock device signs its message and transaction", async () => {
    const e = await escrow();
    const ledger = device(e.key, [...found(LEVELS, e.key), ...messageThen(), ...transactionThen()]);
    const client = await served(ledger);
    const release = { owner: e.owner, nonce: "0", pay_to: e.worker, delivered_sha256: WORK };
    const shown = await call(client, "wallet_attest", release);
    expect(shown.error, JSON.stringify(shown.value)).toBe(false);
    expect([ledger.signed, h.wires.length]).toEqual([[], 0]);
    const sent = await call(client, "wallet_attest", { ...release, approval: shown.value["approval"], send: true });
    expect(sent.error, JSON.stringify(sent.value)).toBe(false);
    ledger.store.ensureQueueEmpty();
    expect(ledger.signed.map(({ kind, path }) => [kind, path])).toEqual([
      [MESSAGE, LEVELS],
      [SIGN, LEVELS],
    ]);
    expect(h.wires).toHaveLength(1);
    expect(sent.value).toMatchObject({ sent: true, signature: ledger.signatures[1] });
    expect(wireSigner(e.key)).toBe(ledger.signatures[1]);
    expect(statusOf(e.intent)).toBe(IntentStatus.Filled);
    expect(balance(await findAssociatedTokenAddress({ owner: e.worker, mint: e.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))).toBeGreaterThan(0n);
  });

  it("a refusal on the device comes back as a problem with nothing sent", async () => {
    for (const [queue, hint] of [
      [[MESSAGE, REJECT]],
      [[MESSAGE, "6982"]],
      [
        [MESSAGE, OK],
        [CONFIG, BLIND_ON],
        [SIGN, REJECT],
      ],
    ].map((tail, i): [[string, string][], string] => [tail as [string, string][], i === 1 ? LEDGER_ERRORS.locked : LEDGER_ERRORS.rejected])) {
      const e = await escrow();
      const ledger = device(e.key, [...found(LEVELS, e.key), ...queue]);
      const client = await served(ledger);
      const release = { owner: e.owner, nonce: "0", pay_to: e.worker, delivered_sha256: WORK };
      const shown = await call(client, "wallet_attest", release);
      const refused = await call(client, "wallet_attest", { ...release, approval: shown.value["approval"], send: true });
      expect(refused).toEqual({ error: true, value: { code: "Ledger", retryable: SERVER_PROBLEMS.Ledger.retryable, hint } });
      ledger.store.ensureQueueEmpty();
      expect(h.wires).toEqual([]);
      expect(statusOf(e.intent)).toBe(IntentStatus.Open);
    }
  });

  it("committee votes and split releases refuse the Ledger wallet before it is asked to sign", async () => {
    const e = await escrow();
    const ledger = device(e.key, found(LEVELS, e.key));
    const client = await served(ledger);
    const vote = await call(client, "wallet_committee_vote", { owner: e.owner, nonce: "0", pay_to: e.worker, result: "1", delivered_sha256: WORK });
    expect(vote).toEqual({ error: true, value: { code: "LedgerNeedsKeyFile", retryable: false, hint: needsKeyFile(tool("wallet_committee_vote"), PATH) } });
    const split = await call(client, "wallet_attest_split", { owner: e.owner, nonce: "0", recipients: [{ wallet: e.worker, weight: 10_000 }], delivered_sha256: WORK });
    expect(split).toEqual({ error: true, value: { code: "LedgerNeedsKeyFile", retryable: false, hint: needsKeyFile(tool("wallet_attest_split"), PATH) } });
    ledger.store.ensureQueueEmpty();
    expect([ledger.signed, h.wires]).toEqual([[], []]);
  });
});
