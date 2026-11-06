import { type Address, generateKeyPairSigner, getBase16Encoder, type KeyPairSigner, lamports, none, signBytes } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, findAssociatedTokenAddress, IntentStatus, Kind, NATIVE_MINT, splitFees } from "@intent-engine/core";
import { getIntentDecoder, sortMembers, splitN } from "@intent-engine/core/internal";
import { createClient } from "@intent-engine/client/node";
import { type OpenTransport } from "@intent-engine/client/internal";
import { tool } from "../src/agent/names.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { SETUP_FIRST, SIGN_FIRST, VOTE_CHANGED } from "../src/agent/wallet/committee-split.js";
import { ENV_KEYPAIR } from "../src/clusters.js";
import { EXIT_OK, main } from "../src/main.js";
import { announced, keyed } from "./announce.js";
import { keyedProfile } from "./encryption-job.js";
import { balance, creation, FEE_BPS, funded, h, NOW, runtime, transport, world } from "./harness.js";
import { device, deviceKey, found, MESSAGE, messageThen, SIGN, transactionThen } from "./ledger-device.js";
import { airdropped } from "./airdrop.js";
import { UNJUDGED } from "./approved.js";
import { judgedBy } from "./receipt-kit.js";

type Json = Record<string, any>;

const PATH = "usb://ledger?key=6";
const LEVELS = [44, 501, 6];
const WORK = "6d".repeat(32);
const KEY_FILE = "member.enc";
const PAY = 100n;
const WEIGHTS = [6_000, 4_000];

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

async function refused(client: Client, name: string, args: object): Promise<Json> {
  const result = await client.callTool({ name: tool(name), arguments: args as Record<string, unknown> });
  expect(result.isError, JSON.stringify(result.structuredContent)).toBe(true);
  return result.structuredContent as Json;
}

async function ok(client: Client, name: string, args: object): Promise<Json> {
  const result = await client.callTool({ name: tool(name), arguments: args as Record<string, unknown> });
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
  return result.structuredContent as Json;
}

async function scene(seed: number) {
  const w = await world();
  preset(NATIVE_MINT);
  preset(DEVNET_TEST_MINT);
  const key = await deviceKey();
  airdropped(h.svm, key.address, lamports(10_000_000_000n));
  const profile = await keyedProfile(key, KEY_FILE);
  const [worker, other] = await Promise.all([keyed(), keyed()]);
  const client0 = createClient({ url: "http://cluster", transport });
  const { committee } = await client0.createCommittee({ members: sortMembers([key.address, other.address]), threshold: 1, feeWallet: key.address, payer: await funded() });
  const params = { kind: Kind.AttestedResult, amountIn: PAY, minResult: 1n, maxResult: 1n, attestor: committee, specHash: new Uint8Array(32).fill(seed), judgeFee: 0n } as const;
  const { intent } = await client0.createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  const made = await announced(intent, worker, WORK);
  h.engineLog = [creation(intent), profile.entry];
  h.env[ENV_KEYPAIR] = PATH;
  const recipients = [
    { wallet: worker.address, weight: WEIGHTS[0] as number },
    { wallet: key.address, weight: WEIGHTS[1] as number },
  ];
  const target = { intent: { owner: w.owner.address, nonce: 0n }, announcement: made.announcement, opening: { sha256: WORK, salt: made.salt }, result: 1n, recipients };
  const { message } = await client0.splitBallot(target);
  const signedBy = async (signer: KeyPairSigner) => Buffer.from(await signBytes(signer.keyPair.privateKey, message)).toString("hex");
  const ballot = { owner: w.owner.address, nonce: "0", result: "1", delivered_sha256: WORK, recipients };
  return { key, worker, other, message, signedBy, ballot, recipients };
}

