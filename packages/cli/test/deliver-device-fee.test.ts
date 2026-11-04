import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, type KeyPairSigner, lamports, none, signBytes, type TransactionSigner } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEVNET_TEST_MINT, Kind, NATIVE_MINT } from "@intent-engine/core";
import { checkAccountVersion, findConfigPda, getCommitteeDecoder, getConfigDecoder, getConfigEncoder, saltMessage, sortMembers } from "@intent-engine/core/internal";
import { createClient, messageHash } from "@intent-engine/client/node";
import { tool } from "../src/agent/names.js";
import { SEALED_UNCHECKED } from "../src/agent/wallet/seal.js";
import { notAttestor, SYNC_FIRST, SYNC_FIRST_FIELD, SYNC_ONLY, SYNCED_NEXT, walletDeliver } from "../src/agent/wallet/delivery.js";
import { encryptionKeyUnread } from "../src/agent/wallet/guard.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { ENV_KEYPAIR } from "../src/clusters.js";
import { EXIT_OK, main } from "../src/main.js";
import { keyed } from "./announce.js";
import { cli, funded, h, HOME, NOW, runtime, transport, world } from "./harness.js";
import { type Device, device, deviceKey, found, type Key, SIGN, transactionThen } from "./ledger-device.js";
import { airdropped } from "./airdrop.js";

type Json = Record<string, unknown>;

const salted = vi.hoisted(() => new Map<string, Uint8Array>());

vi.mock("@intent-engine/client/internal", async (importOriginal) => {
  const real = await importOriginal<typeof import("@intent-engine/client/internal")>();
  return {
    ...real,
    secretInputOf: (worker: TransactionSigner, given: Parameters<typeof real.secretInputOf>[1]) => {
      const saltSignature = salted.get(worker.address);
      return saltSignature === undefined ? real.secretInputOf(worker, given) : { worker, saltSignature };
    },
  };
});

const PATH = "usb://ledger?key=4";
const LEVELS = [44, 501, 4];
const WORK = createHash("sha256").update("the delivered work\n").digest("hex");
const WORK_URL = "https://" + "work.example.org/" + "d".repeat(32);
const ANNOUNCE_FEE = 2_000_000n;
const SPEC_URL = "https://" + "files.example.com/jobs/" + "e".repeat(32) + ".sealed";

async function served(options: { ledger?: Device; extra?: string[] } = {}): Promise<Client> {
  h.served.length = 0;
  const err: string[] = [];
  const base = options.ledger === undefined ? runtime({}) : { ...runtime({}), ledger: options.ledger.open };
  const code = await main(["mcp", "--url", "devnet", "--wallet", "--all-tools", ...(options.extra ?? [])], base, { out: () => undefined, err: (t) => err.push(t) });
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

async function ok(client: Client, name: string, args: object = {}): Promise<Json> {
  const { error, value } = await call(client, name, args);
  expect(error, JSON.stringify(value)).toBe(false);
  return value;
}

async function committeeOf(): Promise<Address> {
  const members = sortMembers([(await keyed()).address, (await keyed()).address]);
  const payer = await funded();
  const created = await cli(["committee", "create", "--url", "devnet", "--keypair", "payer.json", "--members", members.join(","), "--threshold", "2", "--fee-wallet", payer.address, "--yes"], { "payer.json": payer });
  expect([created.code, created.err]).toEqual([EXIT_OK, ""]);
  return created.json()["committee"] as Address;
}

function synced(committee: Address): boolean {
  const held = h.svm.getAccount(committee);
  return held.exists && getCommitteeDecoder().decode(checkAccountVersion(Uint8Array.from(held.data))).keysSynced === 1;
}

async function escrowTo(owner: KeyPairSigner, attestor: Address, inputMint: Address, outputMint: Address, nonce = 0n): Promise<Address> {
  const specHash = new Uint8Array(createHash("sha256").update("a committee job").digest());
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor, specHash, judgeFee: 0n } as const;
  const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: owner, params, inputMint, outputMint, nonce, expiresAt: NOW + 3_600n });
  return intent;
}

async function feeOf(fee: bigint): Promise<Address> {
  const [config] = await findConfigPda();
  const view = h.svm.getAccount(config);
  if (!view.exists) {
    throw new Error("no config");
  }
  const decoded = getConfigDecoder().decode(view.data);
  h.svm.setAccount({ ...view, data: Uint8Array.from(getConfigEncoder().encode({ ...decoded, announceFee: Number(fee) })) });
  return decoded.feeRecipient;
}

