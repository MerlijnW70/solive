import { type Address, generateKeyPairSigner, getBase16Decoder, getBase16Encoder, type KeyPairSigner, lamports, none, signBytes } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, findAssociatedTokenAddress, findIntentPda, formatAmount, NATIVE_MINT, RELEASE_MEMO_PREFIX } from "@intent-engine/core";
import { MEMO_PROGRAM_ADDRESS } from "@intent-engine/client";
import { tool } from "../src/agent/names.js";
import { PACKET_DATA_SIZE, WALLET_NOTICE } from "../src/agent/wallet.js";
import { EXIT_OK } from "../src/main.js";
import { sealedDelivery } from "./announce.js";
import { ata, balance, cli, creation, h, world } from "./harness.js";
import { paddedTransport, type Padding, walletServer } from "./pad-budget.js";

type Json = Record<string, unknown> & { [key: string]: any };

const WORK = "5a".repeat(32);
const SPEC = "5b".repeat(32);
const URL_OF_WORK = "https://" + "example.org/work";

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

async function connect(): Promise<Client> {
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
  return { error: result.isError === true, value: result.structuredContent as Json };
}

async function ok(client: Client, name: string, args: object = {}): Promise<Json> {
  const { error, value } = await call(client, name, args);
  expect(error, JSON.stringify(value)).toBe(false);
  return value;
}

const releaseMemoIn = (instructions: readonly { programAddress: Address; data?: ArrayLike<number> }[]) =>
  instructions.some((ix) => ix.programAddress === MEMO_PROGRAM_ADDRESS && new TextDecoder().decode(Uint8Array.from(ix.data ?? [])).startsWith(RELEASE_MEMO_PREFIX));

