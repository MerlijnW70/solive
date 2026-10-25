import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, type KeyPairSigner, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEVNET_TEST_MINT, NATIVE_MINT } from "@intent-engine/core";
import { specMemo } from "@intent-engine/core/internal";
import { tool } from "../src/agent/names.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { NONE_OPENS, WORK_OPENS } from "../src/agent/wallet/work.js";
import { UNSEAL_NEEDS_KEY } from "../src/arg-values.js";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "../src/main.js";
import { defaultWallet } from "../src/wallet.js";
import { cli, creation, funded, h, HOME, ownerSigned, world } from "./harness.js";

vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "93.184.215.14", family: 4 }] }));

type Json = Record<string, unknown>;

const SPEC = "# Answer\n\nDeliver answer.txt holding 42.\n";
const WORK = "answer.txt: 42\n";
const SPEC_URL = "https://" + "files.example.com/jobs/0f4e2a.md";
const WORK_URL = "https://" + "files.example.com/work/9b1d7c3e5a2f48069b1d7c3e5a2f4806.txt";
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

  it("seals the announced work's url to that key, which wallet_fetch_work opens given only the encryption key file", async () => {
    const plain = await connect();
    await ok(plain, "wallet_setup");
    useKey(judge);
    h.specPages.set(SPEC_URL, bytesOf(SPEC));
    const escrow = await ok(plain, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: judge.address, spec_hash: sha(SPEC), spec_url: SPEC_URL, send: true });
    const intent = escrow["intent"] as Address;
    h.engineLog = [{ ...creation(intent), ...ownerSigned(intent, [specMemo(SPEC_URL)]) }];

    useKey(worker);
    h.specPages.set(WORK_URL, bytesOf(WORK));
    const delivered = await ok(plain, "wallet_deliver", { intent, sha256: sha(WORK), url: WORK_URL, send: true });
    expect(delivered).toMatchObject({ sent: true, sealed_to: [judge.address] });
    expect(delivered["summary"] as string[]).toContain(`Seals: the salt and the url ${WORK_URL} to ${judge.address} (the encryption key its profile publishes), so only they can open it`);
    expect(publicKey).not.toBe("");

    useKey(judge);
    expect((await call(plain, "wallet_fetch_work", { intent })).value).toMatchObject({ code: "WorkUnfetchable", hint: NONE_OPENS });
    const keyed = await connect(["--encryption-keypair", KEY_FILE]);
    expect(await ok(keyed, "wallet_fetch_work", { intent })).toMatchObject({
      announcement: delivered["announcement"],
      worker: worker.address,
      sha256: sha(WORK),
      opens_commitment: true,
      untrusted_text: WORK,
      first: { announcement: delivered["announcement"], worker: worker.address },
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
    h.engineLog = [{ ...creation(intent), ...ownerSigned(intent, [specMemo(SPEC_URL)]) }];
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