const lamportsOf = (address: Address): bigint => {
  const held = h.svm.getAccount(address);
  return held.exists ? BigInt(held.lamports) : 0n;
};

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

function useWallet(signer: KeyPairSigner): void {
  h.files.set("wallet.json", JSON.stringify(Array.from(h.keypairs.get(signer.address) ?? [])));
  h.env[ENV_KEYPAIR] = "wallet.json";
}

const mcpPays = (fee: string, recipient: Address, from: string): string =>
  `Pays: the announcement's rent and the transaction fee, plus the announce fee of ${fee} SOL to the fee recipient ${recipient}, from ${from}; the rent returns when the announcement closes and the announce fee does not, and the escrow's tokens do not move`;

const transactionsSigned = (ledger: Device): Uint8Array[] => ledger.signed.filter(({ kind }) => kind === SIGN).map(({ bytes }) => bytes);

describe("delivering from a Ledger wallet to an unsynced committee", () => {
  it("signs one previewed transaction per call: the key sync, then the announcement with its own preview", async () => {
    const w = await world();
    const key: Key = await deviceKey();
    airdropped(h.svm, key.address, lamports(10_000_000_000n));
    const committee = await committeeOf();
    const intent = await escrowTo(w.owner, committee, w.inputMint, w.outputMint);
    expect(synced(committee)).toBe(false);
    salted.set(key.address, new Uint8Array(await signBytes(key.signer.keyPair.privateKey, saltMessage(intent, WORK))));
    h.env[ENV_KEYPAIR] = PATH;
    const ledger = device(key, [...found(LEVELS, key), ...transactionThen(), ...transactionThen()]);
    const client = await served({ ledger });
    const args = { intent, sha256: WORK, url: WORK_URL };

    const syncShown = await ok(client, "wallet_deliver", args);
    expect(syncShown).toMatchObject({ sent: false, sync_first: true, message_hash: expect.any(String) });
    expect(String(syncShown["next"])).toContain(SYNC_ONLY);
    expect(transactionsSigned(ledger)).toEqual([]);

    const syncSent = await ok(client, "wallet_deliver", { ...args, send: true });
    expect(transactionsSigned(ledger)).toHaveLength(1);
    expect(messageHash(transactionsSigned(ledger)[0] ?? new Uint8Array())).toBe(syncShown["message_hash"]);
    expect(syncSent).toMatchObject({ sent: true, sync_first: true, as_previewed: true, message_hash: syncShown["message_hash"], next: SYNCED_NEXT });
    expect(syncSent).not.toHaveProperty("seq");
    expect(synced(committee)).toBe(true);
    expect(h.svm.getAccount(syncShown["announcement"] as Address).exists).toBe(false);

    const announceShown = await ok(client, "wallet_deliver", args);
    expect(announceShown).toMatchObject({ sent: false, sync_first: false, message_hash: expect.any(String) });
    expect(announceShown["message_hash"]).not.toBe(syncShown["message_hash"]);
    expect(transactionsSigned(ledger)).toHaveLength(1);

    const announced = await ok(client, "wallet_deliver", { ...args, send: true });
    ledger.store.ensureQueueEmpty();
    expect(transactionsSigned(ledger)).toHaveLength(2);
    expect(messageHash(transactionsSigned(ledger)[1] ?? new Uint8Array())).toBe(announceShown["message_hash"]);
    expect(announced).toMatchObject({ sent: true, seq: "1", as_previewed: true, message_hash: announceShown["message_hash"] });
    expect(h.svm.getAccount(announced["announcement"] as Address).exists).toBe(true);
    salted.clear();
  }, 60_000);
});

describe("delivering from a key file to an unsynced committee", () => {
  it("previews the sync with sync_first, and one send syncs and announces, returning the announcement's signature", async () => {
    const w = await world();
    const worker = await funded();
    const committee = await committeeOf();
    const intent = await escrowTo(w.owner, committee, w.inputMint, w.outputMint);
    useWallet(worker);
    const client = await served();
    const args = { intent, sha256: WORK, url: WORK_URL };
    const shown = await ok(client, "wallet_deliver", args);
    expect(shown).toMatchObject({ sent: false, sync_first: true });
    expect(String(shown["next"])).toContain(SYNC_FIRST);
    const sent = await ok(client, "wallet_deliver", { ...args, send: true });
    expect(sent).toMatchObject({ sent: true, seq: "1", sync_first: true, signature: expect.any(String) });
    expect(synced(committee)).toBe(true);
    expect(h.svm.getAccount(sent["announcement"] as Address).exists).toBe(true);
    const field = (walletDeliver.output.json as { properties: Record<string, { description?: string }> }).properties["sync_first"];
    expect(field?.description).toBe(SYNC_FIRST_FIELD);
    expect(SYNC_FIRST_FIELD).toContain("with a key file one send sends both and signature is the announcement's");
    expect(SYNC_FIRST_FIELD).toContain("on a Ledger a send sends only the sync, signature is the sync's");
  }, 60_000);
});

