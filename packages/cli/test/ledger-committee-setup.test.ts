import { type Address, generateKeyPairSigner, getBase16Decoder, lamports } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { findAssociatedTokenAddress, IntentStatus, Kind } from "@intent-engine/core";
import { getIntentDecoder, signCommitteeVote, sortMembers } from "@intent-engine/core/internal";
import { createClient } from "@intent-engine/client/node";
import { type OpenTransport } from "@intent-engine/client/internal";
import { tool } from "../src/agent/names.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { SETUP_FIRST } from "../src/agent/wallet/committee-split.js";
import { ENV_KEYPAIR } from "../src/clusters.js";
import { EXIT_OK, main } from "../src/main.js";
import { announced, keyed } from "./announce.js";
import { keyedProfile } from "./encryption-job.js";
import { ata, balance, cli, creation, funded, h, NOW, runtime, transport, world } from "./harness.js";
import { device, deviceKey, found, messageThen, transactionThen } from "./ledger-device.js";
import { airdropped } from "./airdrop.js";
import { lookupTable } from "./lookup-table-kit.js";
import { UNJUDGED } from "./approved.js";

type Json = Record<string, any>;

const PATH = "usb://ledger?key=7";
const LEVELS = [44, 501, 7];
const WORK = "7e".repeat(32);
const KEY_FILE = "member.enc";
const AMOUNT = 1_000_000n;

async function served(open: OpenTransport): Promise<Client> {
  h.served.length = 0;
  const err: string[] = [];
  const code = await main(["mcp", "--url", "devnet", "--wallet", "--all-tools", "--encryption-keypair", KEY_FILE], { ...runtime({}), ledger: open }, { out: () => undefined, err: (t) => err.push(t) });
  expect([code, err.join("\n")]).toEqual([EXIT_OK, WALLET_NOTICE.join("\n")]);
  const [near, far] = InMemoryTransport.createLinkedPair();
  await h.served[0]?.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return client;
}

async function ok(client: Client, name: string, args: object): Promise<Json> {
  const result = await client.callTool({ name: tool(name), arguments: args as Record<string, unknown> });
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
  return result.structuredContent as Json;
}

async function scene(members: number, threshold: number, transactions: number) {
  const w = await world();
  await ata(w.authority, w.owner.address, w.inputMint, AMOUNT);
  const capped = await cli(["set-mint-cap", "--keypair", "admin.json", "--mint", w.inputMint, "--max-per-order", String(AMOUNT), "--window-cap", String(AMOUNT), "--window-secs", "3600", "--yes"], { "admin.json": w.authority });
  expect([capped.code, capped.err]).toEqual([EXIT_OK, ""]);
  const key = await deviceKey();
  airdropped(h.svm, key.address, lamports(10_000_000_000n));
  const profile = await keyedProfile(key, KEY_FILE);
  const worker = await keyed();
  const others = await Promise.all(Array.from({ length: members - 1 }, () => generateKeyPairSigner()));
  const feeWallet = (await generateKeyPairSigner()).address;
  const client0 = createClient({ url: "http://cluster", transport });
  const { committee } = await client0.createCommittee({ members: sortMembers([key.address, ...others.map((o) => o.address)]), threshold, feeWallet, payer: await funded() });
  const params = { kind: Kind.AttestedResult, amountIn: AMOUNT, minResult: 1n, maxResult: 1n, attestor: committee, specHash: new Uint8Array(32).fill(9), judgeFee: 1_000n } as const;
  const partner = (await generateKeyPairSigner()).address;
  const { intent } = await client0.createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n, partner, partnerBps: 50 });
  const made = await announced(intent, worker, WORK);
  h.engineLog = [creation(intent), profile.entry];
  h.env[ENV_KEYPAIR] = PATH;
  const ballot = { owner: w.owner.address, nonce: "0", result: "1", delivered_sha256: WORK };
  const digest = await client0.committeeBallot({ intent: { owner: w.owner.address, nonce: 0n }, announcement: made.announcement, opening: { sha256: WORK, salt: made.salt }, result: 1n });
  const theirs = await Promise.all(others.slice(0, threshold - 1).map((o) => signCommitteeVote(o, digest.digest, digest.committee.members)));
  const ledger = device(key, [...found(LEVELS, key), ...messageThen(), ...Array.from({ length: transactions }, () => transactionThen()).flat()]);
  const client = await served(ledger.open);
  const shown = await ok(client, "wallet_committee_vote", { ...UNJUDGED, ...ballot });
  const own = (await ok(client, "wallet_committee_vote", { ...UNJUDGED, ...ballot, approval: shown["approval"], send: true }))["vote"];
  const release = { ...ballot, votes: [own, ...theirs.map((t) => ({ member: t.member, signature: getBase16Decoder().decode(t.signature).toLowerCase() }))] };
  const paid = async (owner: Address) => balance(await findAssociatedTokenAddress({ owner, mint: w.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }));
  const status = () => {
    const held = h.svm.getAccount(intent);
    return held.exists ? getIntentDecoder().decode(held.data).status : undefined;
  };
  return { client, ledger, release, paid, status, worker, feeWallet, committee };
}