describe("a Ledger member's committee split over the wallet server", () => {
  it("votes with one message on the device and releases one transaction at a time, the setup first", async () => {
    const w = await world();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    const key = await deviceKey();
    airdropped(h.svm, key.address, lamports(10_000_000_000n));
    const profile = await keyedProfile(key, KEY_FILE);
    const worker: KeyPairSigner = await keyed();
    const members = sortMembers([key.address, (await generateKeyPairSigner()).address]);
    const client0 = createClient({ url: "http://cluster", transport });
    const { committee } = await client0.createCommittee({ members, threshold: 1, feeWallet: key.address, payer: await funded() });
    const params = { kind: Kind.AttestedResult, amountIn: PAY, minResult: 1n, maxResult: 1n, attestor: committee, specHash: new Uint8Array(32).fill(8), judgeFee: 0n } as const;
    const { intent } = await client0.createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
    await announced(intent, worker, WORK);
    h.engineLog = [creation(intent), profile.entry];
    h.env[ENV_KEYPAIR] = PATH;

    const ledger = device(key, [...found(LEVELS, key), ...messageThen(), ...transactionThen(), ...transactionThen()]);
    const client = await served(ledger.open);
    const recipients = [
      { wallet: worker.address, weight: WEIGHTS[0] as number },
      { wallet: key.address, weight: WEIGHTS[1] as number },
    ];
    const ballot = { owner: w.owner.address, nonce: "0", result: "1", delivered_sha256: WORK, recipients };
    const shown = await ok(client, "wallet_committee_vote", { ...UNJUDGED, ...ballot });
    const voted = await ok(client, "wallet_committee_vote", { ...UNJUDGED, ...ballot, approval: shown["approval"], send: true });
    expect(ledger.signed.map((s) => [s.kind, Buffer.from(s.bytes).toString("hex")])).toEqual([[MESSAGE, shown["envelope"]]]);
    const envelope = Uint8Array.from(getBase16Encoder().encode(String(shown["envelope"])));
    const signature = Buffer.from(await signBytes(worker.keyPair.privateKey, envelope)).toString("hex");
    const release = { ...ballot, votes: [voted["vote"]], recipients: [{ ...recipients[0], signature }, recipients[1]] };

    const setupPreview = await ok(client, "wallet_committee_release", release);
    expect(setupPreview["summary"]).toContain(SETUP_FIRST);
    expect(setupPreview["message_hash"]).toEqual(expect.any(String));
    const setup = await ok(client, "wallet_committee_release", { ...release, approval: setupPreview["approval"], send: true });
    expect(setup).toMatchObject({ sent: true, next: SETUP_FIRST });
    const paid = async (owner: Address) => balance(await findAssociatedTokenAddress({ owner, mint: w.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }));
    expect(await paid(worker.address)).toBe(0n);
    const releasePreview = await ok(client, "wallet_committee_release", release);
    expect(releasePreview["summary"]).not.toContain(SETUP_FIRST);
    const sent = await ok(client, "wallet_committee_release", { ...release, approval: releasePreview["approval"], send: true });
    expect(sent).toMatchObject({ sent: true });
    ledger.store.ensureQueueEmpty();
    expect(ledger.signed.map((s) => s.kind)).toEqual([MESSAGE, SIGN, SIGN]);
    const held = h.svm.getAccount(intent);
    expect(held.exists && getIntentDecoder().decode(held.data).status).toBe(IntentStatus.Filled);
    expect([await paid(worker.address), await paid(key.address)]).toEqual(splitN(splitFees(PAY, FEE_BPS, 0, 0).net, WEIGHTS));
  });

  it("signs nothing in a preview when the Ledger releaser is a co-author that did not vote, then signs its share alone, the setup, and the release", async () => {
    const w = await world();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    const key = await deviceKey();
    airdropped(h.svm, key.address, lamports(10_000_000_000n));
    const profile = await keyedProfile(key, KEY_FILE);
    const [worker, other] = await Promise.all([keyed(), keyed()]);
    const client0 = createClient({ url: "http://cluster", transport });
    const { committee } = await client0.createCommittee({ members: sortMembers([key.address, other.address]), threshold: 1, feeWallet: key.address, payer: await funded() });
    const params = { kind: Kind.AttestedResult, amountIn: PAY, minResult: 1n, maxResult: 1n, attestor: committee, specHash: new Uint8Array(32).fill(7), judgeFee: 0n } as const;
    const { intent } = await client0.createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
    const made = await announced(intent, worker, WORK);
    await judgedBy([key.address], { owner: w.owner.address, nonce: 0n, intent, specSha256: "07".repeat(32), deliveredSha256: WORK, announcement: made.announcement });
    h.engineLog = [creation(intent), profile.entry];
    h.env[ENV_KEYPAIR] = PATH;
    const recipients = [
      { wallet: worker.address, weight: WEIGHTS[0] as number },
      { wallet: key.address, weight: WEIGHTS[1] as number },
    ];
    const target = { intent: { owner: w.owner.address, nonce: 0n }, announcement: made.announcement, opening: { sha256: WORK, salt: made.salt }, result: 1n, recipients };
    const { message } = await client0.splitBallot(target);
    const signedBy = async (signer: KeyPairSigner) => Buffer.from(await signBytes(signer.keyPair.privateKey, message)).toString("hex");
    const ledger = device(key, [...found(LEVELS, key), ...messageThen(), ...transactionThen(), ...transactionThen()]);
    const client = await served(ledger.open);
    const release = { owner: w.owner.address, nonce: "0", result: "1", delivered_sha256: WORK, votes: [{ member: other.address, signature: await signedBy(other) }], recipients: [{ ...recipients[0], signature: await signedBy(worker) }, recipients[1]] };

    const preview = await ok(client, "wallet_committee_release", release);
    expect(ledger.signed).toEqual([]);
    expect(preview).not.toHaveProperty("message_hash");
    expect(preview["summary"]).toContain(SIGN_FIRST);
    expect(preview["summary"]).toContain(`Signs: only the envelope on the Ledger, which shows digest ${preview["digest"]}; approve on the device only if it shows the same`);
    expect(await refused(client, "wallet_committee_release", { ...release, approval: "00".repeat(8), send: true })).toMatchObject({ code: "ReleaseChanged" });
    const forged = { ...release, recipients: [{ ...release.recipients[0], signature: await signedBy(other) }, recipients[1]] };
    expect(await refused(client, "wallet_committee_release", { ...forged, approval: preview["approval"], send: true })).toMatchObject({ code: "SigMessage" });
    expect(ledger.signed).toEqual([]);
    const signing = await ok(client, "wallet_committee_release", { ...release, approval: preview["approval"], send: true });
    expect(signing).toMatchObject({ sent: false, next: SIGN_FIRST, cosign: { wallet: key.address } });
    expect(ledger.signed.map((s) => [s.kind, Buffer.from(s.bytes).toString("hex")])).toEqual([[MESSAGE, Buffer.from(message).toString("hex")]]);
    const signed = { ...release, recipients: [release.recipients[0], { ...recipients[1], signature: signing["cosign"]["signature"] }] };
    const setupPreview = await ok(client, "wallet_committee_release", signed);
    expect(setupPreview["summary"]).toContain(SETUP_FIRST);
    expect(await ok(client, "wallet_committee_release", { ...signed, approval: setupPreview["approval"], send: true })).toMatchObject({ sent: true, next: SETUP_FIRST });
    const releasePreview = await ok(client, "wallet_committee_release", signed);
    expect(await ok(client, "wallet_committee_release", { ...signed, approval: releasePreview["approval"], send: true })).toMatchObject({ sent: true });
    ledger.store.ensureQueueEmpty();
    expect(ledger.signed.map((s) => s.kind)).toEqual([MESSAGE, SIGN, SIGN]);
    const paid = async (owner: Address) => balance(await findAssociatedTokenAddress({ owner, mint: w.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }));
    expect([await paid(worker.address), await paid(key.address)]).toEqual(splitN(splitFees(PAY, FEE_BPS, 0, 0).net, WEIGHTS));
  });

  it("refuses a Ledger member's split vote with a wrong or missing approval and signs nothing on the device", async () => {
    const s = await scene(5);
    const ledger = device(s.key, [...found(LEVELS, s.key), ...messageThen()]);
    const client = await served(ledger.open);
    const shown = await ok(client, "wallet_committee_vote", { ...UNJUDGED, ...s.ballot });
    for (const approval of ["00".repeat(8), undefined]) {
      expect(await refused(client, "wallet_committee_vote", { ...UNJUDGED, ...s.ballot, approval, send: true })).toMatchObject({ code: "ReleaseChanged", hint: VOTE_CHANGED });
      expect(ledger.signed).toEqual([]);
    }
    const voted = await ok(client, "wallet_committee_vote", { ...UNJUDGED, ...s.ballot, approval: shown["approval"], send: true });
    expect(voted).toMatchObject({ signed: true, vote: { member: s.key.address } });
    ledger.store.ensureQueueEmpty();
    expect(ledger.signed.map((x) => [x.kind, Buffer.from(x.bytes).toString("hex")])).toEqual([[MESSAGE, shown["envelope"]]]);
  });

  describe("on the sign-first release", () => {
    const attempt = async (seed: number, votesOf: (s: Awaited<ReturnType<typeof scene>>) => Promise<object[]>) => {
      const s = await scene(seed);
      const ledger = device(s.key, [...found(LEVELS, s.key), ...messageThen()]);
      const client = await served(ledger.open);
      const recipients = [{ ...s.recipients[0], signature: await s.signedBy(s.worker) }, s.recipients[1]];
      const good = { ...UNJUDGED, ...s.ballot, votes: [{ member: s.other.address, signature: await s.signedBy(s.other) }], recipients };
      const preview = await ok(client, "wallet_committee_release", good);
      expect(preview["summary"]).toContain(SIGN_FIRST);
      const bad = { ...good, votes: await votesOf(s) };
      expect(await refused(client, "wallet_committee_release", bad)).toMatchObject({ code: "SigMessage" });
      expect(await refused(client, "wallet_committee_release", { ...bad, approval: preview["approval"], send: true })).toMatchObject({ code: "SigMessage" });
      expect(ledger.signed).toEqual([]);
      const signing = await ok(client, "wallet_committee_release", { ...good, approval: preview["approval"], send: true });
      expect(signing).toMatchObject({ sent: false, next: SIGN_FIRST, cosign: { wallet: s.key.address } });
      ledger.store.ensureQueueEmpty();
      expect(ledger.signed.map((x) => [x.kind, Buffer.from(x.bytes).toString("hex")])).toEqual([[MESSAGE, Buffer.from(s.message).toString("hex")]]);
    };

    it("refuses a forged vote and the device signs nothing", async () => {
      await attempt(6, async (s) => [{ member: s.other.address, signature: await s.signedBy(s.worker) }]);
    });

    it("refuses a vote from a non-member and the device signs nothing", async () => {
      await attempt(9, async (s) => [{ member: s.worker.address, signature: await s.signedBy(s.worker) }]);
    });
  });
});