describe("the announce fee in deliver previews", () => {
  let w: Awaited<ReturnType<typeof world>>;
  let worker: KeyPairSigner;
  let intent: Address;

  beforeEach(async () => {
    w = await world();
    worker = await funded();
    intent = await escrowTo(w.owner, (await funded()).address, w.inputMint, w.outputMint);
  });

  it("names a nonzero fee in the MCP and CLI previews, and the send moves it to the fee recipient", async () => {
    const recipient = await feeOf(ANNOUNCE_FEE);
    useWallet(worker);
    const client = await served();
    const shown = await ok(client, "wallet_deliver", { intent, sha256: WORK, url: WORK_URL });
    expect(shown["summary"]).toContain(mcpPays("0.002", recipient, "this wallet"));
    expect((shown["summary"] as string[]).filter((line) => line.startsWith("Pays:"))).toHaveLength(1);
    expect((shown["summary"] as string[]).join("\n")).not.toContain("no tokens move");
    const saltSignature = Buffer.from(await signBytes(worker.keyPair.privateKey, saltMessage(intent, WORK))).toString("hex");
    const prepared = await ok(client, "prepare_deliver", { worker: worker.address, intent, sha256: WORK, url: WORK_URL, salt_signature: saltSignature });
    expect(prepared["summary"]).toContain(mcpPays("0.002", recipient, worker.address));
    const described = new Map((await client.listTools()).tools.map((one) => [one.name, one.description ?? ""]));
    for (const [name, payer] of [[tool("wallet_deliver"), "This wallet"], [tool("prepare_deliver"), "The worker"]] as const) {
      const text = described.get(name) ?? "";
      expect([name, /no tokens move|moves no tokens/.test(text), text.includes(`${payer} pays rent, fee and any announce fee; the escrow's tokens do not move.`)]).toEqual([name, false, true]);
    }
    const pays = (shown["summary"] as string[]).find((line) => line.startsWith("Pays:")) ?? "";
    expect([pays.includes("announce fee of 0.002 SOL"), pays.endsWith("the escrow's tokens do not move")]).toEqual([true, true]);

    const preview = await cli(["deliver", "--url", "devnet", "--keypair", "worker.json", "--intent", intent, "--sha256", WORK, "--work-url", WORK_URL], { "worker.json": worker });
    expect([preview.code, preview.err]).toEqual([EXIT_OK, ""]);
    expect(preview.json()["summary"]).toContain(
      `Pays: the announcement's rent and the fee, plus the announce fee of 0.002 SOL to the fee recipient ${recipient}, from ${worker.address}; the rent returns to it when the announcement closes and the announce fee does not`,
    );
    expect((preview.json()["summary"] as string[]).filter((line: string) => line.startsWith("Pays:"))).toHaveLength(1);

    const before = lamportsOf(recipient);
    const sent = await cli(["deliver", "--url", "devnet", "--keypair", "worker.json", "--intent", intent, "--sha256", WORK, "--work-url", WORK_URL, "--yes"], { "worker.json": worker });
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
    expect(lamportsOf(recipient) - before).toBe(ANNOUNCE_FEE);
  }, 60_000);

  it("names no announce fee while the fee is zero", async () => {
    useWallet(worker);
    const shown = await ok(await served(), "wallet_deliver", { intent, sha256: WORK, url: WORK_URL });
    expect((shown["summary"] as string[]).join("\n")).not.toContain("announce fee");
    expect(shown["summary"]).toContain("Pays: the announcement's rent and the transaction fee, from this wallet; the rent returns when the announcement closes, and the escrow's tokens do not move");
    const preview = await cli(["deliver", "--url", "devnet", "--keypair", "worker.json", "--intent", intent, "--sha256", WORK, "--work-url", WORK_URL], { "worker.json": worker });
    expect((preview.json()["summary"] as string[]).join("\n")).not.toContain("announce fee");
  }, 60_000);
});

