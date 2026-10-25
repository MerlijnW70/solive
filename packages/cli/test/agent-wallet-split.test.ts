import { type Address, generateKeyPairSigner, getAddressEncoder, getBase16Decoder, getBase64Encoder, getCompiledTransactionMessageDecoder, getTransactionDecoder, type KeyPairSigner, lamports, signBytes } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import type { Client } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it } from "vitest";
import { findAssociatedTokenAddress, formatAmount, IntentStatus, NATIVE_MINT } from "@intent-engine/core";
import {
  buildEd25519CosignInstruction,
  buildFillAttestedSplit,
  computeUnitLimit,
  cosignEnvelope,
  getIntentDecoder,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  MAX_COMPUTE_UNITS,
  splitFee,
  splitN,
} from "@intent-engine/core/internal";
import { loadAnnouncement, loadConfig } from "@intent-engine/client/internal";
import { LOOKUP_TABLE_HEADER } from "@intent-engine/solver";
import { transactionSize } from "../src/agent/prepare.js";
import { notInSplit, PACKET_DATA_SIZE, RELEASE_CHANGED, SPLIT_FITS, SPLIT_FITS_WITH_TABLE } from "../src/agent/wallet.js";
import { LAMPORTS_PER_SOL } from "../src/wallet.js";
import { bytesOf, call, fresh, type Json, ok } from "./agent-wallet-kit.js";
import { announced, keyed } from "./announce.js";
import { NO_BOOK } from "../src/agent/wallet/openings.js";
import { ata, balance, FEE_BPS, funded, h, transport } from "./harness.js";
import { approved } from "./approved.js";

const ADDRESS_LOOKUP_TABLE_PROGRAM = "AddressLookupTab1e1111111111111111111111111" as Address;

const paidTo = async (wallet: Address) => balance(await findAssociatedTokenAddress({ owner: wallet, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS }));

const signedBy = async (recipients: { wallet: Address; weight: number }[], coauthors: KeyPairSigner[], envelope: string) =>
  Promise.all(recipients.map(async (r, i) => ({ ...r, signature: getBase16Decoder().decode(new Uint8Array(await signBytes(coauthors[i]!.keyPair.privateKey, bytesOf(envelope)))) })));

const lookupsOf = (wire: string): Address[] => {
  const message = getCompiledTransactionMessageDecoder().decode(getTransactionDecoder().decode(getBase64Encoder().encode(wire)).messageBytes);
  return "addressTableLookups" in message ? (message.addressTableLookups ?? []).map((lookup) => lookup.lookupTableAddress) : [];
};

async function releaseSize(recipients: number, withTable: boolean): Promise<number> {
  const judge = await generateKeyPairSigner();
  const signers = await Promise.all(Array.from({ length: recipients }, () => generateKeyPairSigner()));
  const wallets = signers.map((s) => s.address);
  const weights = wallets.map((_, i) => (i === 0 ? 10_000 - Math.floor(10_000 / recipients) * (recipients - 1) : Math.floor(10_000 / recipients)));
  const owner = (await generateKeyPairSigner()).address;
  const feeRecipient = (await generateKeyPairSigner()).address;
  const settle = await buildFillAttestedSplit({
    solver: judge,
    owner,
    nonce: 1n,
    inputMint: NATIVE_MINT,
    inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
    recipients: wallets,
    weights,
    feeRecipient,
    judge: judge.address,
    announcement: (await generateKeyPairSigner()).address,
    opening: { delivered: new Uint8Array(32), salt: new Uint8Array(16) },
    amountIn: LAMPORTS_PER_SOL,
    result: 1n,
    maxFeeBps: FEE_BPS,
  });
  const message = cosignEnvelope([...wallets, judge.address], new Uint8Array(32));
  const batch = buildEd25519CosignInstruction({ entries: [...wallets, judge.address].map((publicKey) => ({ publicKey, signature: new Uint8Array(64) })), message });
  const instructions = [batch, settle, computeUnitLimit(MAX_COMPUTE_UNITS)];
  const invoked = new Set<Address>([INTENT_ENGINE_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS, judge.address]);
  const table = withTable ? { [(await generateKeyPairSigner()).address]: [...new Set((settle.accounts ?? []).map((a) => a.address))].filter((a) => !invoked.has(a)) } : undefined;
  return transactionSize(transport, instructions, judge.address, table);
}

