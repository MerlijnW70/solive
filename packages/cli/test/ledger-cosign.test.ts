import { createHash } from "node:crypto";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, generateKeyPairSigner, getAddressEncoder, type KeyPairSigner, lamports } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import {
  attestedSplitMessage,
  buildEd25519CosignInstruction,
  buildFillAttestedSplit,
  committeeEnvelope,
  findAssociatedTokenAddress,
  getIntentDecoder,
  IntentStatus,
  Kind,
  signMessageBytes,
  sortMembers,
  splitCommit,
} from "@intent-engine/core";
import { createClient, type EngineTransaction, LEDGER_ERRORS, ledgerSigner } from "@intent-engine/client";
import { LEDGER_COMMANDS, signsOnDevice } from "../src/ledger-keys.js";
import { parse } from "../src/args.js";
import { EXIT_FAILED, EXIT_OK, main } from "../src/main.js";
import { sealedDelivery } from "./announce.js";
import { ata, balance, creation, DOMAIN, FEE_BPS, funded, h, NOW, runtime, send, transport, world } from "./harness.js";
import { type Device, device, deviceKey as newKey, found, type Key, MESSAGE, messageThen, REJECT, SIGN, transactionThen } from "./ledger-device.js";

const LEVELS = [44, 501];
const PAY = 100n;

const hex = (bytes: Iterable<number>) => Buffer.from([...bytes]).toString("hex");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

async function deviceKey(): Promise<Key> {
  const key = await newKey();
  h.svm.airdrop(key.address, lamports(10_000_000_000n));
  return key;
}

async function run(argv: string[], keys: Record<string, KeyPairSigner>, ledger: Device) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, { ...runtime(keys), ledger: ledger.open }, { out: (t) => out.push(t), err: (t) => err.push(t) });
  return { code, err: err.join("\n"), out: out.join("\n"), json: () => JSON.parse(out.join("\n")) as Record<string, unknown> };
}

async function panel(key: Key) {
  const w = await world();
  h.svm.airdrop(key.address, lamports(10_000_000_000n));
  const others = await Promise.all([0, 1].map(() => funded()));
  const keys: Record<string, KeyPairSigner> = { "m1.json": others[0] as KeyPairSigner, "m2.json": others[1] as KeyPairSigner, "payer.json": await funded() };
  const members = sortMembers([key.address, ...others.map((m) => m.address)]);
  const feeWallet = (await generateKeyPairSigner()).address;
  const create = ["committee", "create", "--keypair", "payer.json", "--members", members.join(","), "--threshold", "2", "--fee-wallet", feeWallet, "--yes"];
  const created = await run(create, keys, device(key, []));
  expect([created.code, created.err]).toEqual([EXIT_OK, ""]);
  const committee = created.json()["committee"] as Address;
  const client = createClient({ url: "http://cluster", transport });
  const params = { kind: Kind.AttestedResult, amountIn: PAY, minResult: 1n, maxResult: 1n, attestor: committee, specHash: new Uint8Array(32).fill(7), judgeFee: 0n } as const;
  const { intent } = await client.createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  const worker = await generateKeyPairSigner();
  const work = sha("work");
  const delivered: EngineTransaction = {
    signature: "first",
    slot: 5n,
    blockTime: null,
    failed: false,
    emitted: [],
    memos: [await sealedDelivery(intent, worker.address, work, "https://example.org/work", members)],
    feePayer: worker.address,
  };
  h.engineLog = [delivered, creation(intent)];
  const dir = await mkdtemp(join(tmpdir(), "cosign-"));
  const vote = (path: string, out: string) => ["committee", "vote", "--keypair", path, "--owner", w.owner.address, "--nonce", "0", "--pay-to", worker.address, "--result", "1", "--out", join(dir, out), "--yes"];
  const status = () => {
    const account = h.svm.getAccount(intent);
    return account.exists ? getIntentDecoder().decode(account.data).status : undefined;
  };
  const paid = async () => balance(await findAssociatedTokenAddress({ owner: worker.address, mint: w.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }));
  return { w, keys, members, committee, client, worker, work, dir, vote, status, paid };
}

