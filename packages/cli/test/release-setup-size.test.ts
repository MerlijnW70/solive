import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, generateKeyPairSigner, getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder, type Instruction, type KeyPairSigner, lamports } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { findAssociatedTokenAddress, IntentStatus, Kind } from "@intent-engine/core";
import { buildClaimJob, buildOpenClaimsListed, claimListAddress, COMPUTE_BUDGET_ADDRESS, ED25519_PROGRAM_ADDRESS, getIntentDecoder } from "@intent-engine/core/internal";
import { createClient } from "@intent-engine/client/node";
import { tool } from "../src/agent/names.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { SETUP_SEPARATE } from "../src/agent/wallet/release-size.js";
import { simulateRelease } from "../src/release-simulation.js";
import { tooLargeRefused } from "../src/judge.js";
import { EXIT_REFUSED, JudgeRefused } from "../src/judge-errors.js";
import { NotSettleable } from "@intent-engine/client";
import { ENV_KEYPAIR } from "../src/clusters.js";
import { EXIT_OK, main } from "../src/main.js";
import { announced, keyed } from "./announce.js";
import { keyedProfile } from "./encryption-job.js";
import { ata, balance, cli, creation, funded, h, NOW, runtime, send, setNow, transport, world } from "./harness.js";
import { device, deviceKey, found, type Key, messageThen } from "./ledger-device.js";
import { airdropped } from "./airdrop.js";
import { UNJUDGED } from "./approved.js";

const CASES = '{"cases": [{"args": [""], "expected": 0}, {"args": ["one two"], "expected": 2}]}';
const SPEC = `# Count words\n\n\`\`\`judge-cases\n${CASES}\n\`\`\`\n`;
const COUNT = "export default function count(text) { const words = text.match(/\\S+/g); return words === null ? 0 : words.length; }\n";
const WORK = createHash("sha256").update(COUNT).digest("hex");
const AMOUNT = 1_000_000n;
const STAKE = 50_000_000n;
const CLAIM_SECS = 60;
const PATH = "usb://ledger?key=2";
const LEVELS = [44, 501, 2];
const KEY_FILE = "judge.enc";

const accountsOf = (wire: string): string[] => [...getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(getBase64Encoder().encode(wire)).messageBytes).staticAccounts];

const signersOf = (wire: string) => Object.keys(getTransactionDecoder().decode(getBase64Encoder().encode(wire)).signatures);

async function fullEscrow(attestorOf: () => Promise<Address>) {
  const w = await world();
  const attestor = await attestorOf();
  await ata(w.authority, w.owner.address, w.inputMint, AMOUNT);
  const capped = await cli(["set-mint-cap", "--keypair", "admin.json", "--mint", w.inputMint, "--max-per-order", String(AMOUNT), "--window-cap", String(AMOUNT), "--window-secs", "3600", "--yes"], { "admin.json": w.authority });
  expect([capped.code, capped.err]).toEqual([EXIT_OK, ""]);
  const partner = (await generateKeyPairSigner()).address;
  const params = { kind: Kind.AttestedResult, amountIn: AMOUNT, minResult: 1n, maxResult: 1n, attestor, specHash: new Uint8Array(createHash("sha256").update(SPEC).digest()), judgeFee: 1_000n } as const;
  const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n, partner, partnerBps: 50 });
  const worker = await keyed();
  await send(w.owner, [await buildOpenClaimsListed({ owner: w.owner, intent, maxSecs: 3_600, stake: STAKE, reviewSecs: 0, size: 1, workers: [worker.address] })]);
  await send(worker, [await buildClaimJob({ worker, intent, owner: w.owner.address, secs: CLAIM_SECS, claimList: await claimListAddress(intent) })]);
  const made = await announced(intent, worker, WORK);
  setNow(NOW + BigInt(CLAIM_SECS) * 2n);
  const paid = async (owner: Address) => balance(await findAssociatedTokenAddress({ owner, mint: w.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }));
  const status = () => {
    const view = h.svm.getAccount(intent);
    return view.exists ? getIntentDecoder().decode(view.data).status : undefined;
  };
  return { w, intent, worker, made, partner, paid, status };
}

function recording(): Instruction[][] {
  const sent: Instruction[][] = [];
  h.through = {
    ...transport,
    send: async (instructions, payer) => {
      const signature = await transport.send(instructions, payer);
      sent.push([...instructions]);
      return signature;
    },
  };
  return sent;
}

async function judgedRelease(judge: () => Promise<Address>, payer: boolean) {
  const e = await fullEscrow(judge);
  const dir = await mkdtemp(join(tmpdir(), "release-setup-"));
  const spec = join(dir, "spec.md");
  const artifact = join(dir, "count.mjs");
  await writeFile(spec, SPEC);
  await writeFile(artifact, COUNT);
  const argv = ["judge", "--owner", e.w.owner.address, "--nonce", "0", "--spec", spec, "--artifact", artifact, "--sandbox", "viper", ...(payer ? ["--keypair", PATH, "--encryption-keypair", KEY_FILE, "--fee-payer", "payer.json"] : ["--keypair", "judge.json"])];
  return { e, argv };
}

