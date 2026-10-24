import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, getAddressDecoder, type KeyPairSigner, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, Kind, NATIVE_MINT, seal, sortMembers, specMemo } from "@intent-engine/core";
import { createClient } from "@intent-engine/client";
import { tool } from "../src/agent/names.js";
import { SERVER_PROBLEMS } from "../src/agent/problems.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { notInvited } from "../src/invites.js";
import { EXIT_FAILED, EXIT_OK } from "../src/main.js";
import { announced as made, keyed } from "./announce.js";
import { cli, creation, funded, h, NOW, ownerSigned, transport, world } from "./harness.js";

type Json = Record<string, unknown> & { [key: string]: any };

const CASES = '{"cases": [{"args": [""], "expected": 0}, {"args": ["one"], "expected": 1}]}';
const SPEC = `# Count words\n\n\`\`\`judge-cases\n${CASES}\n\`\`\`\n`;
const COUNT = "export default function count(text) { const words = text.match(/\\S+/g); return words === null ? 0 : words.length; }\n";
const SPEC_URL = "https://" + "example.org/jobs/release.sealed";
const WORK = "7c".repeat(32);
const WORK_URL = "https://" + "example.org/work/0123456789abcdef0123456789abcdef";
const UNCHECKED = (intent: Address) => `who the job ${intent} invites cannot be checked: `;
const sha = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
const encoded = (text: string) => new TextEncoder().encode(text);

function address(): Address {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  return getAddressDecoder().decode(Uint8Array.from(Buffer.from(jwk.x ?? "", "base64url")));
}

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

async function call(client: Client, name: string, args: object = {}) {
  const result = await client.callTool({ name: tool(name), arguments: args as Record<string, unknown> });
  return { error: result.isError === true, value: result.structuredContent as Json };
}

async function ok(client: Client, name: string, args: object = {}): Promise<Json> {
  const { error, value } = await call(client, name, args);
  expect(error, JSON.stringify(value)).toBe(false);
  return value;
}

async function setup() {
  const w = await world();
  h.files.clear();
  preset(NATIVE_MINT);
  preset(DEVNET_TEST_MINT);
  h.served.length = 0;
  const started = await cli(["mcp", "--url", "devnet", "--wallet", "--all-tools"], {});
  expect([started.code, started.err]).toEqual([EXIT_OK, WALLET_NOTICE.join("\n")]);
  const [near, far] = InMemoryTransport.createLinkedPair();
  await h.served[0]?.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
  return { w, client, wallet };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function post(s: Setup, attestor: Address, invited: Address[]): Promise<Address> {
  h.specPages.set(SPEC_URL, await seal(encoded(SPEC), invited));
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor, specHash: Uint8Array.from(Buffer.from(sha(SPEC), "hex")), judgeFee: 0n } as const;
  const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: s.w.owner, params, inputMint: s.w.inputMint, outputMint: s.w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  h.engineLog = [{ ...creation(intent), ...ownerSigned(intent, [specMemo(SPEC_URL)]) }];
  return intent;
}

async function announced(intent: Address, worker: KeyPairSigner, sha256 = WORK): Promise<void> {
  await made(intent, worker, sha256, WORK_URL);
}

const OTHER = "e9".repeat(32);

async function committeeOf(members: Address[]): Promise<Address> {
  const payer = await funded();
  const created = await cli(["committee", "create", "--url", "devnet", "--keypair", "payer.json", "--members", members.join(","), "--threshold", "2", "--fee-wallet", payer.address, "--yes"], {
    "payer.json": payer,
  });
  expect([created.code, created.err]).toEqual([EXIT_OK, ""]);
  return created.json()["committee"] as Address;
}