describe("a Ledger member releasing a committee escrow whose token accounts do not fit with the release", () => {
  it("sends the setup alone first, says so, then releases in a transaction that fits", async () => {
    const s = await scene(2, 2, 2);
    const setupPreview = await ok(s.client, "wallet_committee_release", s.release);
    expect(setupPreview["summary"]).toContain(SETUP_FIRST);
    expect(setupPreview["summary"]).not.toEqual(expect.arrayContaining([expect.stringMatching(/^Too large: /)]));
    const setup = await ok(s.client, "wallet_committee_release", { ...s.release, approval: setupPreview["approval"], send: true });
    expect(setup).toMatchObject({ sent: true, next: SETUP_FIRST });
    expect(await s.paid(s.worker.address)).toBe(0n);
    const releasePreview = await ok(s.client, "wallet_committee_release", s.release);
    expect(releasePreview["summary"]).not.toContain(SETUP_FIRST);
    const sent = await ok(s.client, "wallet_committee_release", { ...s.release, approval: releasePreview["approval"], send: true });
    expect(sent).toMatchObject({ sent: true });
    s.ledger.store.ensureQueueEmpty();
    expect(s.status()).toBe(IntentStatus.Filled);
    expect(await s.paid(s.worker.address)).toBeGreaterThan(0n);
    expect(await s.paid(s.feeWallet)).toBe(1_000n);
  });

  it("refuses a release too large even without its setup before it sends the setup, and sends setup and release in one transaction once a lookup table makes them fit", async () => {
    const s = await scene(8, 3, 1);
    const preview = await ok(s.client, "wallet_committee_release", s.release);
    expect(preview["summary"]).toEqual(expect.arrayContaining([expect.stringMatching(/^Too large: this committee release builds a \d+-byte transaction, over the 1232-byte limit; pass lookup_table/)]));
    const wires = h.wires.length;
    const refused = await s.client.callTool({ name: tool("wallet_committee_release"), arguments: { ...s.release, approval: preview["approval"], send: true } });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({ code: "ReleaseTooLarge" });
    expect(h.wires.length).toBe(wires);
    expect(await s.paid(s.worker.address)).toBe(-1n);
    expect(await s.paid(s.feeWallet)).toBe(-1n);
    const lookups = preview["lookup_accounts"] as Address[];
    expect(lookups).toContain(s.committee);
    const table = (await generateKeyPairSigner()).address;
    lookupTable(lookups, table);
    const tabled = { ...s.release, lookup_table: table };
    const shown = await ok(s.client, "wallet_committee_release", tabled);
    expect(shown["summary"]).not.toEqual(expect.arrayContaining([expect.stringMatching(/^Too large: /)]));
    expect(shown["summary"]).not.toContain(SETUP_FIRST);
    expect(await ok(s.client, "wallet_committee_release", { ...tabled, approval: shown["approval"], send: true })).toMatchObject({ sent: true });
    s.ledger.store.ensureQueueEmpty();
    expect(s.status()).toBe(IntentStatus.Filled);
    expect(await s.paid(s.worker.address)).toBeGreaterThan(0n);
  });
});
