import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Address,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type KeyPairSigner,
  lamports,
  none,
} from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, NATIVE_MINT, parseEncryptionKey, sealedTo, specMemo, unseal } from "@intent-engine/core";
import { type EngineTransaction, MEMO_PROGRAM_ADDRESS, signersAmong } from "@intent-engine/client";
import { tool } from "../src/agent/names.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { NOT_SEALED_HERE, WORK_OPENS } from "../src/agent/wallet/work.js";
import { UNSEAL_NEEDS_KEY } from "../src/arg-values.js";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "../src/main.js";
import { defaultWallet } from "../src/wallet.js";
import { cli, creation, funded, h, HOME, world } from "./harness.js";

type Json = Record<string, unknown>;

const SPEC = "# Answer\n\nDeliver answer.txt holding 42.\n";
const WORK = "answer.txt: 42\n";
const SPEC_URL = "https://" + "files.example.com/jobs/0f4e2a.md";
const WORK_URL = "https://" + "files.example.com/work/9b1d7c3e5a2f4806.sealed";
const KEY_FILE = "judge.enc";
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const bytesOf = (text: unknown) => new TextEncoder().encode(text as string);

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

async function connect(extra: string[] = []): Promise<Client> {
  h.served.length = 0;
  const started = await cli(["mcp", "--url", "devnet", "--wallet", ...extra], {});
  expect([started.code, started.err]).toEqual([EXIT_OK, WALLET_NOTICE.join("\n")]);
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

const useKey = (signer: KeyPairSigner) => h.files.set(defaultWallet(HOME), JSON.stringify(Array.from(h.keypairs.get(signer.address) ?? [])));

function landedAs(wire: string, slot: bigint): EngineTransaction {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
  const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const keys = message.staticAccounts;
  const memos = ("instructions" in message ? message.instructions : []).filter((ix) => keys[ix.programAddressIndex] === MEMO_PROGRAM_ADDRESS);
  return {
    signature: getSignatureFromTransaction(tx),
    slot,
    blockTime: null,
    failed: false,
    emitted: [],
    memos: memos.map((ix) => new TextDecoder().decode(Uint8Array.from(ix.data ?? []))),
    memoSigners: memos.map((ix) => signersAmong(keys, ix.accountIndices ?? [], message.header.numSignerAccounts)),
    ...(keys[0] === undefined ? {} : { feePayer: keys[0] }),
  };
}

async function publishedKey(judge: KeyPairSigner): Promise<string> {
  const made = await cli(["profile", "encryption-key", "new", "--out", KEY_FILE], {});
  expect([made.code, made.err]).toEqual([EXIT_OK, ""]);
  const publicKey = String(made.json()["encryption_key"]);
  const set = await cli(["profile", "set", "--keypair", "judge.json", "--skills", "judge", "--endpoint", "https://" + "judge.example", "--encryption-key", publicKey, "--yes"], { "judge.json": judge });
  expect([set.code, set.err]).toEqual([EXIT_OK, ""]);
  return publicKey;
}

describe("sealing to a judge whose profile publishes an encryption key", () => {
  let judge: KeyPairSigner;
  let worker: KeyPairSigner;
  let publicKey: string;

  beforeEach(async () => {
    await world();
    h.files.clear();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    [judge, worker] = [await funded(), await funded()];
    h.watched.push(judge.address, worker.address);
    publicKey = await publishedKey(judge);
  });

  it("seals the work to that key, which wallet_fetch_work opens given only the encryption key file", async () => {
    const plain = await connect();
    await ok(plain, "wallet_setup");
    useKey(judge);
    h.specPages.set(SPEC_URL, bytesOf(SPEC));
    const escrow = await ok(plain, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: judge.address, spec_hash: sha(SPEC), spec_url: SPEC_URL, send: true });
    const intent = escrow["intent"] as Address;
    const made = { ...creation(intent), memos: [specMemo(SPEC_URL)] };
    h.engineLog = [made];

    useKey(worker);
    const sealed = await ok(plain, "wallet_seal_work", { intent, text: WORK });
    expect(sealed["sealed_to"]).toEqual([judge.address]);
    const hosted = bytesOf(sealed["sealed"]);
    expect(sealedTo(hosted)).toEqual([judge.address]);
    const entry = (JSON.parse(new TextDecoder().decode(hosted)) as { to: { pk: string }[] }).to[0];
    expect(entry?.pk).toBe(Buffer.from(parseEncryptionKey(publicKey)).toString("base64"));
    await expect(unseal(hosted, h.keypairs.get(judge.address) ?? new Uint8Array())).rejects.toThrow("open it with that encryption key file");
    h.specPages.set(WORK_URL, hosted);
    h.wires.length = 0;
    await ok(plain, "wallet_deliver", { intent, sha256: sealed["sha256"], url: WORK_URL, send: true });
    const landed = landedAs(h.wires[0] as string, 5n);
    h.engineLog = [landed, made];

    useKey(judge);
    expect((await call(plain, "wallet_fetch_work", { intent, announcement: landed.signature })).value).toMatchObject({
      code: "WorkUnfetchable",
      hint: `the announcement ${landed.signature}: ${NOT_SEALED_HERE}`,
    });
    const keyed = await connect(["--encryption-keypair", KEY_FILE]);
    expect(await ok(keyed, "wallet_fetch_work", { intent, announcement: landed.signature })).toMatchObject({
      worker: worker.address,
      sealed: true,
      sha256: sha(WORK),
      opens_commitment: true,
      untrusted_text: WORK,
      next: WORK_OPENS,
    });
  }, 60_000);

  it("seals a spec to an invited worker's published key, which get_spec opens with the server's encryption key file", async () => {
    const owner = await funded();
    const plain = await connect();
    await ok(plain, "wallet_setup");
    useKey(owner);
    const sealed = await ok(plain, "wallet_seal_spec", { text: SPEC, invite: [judge.address], attestor: owner.address });
    expect(sealed["sealed_to"]).toEqual([judge.address, owner.address]);
    h.specPages.set(SPEC_URL, bytesOf(sealed["sealed"]));
    const escrow = await ok(plain, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: owner.address, spec_hash: sealed["sha256"], spec_url: SPEC_URL, send: true });
    const intent = escrow["intent"] as Address;
    h.engineLog = [{ ...creation(intent), memos: [specMemo(SPEC_URL)] }];
    useKey(judge);
    expect((await call(plain, "get_spec", { intent })).value).toMatchObject({ code: "SpecUnfetchable" });
    const keyed = await connect(["--encryption-keypair", KEY_FILE]);
    expect(await ok(keyed, "get_spec", { intent })).toMatchObject({ matches: true, text: SPEC, sealed_to: [judge.address, owner.address] });
  }, 60_000);

  it("unseals with intent-engine unseal --encryption-keypair, and asks for a key when given none", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sealed-key-"));
    const plain = join(dir, "work.txt");
    await writeFile(plain, WORK);
    const sealedPath = join(dir, "work.sealed");
    const sealed = await cli(["seal", "--url", "devnet", "--file", plain, "--to", judge.address, "--out", sealedPath], {});
    expect([sealed.code, sealed.err]).toEqual([EXIT_OK, ""]);
    const byWallet = await cli(["unseal", "--file", sealedPath, "--keypair", "judge.json", "--out", join(dir, "wallet.txt")], { "judge.json": judge });
    expect(byWallet.code).toBe(EXIT_FAILED);
    expect(byWallet.err).toContain("open it with that encryption key file");
    const opened = await cli(["unseal", "--file", sealedPath, "--encryption-keypair", KEY_FILE, "--out", join(dir, "opened.txt")], {});
    expect([opened.code, opened.err]).toEqual([EXIT_OK, ""]);
    expect(await readFile(join(dir, "opened.txt"), "utf8")).toBe(WORK);
    const none = await cli(["unseal", "--file", sealedPath, "--out", join(dir, "none.txt")], {});
    expect(none.code).toBe(EXIT_USAGE);
    expect(none.err).toContain(UNSEAL_NEEDS_KEY);
  }, 60_000);
});