describe("the shared invite check on every MCP release path", () => {
  it("refuses a split that pays a co-author the spec is not sealed to", async () => {
    const s = await setup();
    const [workerKey, stranger] = [await keyed(), address()];
    const worker = workerKey.address;
    const intent = await post(s, s.wallet, [s.wallet, worker]);
    await announced(intent, workerKey);
    const recipients = [
      { wallet: worker, weight: 5_000 },
      { wallet: stranger, weight: 5_000 },
    ];
    expect(await call(s.client, "wallet_attest_split", { owner: s.w.owner.address, nonce: "0", recipients, delivered_sha256: WORK })).toEqual({
      error: true,
      value: { code: "NotInvited", retryable: SERVER_PROBLEMS.NotInvited.retryable, hint: notInvited(stranger, intent) },
    });
    const invited = await ok(s.client, "wallet_attest_split", { owner: s.w.owner.address, nonce: "0", recipients: [{ wallet: worker, weight: 10_000 }], delivered_sha256: WORK });
    expect(invited).toMatchObject({ intent, sent: false });
  });

  it("refuses a committee vote to pay a wallet the spec is not sealed to", async () => {
    const s = await setup();
    const members = sortMembers([s.wallet, address()]);
    const committee = await committeeOf(members);
    const [worker, strangerKey] = [address(), await keyed()];
    const stranger = strangerKey.address;
    const intent = await post(s, committee, [...members, worker]);
    await announced(intent, strangerKey);
    const ballot = { owner: s.w.owner.address, nonce: "0", result: "1", delivered_sha256: WORK };
    expect(await call(s.client, "wallet_committee_vote", ballot)).toEqual({
      error: true,
      value: { code: "NotInvited", retryable: SERVER_PROBLEMS.NotInvited.retryable, hint: notInvited(stranger, intent) },
    });
    const votes = [{ member: s.wallet, signature: "ab".repeat(64) }];
    expect(await call(s.client, "wallet_committee_release", { ...ballot, votes })).toMatchObject({ error: true, value: { code: "NotInvited" } });
  });

  it("refuses every payee, retryably, while the sealed spec cannot be fetched or is over the size limit", async () => {
    const s = await setup();
    const [worker, strangerKey] = [address(), await keyed()];
    const stranger = strangerKey.address;
    const intent = await post(s, s.wallet, [s.wallet, worker]);
    await announced(intent, strangerKey);
    const release = { owner: s.w.owner.address, nonce: "0", delivered_sha256: WORK };
    expect(await call(s.client, "wallet_attest", release)).toMatchObject({ error: true, value: { code: "NotInvited" } });
    h.specPages.delete(SPEC_URL);
    const unread = await call(s.client, "wallet_attest", release);
    expect(unread).toMatchObject({ error: true, value: { code: "SpecUnreadable", retryable: true } });
    expect(unread.value["hint"]).toContain(UNCHECKED(intent));
    const split = { owner: s.w.owner.address, nonce: "0", recipients: [{ wallet: stranger, weight: 10_000 }], delivered_sha256: WORK };
    expect(await call(s.client, "wallet_attest_split", split)).toMatchObject({ error: true, value: { code: "SpecUnreadable" } });
    const big = await seal(encoded(`${SPEC}${"a".repeat(900_000)}`), [s.wallet, worker]);
    expect(big.length).toBeGreaterThan(1_048_576);
    h.specPages.set(SPEC_URL, big);
    expect(await call(s.client, "wallet_attest", release)).toMatchObject({ error: true, value: { code: "SpecUnreadable", retryable: true } });
  });

  it("refuses a committee vote while the sealed spec cannot be fetched", async () => {
    const s = await setup();
    const members = sortMembers([s.wallet, address()]);
    const committee = await committeeOf(members);
    const worker = await keyed();
    const intent = await post(s, committee, [...members, worker.address]);
    await announced(intent, worker);
    h.specPages.clear();
    const vote = await call(s.client, "wallet_committee_vote", { owner: s.w.owner.address, nonce: "0", result: "1", delivered_sha256: WORK });
    expect(vote).toMatchObject({ error: true, value: { code: "SpecUnreadable", retryable: true } });
  });
});

describe("a release for work no announcement opens to", () => {
  it("wallet_attest, wallet_attest_split and wallet_committee_vote refuse a delivered_sha256 no announcement opens to", async () => {
    const s = await setup();
    const worker = await keyed();
    const intent = await post(s, s.wallet, [s.wallet, worker.address]);
    await announced(intent, worker);
    const unbacked = "ab".repeat(32);
    const refused = await call(s.client, "wallet_attest", { owner: s.w.owner.address, nonce: "0", delivered_sha256: unbacked });
    expect(refused).toMatchObject({ error: true, value: { code: "NotAnnounced", retryable: false, hint: expect.stringContaining(`has no announcement that opens to the work ${unbacked}`) } });
    const split = { owner: s.w.owner.address, nonce: "0", recipients: [{ wallet: worker.address, weight: 10_000 }], delivered_sha256: unbacked };
    expect(await call(s.client, "wallet_attest_split", split)).toMatchObject({ error: true, value: { code: "NotAnnounced" } });
    const members = sortMembers([s.wallet, address()]);
    const committee = await committeeOf(members);
    const escrow = await ok(s.client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: committee, spec_hash: sha(SPEC), spec_url: SPEC_URL, send: true });
    h.specPages.set(SPEC_URL, await seal(encoded(SPEC), [...members, worker.address]));
    h.engineLog = [{ ...creation(escrow["intent"] as Address), ...ownerSigned(escrow["intent"] as Address, [specMemo(SPEC_URL)]) }];
    await announced(escrow["intent"] as Address, worker);
    const ballot = { owner: s.wallet, nonce: escrow["nonce"], result: "1", delivered_sha256: unbacked };
    expect(await call(s.client, "wallet_committee_vote", ballot)).toMatchObject({ error: true, value: { code: "NotAnnounced" } });
  });
});