async function splitJob(terms: string[], before?: (authority: KeyPairSigner) => Promise<void>, padding?: Padding) {
  const w = await world();
  h.files.clear();
  preset(NATIVE_MINT);
  preset(DEVNET_TEST_MINT);
  await before?.(w.authority);
  const client = padding === undefined ? await connect() : await walletServer(paddedTransport(padding, releaseMemoIn));
  const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
  h.watched.push(wallet);
  const base = ["--units", "raw", "--amount-in", "1000", "--min-result", "1", "--max-result", "1", "--attestor", wallet, "--spec-hash", SPEC, "--nonce", "0"];
  const made = await cli(["create", "attested", "--keypair", "owner.json", "--input-mint", w.inputMint, "--output-mint", w.outputMint, "--expires-in", "3600", ...base, ...terms, "--yes"], { "owner.json": w.owner });
  expect([made.code, made.err]).toEqual([EXIT_OK, ""]);
  const [intent] = await findIntentPda({ owner: w.owner.address, nonce: 0n });
  const coauthor = await generateKeyPairSigner();
  h.engineLog = [creation(intent)];
  const split = { owner: w.owner.address, nonce: "0", recipients: [{ wallet: coauthor.address, weight: 10_000 }], delivered_sha256: WORK, received_outside_announcement: true };
  const signed = async (shown: Json) => {
    const envelope = Uint8Array.from(getBase16Encoder().encode(String(shown["envelope"])));
    const signature = getBase16Decoder().decode(new Uint8Array(await signBytes(coauthor.keyPair.privateKey, envelope)));
    return { ...split, recipients: [{ wallet: coauthor.address, weight: 10_000, signature }], approval: shown["approval"], send: true };
  };
  const tokenOf = (owner: Address) => findAssociatedTokenAddress({ owner, mint: w.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  return { w, client, wallet, intent, coauthor, split, signed, tokenOf };
}

describe("a single release's setup", () => {
  it("names the rent of every account it creates, the judge's own included", async () => {
    const s = await splitJob(["--judge-fee", "10"]);
    const worker = (await generateKeyPairSigner()).address;
    const shown = await ok(s.client, "wallet_attest", { owner: s.w.owner.address, nonce: "0", pay_to: worker, delivered_sha256: WORK, received_outside_announcement: true });
    const rent = `${formatAmount(h.svm.minimumBalanceForRentExemption(165n), 9)} SOL of rent`;
    expect(shown["summary"]).toContain(`Setup: creates ${worker}'s ${s.w.inputMint} account, paid by this wallet: ${rent}`);
    expect(shown["summary"]).toContain(`Setup: creates this wallet's ${s.w.inputMint} account for the judge fee, paid by this wallet: ${rent}`);
  });
});

describe("a split release's fees and setup", () => {
  it("covers a partner's fee in its bound, creates every missing account including the judge's, and says how many", async () => {
    const partner = (await generateKeyPairSigner()).address;
    const s = await splitJob(["--partner", partner, "--partner-bps", "50", "--judge-fee", "10"]);
    const shown = await ok(s.client, "wallet_attest_split", s.split);
    expect(shown["summary"]).toContain(`Setup: creates 4 token account(s), paid by this wallet: ${formatAmount(h.svm.minimumBalanceForRentExemption(165n), 9)} SOL of rent each, ${formatAmount(4n * h.svm.minimumBalanceForRentExemption(165n), 9)} SOL in all`);
    const sent = await ok(s.client, "wallet_attest_split", await s.signed(shown));
    expect(sent).toMatchObject({ sent: true });
    expect(balance(await s.tokenOf(partner))).toBe(5n);
    expect(balance(await s.tokenOf(s.wallet))).toBe(10n);
    expect(balance(await s.tokenOf(s.coauthor.address))).toBeGreaterThan(0n);
  });

  it("creates no fee or judge account when neither is paid, and says nothing of setup", async () => {
    const s = await splitJob([], async (authority) => {
      const zero = await cli(["update-config", "--keypair", "a.json", "--fee-bps", "0", "--yes"], { "a.json": authority });
      expect([zero.code, zero.err]).toEqual([EXIT_OK, ""]);
    });
    await ata(s.w.authority, s.coauthor.address, s.w.inputMint);
    const shown = await ok(s.client, "wallet_attest_split", s.split);
    expect((shown["summary"] as string[]).filter((line) => line.startsWith("Setup:"))).toEqual([]);
    expect(await ok(s.client, "wallet_attest_split", await s.signed(shown))).toMatchObject({ sent: true });
    expect(h.svm.getAccount(await s.tokenOf(s.w.feeRecipient.address)).exists).toBe(false);
    expect(h.svm.getAccount(await s.tokenOf(s.wallet)).exists).toBe(false);
  });
});

describe("where a split release records the delivered work", () => {
  it("puts the memo in the release while the two fit in one packet, up to its last byte", async () => {
    const s = await splitJob([]);
    await ata(s.w.authority, s.coauthor.address, s.w.inputMint);
    const shown = await ok(s.client, "wallet_attest_split", s.split);
    h.wires.length = 0;
    expect(await ok(s.client, "wallet_attest_split", await s.signed(shown))).toMatchObject({ sent: true, recorded: "release" });
    expect(h.wires).toHaveLength(1);

    const padding: Padding = { size: PACKET_DATA_SIZE };
    const t = await splitJob([], undefined, padding);
    await ata(t.w.authority, t.coauthor.address, t.w.inputMint);
    const full = await ok(t.client, "wallet_attest_split", t.split);
    h.wires.length = 0;
    expect(await ok(t.client, "wallet_attest_split", await t.signed(full))).toMatchObject({ sent: true, recorded: "release" });
    expect(h.wires).toHaveLength(1);
    expect(Buffer.from(h.wires[0] as string, "base64")).toHaveLength(PACKET_DATA_SIZE);
  });

  it("publishes the salts of earlier announcements after a release recorded in a follow-up", async () => {
    const s = await splitJob([]);
    const rival = (await generateKeyPairSigner()).address;
    h.engineLog = [
      { signature: "first", slot: 5n, blockTime: null, failed: false, emitted: [], memos: [await sealedDelivery(s.intent, s.coauthor.address, WORK, URL_OF_WORK, [s.wallet])], feePayer: s.coauthor.address },
      { signature: "rival", slot: 3n, blockTime: null, failed: false, emitted: [], memos: [await sealedDelivery(s.intent, rival, "5c".repeat(32), URL_OF_WORK, [s.wallet])], feePayer: rival },
      creation(s.intent),
    ];
    const shown = await ok(s.client, "wallet_attest_split", s.split);
    const sent = await ok(s.client, "wallet_attest_split", await s.signed(shown));
    expect(sent).toMatchObject({ sent: true, recorded: "follow-up", opening_signatures: [expect.any(String)] });
  });
});