describe("committee and split cosigners on a Ledger", () => {
  it("committee vote and committee release take a Ledger", () => {
    expect(LEDGER_COMMANDS).toEqual(expect.arrayContaining(["committee vote", "committee release"]));
    const owner = "11111111111111111111111111111111";
    const vote = ["committee", "vote", "--owner", owner, "--nonce", "0", "--pay-to", owner, "--result", "1"];
    const release = ["committee", "release", "--vote", "a.json", "--vote", "b.json"];
    for (const argv of [vote, release]) {
      expect(signsOnDevice(parse([...argv, "--keypair", "usb://ledger"])), argv.join(" ")).toBe(true);
    }
  });

  it("a member votes on the device over the envelope that lists every member, and the release settles", async () => {
    const key = await deviceKey();
    const p = await panel(key);
    const ballot = await p.client.committeeBallot({ owner: p.w.owner.address, nonce: 0n, payTo: p.worker.address, result: 1n });
    const voting = device(key, [...found(LEVELS, key), ...messageThen()]);
    const voted = await run(p.vote("usb://ledger", "a.json"), p.keys, voting);
    expect([voted.code, voted.err]).toEqual([EXIT_OK, ""]);
    voting.store.ensureQueueEmpty();
    const envelope = committeeEnvelope(ballot.digest, p.members);
    expect(voting.signed.map((s) => [s.kind, hex(s.bytes)])).toEqual([[MESSAGE, hex(envelope)]]);
    expect(hex(envelope.slice(18, 18 + 32 * 3))).toBe(hex(p.members.flatMap((m) => [...getAddressEncoder().encode(m)])));
    expect(JSON.parse(await readFile(join(p.dir, "a.json"), "utf8"))).toMatchObject({ kind: "committee-vote", member: key.address });
    const other = await run(p.vote("m1.json", "b.json"), p.keys, device(key, []));
    expect([other.code, other.err]).toEqual([EXIT_OK, ""]);
    const releasing = device(key, [...found(LEVELS, key), ...transactionThen(), ...transactionThen()]);
    const release = ["committee", "release", "--keypair", "usb://ledger", "--vote", join(p.dir, "a.json"), "--vote", join(p.dir, "b.json"), "--sha256", p.work, "--yes"];
    const sent = await run(release, p.keys, releasing);
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
    expect(releasing.signed.every((s) => s.kind === SIGN)).toBe(true);
    expect(p.status()).toBe(IntentStatus.Filled);
    expect(await p.paid()).toBeGreaterThan(0n);
  });

  it("a vote the device rejects writes nothing and the escrow stays open", async () => {
    const key = await deviceKey();
    const p = await panel(key);
    const rejecting = device(key, [...found(LEVELS, key), ...messageThen(REJECT)]);
    const refused = await run(p.vote("usb://ledger", "a.json"), p.keys, rejecting);
    expect([refused.code, refused.err, refused.out]).toEqual([EXIT_FAILED, LEDGER_ERRORS.rejected, ""]);
    rejecting.store.ensureQueueEmpty();
    await expect(readFile(join(p.dir, "a.json"), "utf8")).rejects.toThrow();
    expect(p.status()).toBe(IntentStatus.Open);
  });

  it("a co-author signs a split on the device and the program accepts the signature", async () => {
    const key = await deviceKey();
    const w = await world();
    const judge = await funded();
    const coauthor = await funded();
    const client = createClient({ url: "http://cluster", transport });
    const specHash = new Uint8Array(32).fill(9);
    const params = { kind: Kind.AttestedResult, amountIn: PAY, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash, judgeFee: 0n } as const;
    const { intent } = await client.createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
    const recipients = [key.address, coauthor.address];
    const weights = [7_000, 3_000];
    const accounts = await Promise.all(recipients.map((r) => ata(w.authority, r, w.inputMint)));
    await ata(w.authority, w.feeRecipient.address, w.inputMint);
    const fields = { domain: DOMAIN, intent, amountIn: PAY, result: 1n, maxFeeBps: FEE_BPS, specHash, splitHash: await splitCommit(recipients, weights) };
    const message = await attestedSplitMessage(fields, [...recipients, judge.address]);
    const ledger = device(key, [...found(LEVELS, key), ...messageThen()]);
    const onDevice = await ledgerSigner("usb://ledger", ledger.open);
    const entries = [
      { publicKey: key.address, signature: await signMessageBytes(onDevice, message) },
      { publicKey: coauthor.address, signature: await signMessageBytes(coauthor, message) },
      { publicKey: judge.address, signature: await signMessageBytes(judge, message) },
    ];
    ledger.store.ensureQueueEmpty();
    expect(ledger.signed.map((s) => hex(s.bytes))).toEqual([hex(message)]);
    const fill = await buildFillAttestedSplit({
      solver: judge,
      owner: w.owner.address,
      nonce: 0n,
      inputMint: w.inputMint,
      inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      recipients,
      weights,
      feeRecipient: w.feeRecipient.address,
      amountIn: PAY,
      result: 1n,
      maxFeeBps: FEE_BPS,
    });
    await send(judge, [buildEd25519CosignInstruction({ entries, message }), fill]);
    const paid = accounts.map(balance);
    expect(paid.every((amount) => amount > 0n)).toBe(true);
    expect(paid[0]).toBeGreaterThan(paid[1] ?? 0n);
    const view = h.svm.getAccount(intent);
    expect(view.exists ? getIntentDecoder().decode(view.data).status : undefined).toBe(IntentStatus.Filled);
  });
});
