import { type Address, generateKeyPairSigner, getBase16Encoder, type KeyPairSigner, lamports, none, signBytes } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, INTENT_ENGINE_PROGRAM_ADDRESS, Kind, NATIVE_MINT, sortMembers } from "@intent-engine/core";
import { createClient, type OpenTransport } from "@intent-engine/client";
import { tool } from "../src/agent/names.js";
import { PACKET_DATA_SIZE, WALLET_NOTICE } from "../src/agent/wallet.js";
import { DEVICE_UNPREVIEWED } from "../src/agent/wallet/guard.js";
import { splitTooLarge } from "../src/agent/wallet/split.js";
import { ENV_KEYPAIR } from "../src/clusters.js";
import { EXIT_OK, main } from "../src/main.js";
import { keyedProfile } from "./encryption-job.js";
import { creation, funded, h, NOW, runtime, transport, world } from "./harness.js";
import { device, deviceKey, found, type Key, messageThen, SIGN, TransportError, transactionThen } from "./ledger-device.js";
import { paddedTransport, walletServer } from "./pad-budget.js";

type Json = Record<string, unknown>;

const PATH = "usb://ledger?key=6";
const LEVELS = [44, 501, 6];
const WORK = "6c".repeat(32);

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

type Escrow = { key: Key; owner: Address; worker: Address; workerKey: KeyPairSigner; intent: Address; payer: KeyPairSigner };

async function escrow(attestorOf?: (key: Key) => Promise<Address>): Promise<Escrow> {
  const w = await world();
  preset(NATIVE_MINT);
  preset(DEVNET_TEST_MINT);
  const key = await deviceKey();
  h.svm.airdrop(key.address, lamports(10_000_000_000n));
  const profile = await keyedProfile(key);
  const workerKey = await generateKeyPairSigner();
  const worker = workerKey.address;
  const attestor = attestorOf === undefined ? key.address : await attestorOf(key);
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor, specHash: new Uint8Array(32).fill(9), judgeFee: 0n } as const;
  const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  h.engineLog = [creation(intent), profile.entry];
  h.env[ENV_KEYPAIR] = PATH;
  return { key, owner: w.owner.address, worker, workerKey, intent, payer: await funded() };
}