describe("the shared invite check on the command line", () => {
  it("judge refuses to pay while the sealed spec cannot be fetched instead of skipping the check", async () => {
    const w = await world();
    const judge = await funded();
    const dir = await mkdtemp(join(tmpdir(), "invite-release-"));
    const spec = join(dir, "spec.md");
    await writeFile(spec, SPEC);
    const artifact = join(dir, "count.mjs");
    await writeFile(artifact, COUNT);
    const workerKey = await keyed();
    const worker = workerKey.address;
    const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: Uint8Array.from(Buffer.from(sha(SPEC), "hex")), judgeFee: 0n } as const;
    const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
    h.engineLog = [{ ...creation(intent), ...ownerSigned(intent, [specMemo(SPEC_URL)]) }];
    await announced(intent, workerKey, sha(COUNT));
    const judging = ["judge", "--keypair", "judge.json", "--owner", w.owner.address, "--nonce", "0", "--spec", spec, "--artifact", artifact, "--sandbox", "viper"];
    const refused = await cli(judging, { "judge.json": judge });
    expect(refused.code).toBe(EXIT_FAILED);
    expect(refused.err).toContain(UNCHECKED(intent));
    h.specPages.set(SPEC_URL, await seal(encoded(SPEC), [judge.address, worker]));
    const judged = await cli(judging, { "judge.json": judge });
    expect([judged.code, judged.err]).toEqual([EXIT_OK, ""]);
    expect(judged.json()).toMatchObject({ intent, verdict: "pass", payTo: worker });
  }, 60_000);

  it("committee vote and committee release refuse a payee the spec is not sealed to", async () => {
    const w = await world();
    const [m0, m1, solver] = [await funded(), await funded(), await funded()];
    const keys = { "m0.json": m0, "m1.json": m1, "solver.json": solver };
    const members = sortMembers([m0.address, m1.address]);
    const committee = await committeeOf(members);
    const [workerKey, strangerKey] = [await keyed(), await keyed()];
    const [worker, stranger] = [workerKey.address, strangerKey.address];
    const intent = await post({ w } as Setup, committee, [...members, worker]);
    await announced(intent, strangerKey, OTHER);
    await announced(intent, workerKey);
    const dir = await mkdtemp(join(tmpdir(), "invite-votes-"));
    const base = ["committee", "vote", "--owner", w.owner.address, "--nonce", "0", "--result", "1"];
    const outsider = await cli([...base, "--keypair", "m0.json", "--sha256", OTHER, "--yes"], keys);
    expect([outsider.code, outsider.err]).toEqual([EXIT_FAILED, notInvited(stranger, intent)]);
    const files = [join(dir, "a.json"), join(dir, "b.json")];
    for (const [member, file] of [["m0.json", files[0] ?? ""], ["m1.json", files[1] ?? ""]] as const) {
      const voted = await cli([...base, "--keypair", member, "--sha256", WORK, "--out", file, "--yes"], keys);
      expect([voted.code, voted.err]).toEqual([EXIT_OK, ""]);
    }
    h.specPages.set(SPEC_URL, await seal(encoded(SPEC), members));
    const release = await cli(["committee", "release", "--keypair", "solver.json", ...files.flatMap((file) => ["--vote", file]), "--yes"], keys);
    expect([release.code, release.err]).toEqual([EXIT_FAILED, notInvited(worker, intent)]);
    h.specPages.clear();
    const unread = await cli(["committee", "release", "--keypair", "solver.json", ...files.flatMap((file) => ["--vote", file]), "--yes"], keys);
    expect(unread.code).toBe(EXIT_FAILED);
    expect(unread.err).toContain(UNCHECKED(intent));
  });
});
