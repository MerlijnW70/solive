import { createHash } from "node:crypto";
import { type Address, generateKeyPairSigner, getBase16Encoder, getBase58Decoder, getBase64Encoder, getTransactionDecoder, type KeyPairSigner, lamports, none, signBytes } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { committeeEnvelope, DEVNET_TEST_MINT, findAssociatedTokenAddress, getIntentDecoder, IntentStatus, Kind, NATIVE_MINT, sortMembers } from "@intent-engine/core";
import { createClient, envelopeDigest, LEDGER_ERRORS, messageHash } from "@intent-engine/client";
import { SERVER_PROBLEMS } from "../src/agent/problems.js";
import { SALTS_SEALED } from "../src/agent/wallet/record.js";
import { tool } from "../src/agent/names.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { DEVICE_EXPIRED, DEVICE_UNPREVIEWED, NO_FEE_PAYER, ONE_AT_A_TIME } from "../src/agent/wallet/guard.js";
import { FEE_PAYER_KEY_FILE, FEE_PAYER_NEEDS_WALLET } from "../src/arg-values.js";
import { parse } from "../src/args.js";
import { ENV_KEYPAIR } from "../src/clusters.js";
import { EXIT_OK, main } from "../src/main.js";
import { sealedDelivery } from "./announce.js";
import { keyedProfile } from "./encryption-job.js";
import { ata, balance, creation, funded, h, NOW, runtime, setNow, transport, world } from "./harness.js";
import { type Device, device, deviceKey, found, type Key, MESSAGE, messageThen, REJECT, SIGN, transactionThen } from "./ledger-device.js";

type Json = Record<string, unknown>;

const PATH = "usb://ledger?key=2";
const LEVELS = [44, 501, 2];
const WORK = createHash("sha256").update("work").digest("hex");

type Escrow = { key: Key; owner: Address; worker: Address; workerKey: KeyPairSigner; intent: Address; mint: Address; output: Address; authority: KeyPairSigner; payer: KeyPairSigner };

async function escrow(announce = false, attestorOf?: (key: Key) => Promise<Address>): Promise<Escrow> {
  const w = await world();
  const key = await deviceKey();
  h.svm.airdrop(key.address, lamports(10_000_000_000n));
  const profile = await keyedProfile(key);
  const workerKey = await generateKeyPairSigner();
  const worker = workerKey.address;
  const attestor = attestorOf === undefined ? key.address : await attestorOf(key);
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor, specHash: new Uint8Array(32).fill(7), judgeFee: 0n } as const;
  const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  const announced = await sealedDelivery(intent, worker, WORK, "https://" + "example.org/work", [{ wallet: key.address, encryptionKey: profile.encryptionKey }]);
  h.engineLog = [...(announce ? [{ signature: "first", slot: 5n, blockTime: null, failed: false, emitted: [], memos: [announced], feePayer: worker }] : []), creation(intent), profile.entry];
  h.env[ENV_KEYPAIR] = PATH;
  return { key, owner: w.owner.address, worker, workerKey, intent, mint: w.inputMint, output: w.outputMint, authority: w.authority, payer: await funded() };
}

async function served(ledger: Device, payer?: KeyPairSigner): Promise<Client> {
  h.served.length = 0;
  const err: string[] = [];
  const paying = payer === undefined ? [] : ["--fee-payer", "payer.json"];
  const keys: Record<string, KeyPairSigner> = payer === undefined ? {} : { "payer.json": payer };
  const code = await main(["mcp", "--url", "devnet", "--wallet", "--all-tools", ...paying], { ...runtime(keys), ledger: ledger.open }, { out: () => undefined, err: (t) => err.push(t) });
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

const wireSigner = (key: Key | KeyPairSigner) => {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(h.wires.at(-1) ?? ""));
  const signature = tx.signatures[key.address];
  return signature === null || signature === undefined ? null : getBase58Decoder().decode(signature);
};