async function served(open: OpenTransport, payer?: KeyPairSigner): Promise<Client> {
  h.served.length = 0;
  const err: string[] = [];
  const paying = payer === undefined ? [] : ["--fee-payer", "payer.json"];
  const keys: Record<string, KeyPairSigner> = payer === undefined ? {} : { "payer.json": payer };
  const code = await main(["mcp", "--url", "devnet", "--wallet", "--all-tools", ...paying], { ...runtime(keys), ledger: open }, { out: () => undefined, err: (t) => err.push(t) });
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

describe("a Ledger wallet's kept previews and device", () => {
  it("opens the device again after an open that failed", async () => {
    const e = await escrow();
    const ledger = device(e.key, found(LEVELS, e.key));
    let tries = 0;
    const flaky: OpenTransport = async () => {
      tries += 1;
      if (tries === 1) {
        throw new TransportError("no device", "NoDeviceFound");
      }
      return ledger.open();
    };
    const client = await served(flaky);
    expect((await call(client, "wallet_balance")).error).toBe(true);
    const balance = await call(client, "wallet_balance");
    expect(balance.error, JSON.stringify(balance.value)).toBe(false);
    expect(balance.value).toMatchObject({ address: e.key.address });
    expect(tries).toBe(2);
  });

  it("keeps the sixteen latest previews, so the oldest of seventeen is gone and the second still sends", async () => {
    const e = await escrow();
    const ledger = device(e.key, [...found(LEVELS, e.key), ...transactionThen()]);
    const client = await served(ledger.open);
    const escrowing = (at: number) => ({ sell: "SOL", amount: `0.0${String(at).padStart(2, "0")}`, attestor: e.owner });
    for (let at = 1; at <= 17; at++) {
      const shown = await call(client, "wallet_escrow", escrowing(at));
      expect(shown.error, JSON.stringify(shown.value)).toBe(false);
    }
    expect(await call(client, "wallet_escrow", { ...escrowing(1), send: true })).toMatchObject({ error: true, value: { code: "DeviceUnpreviewed", hint: DEVICE_UNPREVIEWED } });
    const sent = await call(client, "wallet_escrow", { ...escrowing(2), send: true });
    expect(sent.error, JSON.stringify(sent.value)).toBe(false);
    expect(sent.value).toMatchObject({ sent: true, as_previewed: true });
    ledger.store.ensureQueueEmpty();
    expect(ledger.signed.map(({ kind }) => kind)).toEqual([SIGN]);
  });

  it("sends a kept preview whose blockhash is exactly at the end of its window", async () => {
    const e = await escrow();
    let height = 0n;
    h.through = { ...transport, latestBlockhash: async () => ({ ...(await transport.latestBlockhash()), lastValidBlockHeight: height }) };
    const ledger = device(e.key, [...found(LEVELS, e.key), ...transactionThen()]);
    const client = await served(ledger.open);
    const escrowing = { sell: "SOL", amount: "0.05", attestor: e.owner };
    expect((await call(client, "wallet_escrow", escrowing)).error).toBe(false);
    height = 150n;
    const sent = await call(client, "wallet_escrow", { ...escrowing, send: true });
    expect(sent.error, JSON.stringify(sent.value)).toBe(false);
    expect(sent.value).toMatchObject({ sent: true });
    ledger.store.ensureQueueEmpty();
  });

  it("previews a proof release that records nothing, with no memo line", async () => {
    const e = await escrow();
    const ledger = device(e.key, found(LEVELS, e.key));
    const client = await served(ledger.open, e.payer);
    const shown = await call(client, "wallet_attest", { owner: e.owner, nonce: "0", pay_to: e.worker, delivered_sha256: WORK, received_outside_announcement: true });
    expect(shown.error, JSON.stringify(shown.value)).toBe(false);
    expect(shown.value["recorded"]).toBe(false);
    expect(shown.value).not.toHaveProperty("delivered_sha256");
    expect((shown.value["summary"] as string[]).filter((line) => line.startsWith("Records:"))).toEqual([]);
  });

  it("previews a committee release without a fee payer when there is nothing to open", async () => {
    const e = await escrow(async (key) => {
      const members = sortMembers([key.address, (await generateKeyPairSigner()).address]);
      return (await createClient({ url: "http://cluster", transport }).createCommittee({ members, threshold: 1, feeWallet: key.address, payer: await funded() })).committee;
    });
    const ledger = device(e.key, [...found(LEVELS, e.key), ...messageThen()]);
    const client = await served(ledger.open);
    const ballot = { owner: e.owner, nonce: "0", pay_to: e.worker, result: "1", delivered_sha256: WORK, received_outside_announcement: true };
    const shown = await call(client, "wallet_committee_vote", ballot);
    const voted = await call(client, "wallet_committee_vote", { ...ballot, approval: shown.value["approval"], send: true });
    expect(voted.error, JSON.stringify(voted.value)).toBe(false);
    const release = await call(client, "wallet_committee_release", { ...ballot, votes: [voted.value["vote"]] });
    expect(release.error, JSON.stringify(release.value)).toBe(false);
    expect(release.value).toMatchObject({ intent: e.intent, sent: false });
  });
});

describe("a Ledger wallet's split release size", () => {
  const engineIn = (instructions: readonly { programAddress: Address }[]) => instructions.some((ix) => ix.programAddress === INTENT_ENGINE_PROGRAM_ADDRESS);

  async function cosigned(e: Escrow, client: Client) {
    const split = { owner: e.owner, nonce: "0", recipients: [{ wallet: e.worker, weight: 10_000 }], delivered_sha256: WORK, received_outside_announcement: true };
    const shown = await call(client, "wallet_attest_split", split);
    expect(shown.error, JSON.stringify(shown.value)).toBe(false);
    const envelope = Uint8Array.from(getBase16Encoder().encode(String(shown.value["envelope"])));
    const signature = Buffer.from(await signBytes(e.workerKey.keyPair.privateKey, envelope)).toString("hex");
    return { ...split, recipients: [{ wallet: e.worker, weight: 10_000, signature }], approval: shown.value["approval"], send: true };
  }

  it("sends a release that fills the packet to its last byte", async () => {
    const e = await escrow();
    const ledger = device(e.key, [...found(LEVELS, e.key), ...messageThen()]);
    const client = await walletServer(paddedTransport({ size: PACKET_DATA_SIZE }, engineIn), ledger.open, e.payer);
    h.wires.length = 0;
    const sent = await call(client, "wallet_attest_split", await cosigned(e, client));
    expect(sent.error, JSON.stringify(sent.value)).toBe(false);
    expect(sent.value).toMatchObject({ sent: true, recorded: false });
    expect(h.wires).toHaveLength(1);
    expect(Buffer.from(h.wires[0] as string, "base64")).toHaveLength(PACKET_DATA_SIZE);
  });

  it("refuses a release over the packet, naming the lookup table it was sent without", async () => {
    const e = await escrow();
    const ledger = device(e.key, [...found(LEVELS, e.key), ...messageThen()]);
    const client = await walletServer(paddedTransport({ size: 1_300 }, engineIn), ledger.open, e.payer);
    const refused = await call(client, "wallet_attest_split", await cosigned(e, client));
    expect(refused).toMatchObject({ error: true, value: { code: "ReleaseTooLarge", hint: splitTooLarge(1_300, 1, false) } });
    expect(h.wires).toEqual([]);
  });
});