describe("the wallet server's split releases", () => {
  let client: Client;

  beforeEach(async () => {
    client = await fresh();
  });

  async function splitEscrow(work: string, weights: readonly number[] = [5000, 5000]) {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    h.watched.push(owner);
    const escrow = await ok(client, "wallet_escrow", await approved(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: owner, min_result: "1", max_result: "1", spec_hash: "4b".repeat(32) }));
    const intent = escrow["intent"] as Address;
    const coauthors = await Promise.all(weights.map(() => keyed()));
    const recipients = coauthors.map((c, i) => ({ wallet: c.address, weight: weights[i] as number }));
    return { owner, intent, nonce: escrow["nonce"] as string, coauthors, recipients, work };
  }

  async function cosigned(work: string, payer: KeyPairSigner, weights?: readonly number[], createdByRelease = 0) {
    const made = await splitEscrow(work, weights);
    for (const c of made.coauthors.slice(createdByRelease)) {
      await ata(payer, c.address, NATIVE_MINT);
    }
    await announced(made.intent, made.coauthors[0] as KeyPairSigner, work);
    const preview = await ok(client, "wallet_attest_split", { owner: made.owner, nonce: made.nonce, recipients: made.recipients, delivered_sha256: work });
    const signed = await signedBy(made.recipients, made.coauthors, preview["envelope"] as string);
    return { ...made, lookupAccounts: preview["lookup_accounts"] as Address[], release: { owner: made.owner, nonce: made.nonce, recipients: signed, delivered_sha256: work, approval: preview["approval"], send: true } };
  }

  async function withFeeAccount(): Promise<KeyPairSigner> {
    const payer = await funded();
    const { config } = await loadConfig(transport);
    await ata(payer, config.feeRecipient, NATIVE_MINT);
    return payer;
  }

  it("releases a proof escrow split among co-authors only when every one of them signs the exact split", async () => {
    const work = "ab".repeat(32);
    const { owner, intent, nonce, coauthors, recipients } = await splitEscrow(work, [10_000]);
    const made = await announced(intent, coauthors[0] as KeyPairSigner, work);
    const { net } = splitFee(LAMPORTS_PER_SOL / 20n, FEE_BPS);
    const payout = splitN(net, [10_000]);
    const base = { owner, nonce, delivered_sha256: work };
    expect((await call(client, "wallet_attest_split", { ...base, recipients: [{ ...recipients[0], weight: 5000 }] })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "recipients" }] });
    const shown = await ok(client, "wallet_attest_split", { ...base, recipients });
    expect(shown).toMatchObject({ intent, announcement: made.announcement, seq: "1", result: "1", net: formatAmount(net, 9), delivered_sha256: work, sent: false });
    expect((shown["paid"] as Json[]).map((p) => p["amount"])).toEqual(payout.map((a) => formatAmount(a, 9)));
    expect(shown["digest"]).toMatch(/^[0-9a-f]{64}$/);
    const lookupAccounts = shown["lookup_accounts"] as string[];
    expect(lookupAccounts.length).toBeGreaterThan(0);
    expect(lookupAccounts).not.toContain(INTENT_ENGINE_PROGRAM_ADDRESS);
    expect(lookupAccounts).toContain(intent);
    expect(lookupAccounts).toContain(made.announcement);
    const signed = await signedBy(recipients, coauthors, shown["envelope"] as string);
    expect((await call(client, "wallet_attest_split", { ...base, recipients: signed, send: true })).value).toMatchObject({ code: "ReleaseChanged", hint: RELEASE_CHANGED });
    const missing = signed.map((s) => ({ wallet: s.wallet, weight: s.weight }));
    expect((await call(client, "wallet_attest_split", { ...base, recipients: missing, approval: shown["approval"], send: true })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "recipients.0.signature" }] });
    const absentTable = (await generateKeyPairSigner()).address;
    expect((await call(client, "wallet_attest_split", { ...base, recipients: signed, lookup_table: absentTable, approval: shown["approval"], send: true })).value).toMatchObject({ code: "NotFound" });
    const done = await ok(client, "wallet_attest_split", { ...base, recipients: signed, approval: shown["approval"], send: true });
    expect(done).toMatchObject({ sent: true, signature: expect.any(String) });
    expect(await paidTo(coauthors[0]!.address)).toBe(payout[0]!);
    expect((await loadAnnouncement(transport, made.announcement))?.state).toBe("paid");
    expect((await call(client, "wallet_attest_split", { ...base, recipients: signed, approval: shown["approval"], send: true })).value).toMatchObject({ code: "InvalidTransition" });
    const plain = await ok(client, "wallet_escrow", await approved(client, "wallet_escrow", { sell: "SOL", amount: "0.02", attestor: owner, min_result: "1", max_result: "1" }));
    expect((await call(client, "wallet_attest_split", { owner, nonce: plain["nonce"], recipients, delivered_sha256: work })).value).toMatchObject({ code: "NotAProof" });
  });

  it("refuses a split without a valid delivered_sha256, or before any announcement opens to it", async () => {
    const work = "c1".repeat(32);
    const { owner, nonce, recipients } = await splitEscrow(work);
    expect((await call(client, "wallet_attest_split", { owner, nonce, recipients })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "delivered_sha256" }] });
    expect((await call(client, "wallet_attest_split", { owner, nonce, recipients, delivered_sha256: "xyz" })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "delivered_sha256" }] });
    expect((await call(client, "wallet_attest_split", { owner, nonce, recipients, delivered_sha256: work })).value).toMatchObject({ code: "NotAnnounced", hint: expect.stringContaining(NO_BOOK) });
  });

  it("refuses a split that leaves out the worker of the first announcement that opens to the work", async () => {
    const work = "c2".repeat(32);
    const { owner, intent, nonce, recipients, coauthors } = await splitEscrow(work);
    const outsider = await keyed();
    await announced(intent, outsider, work);
    await announced(intent, coauthors[0] as KeyPairSigner, work);
    expect((await call(client, "wallet_attest_split", { owner, nonce, recipients, delivered_sha256: work })).value).toMatchObject({
      code: "NotEarliestAnnouncer",
      hint: notInSplit(outsider.address, work),
    });
    const including = [{ ...recipients[0], weight: 4000 }, { wallet: outsider.address, weight: 6000 }];
    expect(await ok(client, "wallet_attest_split", { owner, nonce, recipients: including, delivered_sha256: work })).toMatchObject({ sent: false, delivered_sha256: work });
  });

  it("a two co-author split release fits without a lookup table and four fit with one", async () => {
    expect(await releaseSize(SPLIT_FITS, false)).toBeLessThanOrEqual(PACKET_DATA_SIZE);
    expect(await releaseSize(SPLIT_FITS + 1, false)).toBeGreaterThan(PACKET_DATA_SIZE);
    expect(await releaseSize(SPLIT_FITS_WITH_TABLE, true)).toBeLessThanOrEqual(PACKET_DATA_SIZE);
    expect(await releaseSize(SPLIT_FITS_WITH_TABLE + 1, true)).toBeGreaterThan(PACKET_DATA_SIZE);
    const payer = await withFeeAccount();
    const split = await cosigned("d1".repeat(32), payer);
    h.wires.length = 0;
    expect(await ok(client, "wallet_attest_split", split.release)).toMatchObject({ sent: true, signature: expect.any(String) });
    expect(h.wires).toHaveLength(1);
    for (const c of split.coauthors) {
      expect(await paidTo(c.address)).toBeGreaterThan(0n);
    }
    const held = h.svm.getAccount(split.intent);
    expect(held.exists && getIntentDecoder().decode(held.data).status).toBe(IntentStatus.Filled);
  });

  it("creates a missing co-author account in its own transaction before the release, keeping every simulation within the packet limit", async () => {
    const payer = await withFeeAccount();
    const split = await cosigned("d5".repeat(32), payer, undefined, 1);
    h.packetLimit = true;
    h.simulated.length = 0;
    h.wires.length = 0;
    const sent = (await call(client, "wallet_attest_split", split.release)).value;
    expect(sent).toMatchObject({ sent: true });
    expect(h.wires).toHaveLength(2);
    expect(h.simulated.every((wire) => getBase64Encoder().encode(wire).length <= PACKET_DATA_SIZE)).toBe(true);
    const held = h.svm.getAccount(split.intent);
    expect(held.exists && getIntentDecoder().decode(held.data).status).toBe(IntentStatus.Filled);
  });

  it("a split sent with a lookup table is simulated with the table", async () => {
    const work = "d6".repeat(32);
    const payer = await withFeeAccount();
    const split = await cosigned(work, payer, [4000, 3000, 3000]);
    const table = (await generateKeyPairSigner()).address;
    const header = new Uint8Array(LOOKUP_TABLE_HEADER);
    const view = new DataView(header.buffer);
    view.setUint32(0, 1, true);
    view.setBigUint64(4, 0xffff_ffff_ffff_ffffn, true);
    header[20] = split.lookupAccounts.length;
    const data = Uint8Array.from([...header, ...split.lookupAccounts.flatMap((address) => [...getAddressEncoder().encode(address)])]);
    h.svm.setAccount({ address: table, data, executable: false, lamports: lamports(h.svm.minimumBalanceForRentExemption(BigInt(data.length))), programAddress: ADDRESS_LOOKUP_TABLE_PROGRAM, space: BigInt(data.length) });
    expect((await call(client, "wallet_attest_split", split.release)).value).toMatchObject({ code: "ReleaseTooLarge" });
    h.packetLimit = true;
    h.simulated.length = 0;
    expect(await ok(client, "wallet_attest_split", { ...split.release, lookup_table: table })).toMatchObject({ sent: true, delivered_sha256: work });
    const releases = h.simulated.filter((wire) => lookupsOf(wire).length > 0);
    expect(releases.length).toBeGreaterThanOrEqual(1);
    expect(releases.every((wire) => lookupsOf(wire).every((address) => address === table))).toBe(true);
    expect(h.simulated.every((wire) => getBase64Encoder().encode(wire).length <= PACKET_DATA_SIZE)).toBe(true);
    for (const c of split.coauthors) {
      expect(await paidTo(c.address)).toBeGreaterThan(0n);
    }
  });
});