function preset(at: Address): void {
  if (h.svm.getAccount(at).exists) {
    return;
  }
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

const kinds = (ledger: Device) => ledger.signed.map(({ kind }) => kind);

describe("an MCP wallet on a Ledger", () => {
  it("previews without the device, shows the digest it signs, and the fee payer sends the release the device signed only the message of", async () => {
    const e = await escrow();
    const ledger = device(e.key, [...found(LEVELS, e.key), ...messageThen()]);
    const client = await served(ledger, e.payer);
    const release = { owner: e.owner, nonce: "0", pay_to: e.worker, delivered_sha256: WORK };
    const shown = await call(client, "wallet_attest", release);
    expect(shown.error, JSON.stringify(shown.value)).toBe(false);
    expect([ledger.signed, h.wires.length]).toEqual([[], 0]);
    const sent = await call(client, "wallet_attest", { ...release, approval: shown.value["approval"], send: true });
    expect(sent.error, JSON.stringify(sent.value)).toBe(false);
    ledger.store.ensureQueueEmpty();
    expect(ledger.signed.map(({ kind, path }) => [kind, path])).toEqual([[MESSAGE, LEVELS]]);
    expect(shown.value["digest"]).toBe(envelopeDigest(ledger.signed[0]?.bytes ?? new Uint8Array()));
    expect(sent.value["digest"]).toBe(shown.value["digest"]);
    expect(h.wires).toHaveLength(1);
    expect(sent.value).toMatchObject({ sent: true, signature: wireSigner(e.payer) });
    expect(wireSigner(e.key)).toBeNull();
    expect(statusOf(e.intent)).toBe(IntentStatus.Filled);
    expect(balance(await findAssociatedTokenAddress({ owner: e.worker, mint: e.mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))).toBeGreaterThan(0n);
  });

  it("refuses a release without a fee payer, naming the option, and the option takes a key file with --wallet", async () => {
    const e = await escrow();
    const ledger = device(e.key, found(LEVELS, e.key));
    const client = await served(ledger);
    const refused = await call(client, "wallet_attest", { owner: e.owner, nonce: "0", pay_to: e.worker, delivered_sha256: WORK });
    expect(refused).toMatchObject({ error: true, value: { code: "NoFeePayer", hint: NO_FEE_PAYER } });
    expect([ledger.signed, h.wires.length]).toEqual([[], 0]);
    expect(() => parse(["mcp", "--url", "devnet", "--fee-payer", "payer.json"])).toThrow(FEE_PAYER_NEEDS_WALLET);
    expect(() => parse(["mcp", "--url", "devnet", "--wallet", "--fee-payer", PATH])).toThrow(FEE_PAYER_KEY_FILE);
    expect(parse(["mcp", "--url", "devnet", "--wallet", "--fee-payer", "payer.json"])).toMatchObject({ feePayer: "payer.json" });
  });

  it("refuses to release announced work, whose sealed salts only a key file opens, without asking the device", async () => {
    const e = await escrow(true);
    const ledger = device(e.key, found(LEVELS, e.key));
    const client = await served(ledger, e.payer);
    const refused = await call(client, "wallet_attest", { owner: e.owner, nonce: "0", pay_to: e.worker, delivered_sha256: WORK });
    expect(refused).toMatchObject({ error: true, value: { code: "SealedSalts" } });
    expect(String(refused.value["hint"])).toContain("mcp --encryption-keypair");
    expect(SALTS_SEALED).toContain("mcp --encryption-keypair");
    expect([ledger.signed, h.wires.length]).toEqual([[], 0]);
    expect(statusOf(e.intent)).toBe(IntentStatus.Open);
  });

  it("a refusal on the device comes back as a problem with nothing sent", async () => {
    for (const [queue, hint] of [[[MESSAGE, REJECT]], [[MESSAGE, "6982"]]].map((tail, i): [[string, string][], string] => [
      tail as [string, string][],
      i === 1 ? LEDGER_ERRORS.locked : LEDGER_ERRORS.rejected,
    ])) {
      const e = await escrow();
      const ledger = device(e.key, [...found(LEVELS, e.key), ...queue]);
      const client = await served(ledger, e.payer);
      const release = { owner: e.owner, nonce: "0", pay_to: e.worker, delivered_sha256: WORK };
      const shown = await call(client, "wallet_attest", release);
      const refused = await call(client, "wallet_attest", { ...release, approval: shown.value["approval"], send: true });
      expect(refused).toEqual({ error: true, value: { code: "Ledger", retryable: SERVER_PROBLEMS.Ledger.retryable, hint } });
      ledger.store.ensureQueueEmpty();
      expect(h.wires).toEqual([]);
      expect(statusOf(e.intent)).toBe(IntentStatus.Open);
    }
  });

  it("a split release on the Ledger wallet signs the envelope that lists its own key and settles", async () => {
    const e = await escrow();
    const ledger = device(e.key, [...found(LEVELS, e.key), ...messageThen()]);
    const client = await served(ledger, e.payer);
    const split = { owner: e.owner, nonce: "0", recipients: [{ wallet: e.worker, weight: 10_000 }], delivered_sha256: WORK };
    const shown = await call(client, "wallet_attest_split", split);
    expect(shown.error, JSON.stringify(shown.value)).toBe(false);
    expect(ledger.signed).toEqual([]);
    const envelope = Uint8Array.from(getBase16Encoder().encode(String(shown.value["envelope"])));
    expect(shown.value["digest"]).toBe(envelopeDigest(envelope));
    const signature = Buffer.from(await signBytes(e.workerKey.keyPair.privateKey, envelope)).toString("hex");
    const recipients = [{ wallet: e.worker, weight: 10_000, signature }];
    const unpreviewed = await call(client, "wallet_attest_split", { ...split, recipients, send: true });
    expect(unpreviewed).toMatchObject({ error: true, value: { code: "ReleaseChanged" } });
    expect([ledger.signed, h.wires.length]).toEqual([[], 0]);
    const sent = await call(client, "wallet_attest_split", { ...split, recipients, approval: shown.value["approval"], send: true });
    expect(sent.error, JSON.stringify(sent.value)).toBe(false);
    ledger.store.ensureQueueEmpty();
    expect(kinds(ledger)).toEqual([MESSAGE]);
    expect(Buffer.from(ledger.signed[0]?.bytes ?? []).toString("hex")).toBe(Buffer.from(envelope).toString("hex"));
    expect(sent.value).toMatchObject({ sent: true, recorded: false, signature: wireSigner(e.payer) });
    expect(wireSigner(e.key)).toBeNull();
    expect(statusOf(e.intent)).toBe(IntentStatus.Filled);
  });

  it("a send signs the transaction its preview kept for the same arguments, even after chain time moved, and nothing without one", async () => {
    const e = await escrow();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    const ledger = device(e.key, [...found(LEVELS, e.key), ...transactionThen(), ...transactionThen()]);
    const client = await served(ledger);
    const escrowing = { sell: "SOL", amount: "0.05", attestor: e.owner };
    const unpreviewed = await call(client, "wallet_escrow", { ...escrowing, send: true });
    expect(unpreviewed).toMatchObject({ error: true, value: { code: "DeviceUnpreviewed", hint: DEVICE_UNPREVIEWED } });
    expect(ledger.signed).toEqual([]);
    for (const [name, args] of [
      ["wallet_escrow", escrowing],
      ["wallet_swap", { sell: "SOL", buy: "TEST", amount: "0.05", min_receive: "5", start_receive: "6" }],
    ] as const) {
      const shown = await call(client, name, args);
      expect(shown.error, JSON.stringify(shown.value)).toBe(false);
      setNow(NOW + 600n);
      const sent = await call(client, name, { ...args, send: true });
      expect(sent.error, JSON.stringify(sent.value)).toBe(false);
      expect(messageHash(ledger.signed.at(-1)?.bytes ?? new Uint8Array())).toBe(shown.value["message_hash"]);
      expect(sent.value).toMatchObject({ sent: true, intent: shown.value["intent"], message_hash: shown.value["message_hash"] });
      const again = await call(client, name, { ...args, send: true });
      expect(again).toMatchObject({ error: true, value: { code: "DeviceUnpreviewed" } });
      setNow(NOW);
    }
    ledger.store.ensureQueueEmpty();
    expect(kinds(ledger)).toEqual([SIGN, SIGN]);
  });

  it("a kept preview whose blockhash expired is refused before the device is asked", async () => {
    const e = await escrow();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    let height = 0n;
    h.through = { ...transport, latestBlockhash: async () => ({ ...(await transport.latestBlockhash()), lastValidBlockHeight: height }) };
    const ledger = device(e.key, found(LEVELS, e.key));
    const client = await served(ledger);
    const escrowing = { sell: "SOL", amount: "0.05", attestor: e.owner };
    expect((await call(client, "wallet_escrow", escrowing)).error).toBe(false);
    height = 1_000_000n;
    const late = await call(client, "wallet_escrow", { ...escrowing, send: true });
    expect(late).toMatchObject({ error: true, value: { code: "DeviceUnpreviewed", hint: DEVICE_EXPIRED } });
    ledger.store.ensureQueueEmpty();
    expect([ledger.signed, h.wires.length]).toEqual([[], 0]);
  });

  it("a transaction preview shows the message hash the device then signs, and a tool that sends several is refused", async () => {
    const e = await escrow();
    await ata(e.authority, e.key.address, e.mint, 1_000n);
    const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({
      signer: e.key.signer,
      params: { kind: Kind.SwapExactIn, amountIn: 400n, minOut: 1n },
      inputMint: e.mint,
      outputMint: e.output,
      nonce: 0n,
      expiresAt: NOW + 3_600n,
    });
    const ledger = device(e.key, [...found(LEVELS, e.key), ...transactionThen()]);
    const client = await served(ledger);
    const shown = await call(client, "wallet_cancel", { nonce: "0" });
    expect(shown.error, JSON.stringify(shown.value)).toBe(false);
    expect([ledger.signed, shown.value["message_hash"]]).toEqual([[], expect.any(String)]);
    const sent = await call(client, "wallet_cancel", { nonce: "0", send: true });
    expect(sent.error, JSON.stringify(sent.value)).toBe(false);
    ledger.store.ensureQueueEmpty();
    expect(kinds(ledger)).toEqual([SIGN]);
    expect(messageHash(ledger.signed[0]?.bytes ?? new Uint8Array())).toBe(shown.value["message_hash"]);
    expect(sent.value).toMatchObject({ sent: true, message_hash: shown.value["message_hash"], as_previewed: true, refund: shown.value["refund"] });
    expect(statusOf(intent)).not.toBe(IntentStatus.Open);
    const plan = await call(client, "wallet_escrow_plan", { sell: "SOL", attestor: e.owner, pieces: [{ name: "a", amount: "0.01" }, { name: "b", amount: "0.01" }] });
    expect(plan).toMatchObject({ error: true, value: { code: "DeviceUnpreviewed", hint: ONE_AT_A_TIME } });
  });

  it("a committee member on the Ledger wallet signs only the vote's message, whose digest the preview shows", async () => {
    let members: Address[] = [];
    const e = await escrow(false, async (key) => {
      members = sortMembers([key.address, (await generateKeyPairSigner()).address]);
      const made = await createClient({ url: "http://cluster", transport }).createCommittee({ members, threshold: 1, feeWallet: key.address, payer: await funded() });
      return made.committee;
    });
    const ledger = device(e.key, [...found(LEVELS, e.key), ...messageThen()]);
    const client = await served(ledger);
    const ballot = { owner: e.owner, nonce: "0", pay_to: e.worker, result: "1", delivered_sha256: WORK };
    const shown = await call(client, "wallet_committee_vote", ballot);
    expect(shown.error, JSON.stringify(shown.value)).toBe(false);
    expect(ledger.signed).toEqual([]);
    const voted = await call(client, "wallet_committee_vote", { ...ballot, approval: shown.value["approval"], send: true });
    expect(voted.error, JSON.stringify(voted.value)).toBe(false);
    ledger.store.ensureQueueEmpty();
    expect(kinds(ledger)).toEqual([MESSAGE]);
    const signed = ledger.signed[0]?.bytes ?? new Uint8Array();
    expect(envelopeDigest(signed)).toBe(shown.value["digest"]);
    expect(Buffer.from(signed).toString("hex")).toBe(Buffer.from(committeeEnvelope(Buffer.from(String(shown.value["digest"]), "hex"), members)).toString("hex"));
    expect(h.wires).toEqual([]);
  });
});