describe("encryption key files and attestor texts", () => {
  beforeEach(async () => {
    await world();
    h.files.clear();
  });

  it("loads an encryption key file named with ~ in the CLI, as the MCP server does", async () => {
    const judge = await funded();
    const made = await cli(["profile", "encryption-key", "new", "--out", "judge.enc"], {});
    expect([made.code, made.err]).toEqual([EXIT_OK, ""]);
    const set = await cli(["profile", "set", "--keypair", "judge.json", "--skills", "judge", "--endpoint", "https://" + "judge.example", "--encryption-key", String(made.json()["encryption_key"]), "--yes"], { "judge.json": judge });
    expect([set.code, set.err]).toEqual([EXIT_OK, ""]);
    h.files.set(`${HOME}/keys/judge.enc`, h.files.get("judge.enc") ?? "");
    h.files.delete("judge.enc");
    const dir = await mkdtemp(join(tmpdir(), "tilde-key-"));
    await writeFile(join(dir, "work.txt"), "the work\n");
    const sealed = await cli(["seal", "--url", "devnet", "--file", join(dir, "work.txt"), "--to", judge.address, "--out", join(dir, "work.sealed")], {});
    expect([sealed.code, sealed.err]).toEqual([EXIT_OK, ""]);
    const opened = await cli(["unseal", "--file", join(dir, "work.sealed"), "--encryption-keypair", "~/keys/judge.enc", "--out", join(dir, "opened.txt")], {});
    expect([opened.code, opened.err]).toEqual([EXIT_OK, ""]);
    expect(await readFile(join(dir, "opened.txt"), "utf8")).toBe("the work\n");
  }, 60_000);

  it("names the committee case when a wallet that is not the attestor releases a committee escrow", async () => {
    const w = await world();
    const committee = await committeeOf();
    await escrowTo(w.owner, committee, w.inputMint, w.outputMint);
    useWallet(w.owner);
    const refused = await call(await served(), "wallet_attest", { owner: w.owner.address, nonce: "0", delivered_sha256: WORK });
    expect(refused.value).toMatchObject({ code: "Unauthorized", hint: notAttestor(committee) });
    expect(String(refused.value["hint"])).toContain(`when ${committee} is a committee, its members vote with ${tool("wallet_committee_vote")} and anyone releases with ${tool("wallet_committee_release")}`);
  }, 60_000);

  it("refuses escrow previews of a sealed spec when the encryption key file is missing, naming the file", async () => {
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    const hirer = await funded();
    useWallet(hirer);
    const plain = await served();
    const sealed = await ok(plain, "wallet_seal_spec", { text: "# Spec\n", invite: [(await funded()).address] });
    h.specPages.set(SPEC_URL, new TextEncoder().encode(String(sealed["sealed"])));
    const keyed = await served({ extra: ["--encryption-keypair", "missing.enc"] });
    const spec = { attestor: hirer.address, spec_hash: sealed["sha256"], spec_url: SPEC_URL };
    const single = await call(keyed, "wallet_escrow", { sell: "SOL", amount: "0.05", ...spec });
    const plan = await call(keyed, "wallet_escrow_plan", { sell: "SOL", ...spec, pieces: [{ name: "one", amount: "0.01" }, { name: "two", amount: "0.01" }] });
    for (const refused of [single, plan]) {
      expect(refused.error).toBe(true);
      expect(refused.value).toMatchObject({ code: "EncryptionKeyInvalid", hint: encryptionKeyUnread("missing.enc") });
    }
  }, 60_000);

  it("reports an invalid encryption key file when a hirer checks a sealed spec, instead of calling it unchecked", async () => {
    const hirer = await funded();
    useWallet(hirer);
    h.files.set("bad.enc", "not an encryption key file");
    const plain = await served();
    const sealed = await ok(plain, "wallet_seal_spec", { text: "# Spec\n", invite: [(await funded()).address] });
    h.specPages.set(SPEC_URL, new TextEncoder().encode(String(sealed["sealed"])));
    const keyed = await served({ extra: ["--encryption-keypair", "bad.enc"] });
    const refused = await call(keyed, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: hirer.address, spec_hash: sealed["sha256"], spec_url: SPEC_URL });
    expect(refused.error).toBe(true);
    expect(refused.value).toMatchObject({ code: "EncryptionKeyInvalid" });
    expect(String(refused.value["hint"])).toContain("bad.enc");
    expect(JSON.stringify(refused.value)).not.toContain(SEALED_UNCHECKED);
  }, 60_000);
});