async function run(argv: string[], ledger: ReturnType<typeof device> | undefined, keys: Record<string, KeyPairSigner>) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { ...runtime(keys), ...(ledger === undefined ? {} : { ledger: ledger.open }) }, { out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, err: err.join("\n"), json: () => JSON.parse(out.join("\n")) as Record<string, unknown> };
}

async function onDevice(): Promise<{ key: Key; attestor: () => Promise<Address>; open: (e: { intent: Address }) => Promise<void> }> {
  const key = await deviceKey();
  let profile: Awaited<ReturnType<typeof keyedProfile>> | undefined;
  return {
    key,
    attestor: async () => {
      airdropped(h.svm, key.address, lamports(10_000_000_000n));
      profile = await keyedProfile(key, KEY_FILE);
      return key.address;
    },
    open: async (e) => {
      h.engineLog = [creation(e.intent), ...(profile === undefined ? [] : [profile.entry])];
      h.env[ENV_KEYPAIR] = PATH;
    },
  };
}

async function served(ledger: ReturnType<typeof device>, payer: KeyPairSigner): Promise<Client> {
  h.served.length = 0;
  const err: string[] = [];
  const code = await main(["mcp", "--url", "devnet", "--wallet", "--all-tools", "--fee-payer", "payer.json", "--encryption-keypair", KEY_FILE], { ...runtime({ "payer.json": payer }), ledger: ledger.open }, { out: () => undefined, err: (t) => err.push(t) });
  expect([code, err.join("\n")]).toEqual([EXIT_OK, WALLET_NOTICE.join("\n")]);
  const [near, far] = InMemoryTransport.createLinkedPair();
  await h.served[0]?.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return client;
}

async function walletServer(): Promise<Client> {
  h.served.length = 0;
  const started = await cli(["mcp", "--url", "devnet", "--wallet", "--all-tools"], {});
  expect([started.code, started.err]).toEqual([EXIT_OK, WALLET_NOTICE.join("\n")]);
  const [near, far] = InMemoryTransport.createLinkedPair();
  await h.served[0]?.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return client;
}

async function call(client: Client, name: string, args: object = {}) {
  const result = await client.callTool({ name: tool(name), arguments: args as Record<string, unknown> });
  return { error: result.isError === true, value: result.structuredContent as Record<string, unknown> };
}

describe("a release whose token accounts do not fit in its transaction", () => {
  it("judge on a Ledger with a fee payer sends the four token accounts first, then the release, each within the limit", async () => {
    const d = await onDevice();
    const r = await judgedRelease(d.attestor, true);
    await d.open(r.e);
    const payer = await funded();
    const keys = { "payer.json": payer };
    const sent = recording();
    const ledger = device(d.key, [...found(LEVELS, d.key), ...messageThen()]);
    const judged = await run([...r.argv, "--yes"], ledger, keys);
    expect([judged.code, judged.err]).toEqual([EXIT_OK, ""]);
    expect(judged.json()).toMatchObject({ verdict: "pass", signature: expect.any(String), feePayer: payer.address });
    expect(sent.map((ixs) => ixs.some((ix) => ix.programAddress === ED25519_PROGRAM_ADDRESS))).toEqual([false, true]);
    expect(sent[0]?.filter((ix) => ix.programAddress !== COMPUTE_BUDGET_ADDRESS)).toHaveLength(4);
    expect(r.e.status()).toBe(IntentStatus.Filled);
    expect(await r.e.paid(r.e.worker.address)).toBeGreaterThan(0n);
    expect(await r.e.paid(r.e.partner)).toBeGreaterThan(0n);
    expect(await r.e.paid(d.key.address)).toBe(1_000n);
  });

  it("a release simulation with a separate fee payer simulates the setup it sends first and says so, and without one the whole release", async () => {
    let judge: KeyPairSigner | undefined;
    const e = await fullEscrow(async () => {
      judge = await funded();
      return judge.address;
    });
    if (judge === undefined) {
      throw new Error("no judge");
    }
    const release = { url: "http://cluster", owner: e.w.owner.address, nonce: 0n, announcement: e.made.announcement, result: 1n, sha256: WORK, salt: e.made.salt };
    const simulated = h.simulated.length;
    expect(await simulateRelease(transport, judge, { ...release, payer: await funded() })).toEqual({ ok: true, units_consumed: expect.any(Number), setup_first: true });
    expect(accountsOf(h.simulated.at(-1) ?? "")).not.toContain(ED25519_PROGRAM_ADDRESS);
    expect(await simulateRelease(transport, judge, release)).toEqual({ ok: true, units_consumed: expect.any(Number) });
    expect(accountsOf(h.simulated.at(-1) ?? "")).toContain(ED25519_PROGRAM_ADDRESS);
    expect(h.simulated.length - simulated).toBeGreaterThan(1);
    expect(e.status()).toBe(IntentStatus.Open);
  });

  it("judge with a key file keeps the token accounts in the one release transaction that fits, and its preview simulates that release", async () => {
    let judge: KeyPairSigner | undefined;
    const r = await judgedRelease(async () => {
      judge = await funded();
      return judge.address;
    }, false);
    const keys: Record<string, KeyPairSigner> = judge === undefined ? {} : { "judge.json": judge };
    const shown = await run(r.argv, undefined, keys);
    expect([shown.code, shown.err]).toEqual([EXIT_OK, ""]);
    expect(shown.json()["simulated"]).toEqual({ ok: true, units_consumed: expect.any(Number) });
    const sent = recording();
    const judged = await run([...r.argv, "--yes"], undefined, keys);
    expect([judged.code, judged.err]).toEqual([EXIT_OK, ""]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.filter((ix) => ix.programAddress !== COMPUTE_BUDGET_ADDRESS)).toHaveLength(6);
    expect(r.e.status()).toBe(IntentStatus.Filled);
    expect(await r.e.paid(r.e.worker.address)).toBeGreaterThan(0n);
  });

  it("wallet_attest on a Ledger with a fee payer says the setup goes first, sends it first, then releases", async () => {
    const d = await onDevice();
    const key = d.key;
    const e = await fullEscrow(d.attestor);
    await d.open(e);
    const payer = await funded();
    const ledger = device(key, [...found(LEVELS, key), ...messageThen()]);
    const client = await served(ledger, payer);
    const release = { ...UNJUDGED, owner: e.w.owner.address, nonce: "0", delivered_sha256: WORK };
    const shown = await call(client, "wallet_attest", release);
    expect(shown.error, JSON.stringify(shown.value)).toBe(false);
    expect(shown.value["summary"]).toEqual(expect.arrayContaining([SETUP_SEPARATE]));
    expect(shown.value["summary"]).not.toEqual(expect.arrayContaining([expect.stringMatching(/^Too large: /)]));
    expect(h.wires).toHaveLength(0);
    const sent = await call(client, "wallet_attest", { ...release, approval: shown.value["approval"], send: true });
    expect(sent.error, JSON.stringify(sent.value)).toBe(false);
    expect(sent.value).toMatchObject({ sent: true });
    expect(h.wires).toHaveLength(2);
    expect(h.wires.map(signersOf)).toEqual([[payer.address], [payer.address]]);
    expect(e.status()).toBe(IntentStatus.Filled);
    expect(await e.paid(e.worker.address)).toBeGreaterThan(0n);
    expect(await e.paid(key.address)).toBe(1_000n);
  });

  it("wallet_attest without a fee payer keeps the token accounts in its one release transaction", async () => {
    let client: Client | undefined;
    const e = await fullEscrow(async () => {
      client = await walletServer();
      return (await call(client, "wallet_setup")).value["address"] as Address;
    });
    if (client === undefined) {
      throw new Error("no wallet server");
    }
    h.watched.push(e.w.owner.address);
    const release = { ...UNJUDGED, owner: e.w.owner.address, nonce: "0", delivered_sha256: WORK };
    const shown = await call(client, "wallet_attest", release);
    expect(shown.error, JSON.stringify(shown.value)).toBe(false);
    expect(shown.value["summary"]).not.toEqual(expect.arrayContaining([SETUP_SEPARATE]));
    const before = h.wires.length;
    const sent = await call(client, "wallet_attest", { ...release, approval: shown.value["approval"], send: true });
    expect(sent.error, JSON.stringify(sent.value)).toBe(false);
    expect(h.wires.length - before).toBe(1);
    expect(e.status()).toBe(IntentStatus.Filled);
    expect(await e.paid(e.worker.address)).toBeGreaterThan(0n);
  });

  it("judge turns a client refusal of a too-large release into a refusal that sends nothing, and passes other errors on", () => {
    const intent = "11111111111111111111111111111111" as Address;
    let caught: unknown;
    try {
      tooLargeRefused(new NotSettleable(intent, "too-large", "builds a 1233-byte release transaction"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(JudgeRefused);
    expect(caught).toMatchObject({ exitCode: EXIT_REFUSED, message: `ReleaseTooLarge: intent ${intent} builds a 1233-byte release transaction` });
    const other = new NotSettleable(intent, "wrong-judge", "names another judge");
    expect(() => tooLargeRefused(other)).toThrow(other);
  });
});
