import { type Address, generateKeyPairSigner, getAddressEncoder, getBase16Decoder, type KeyPairSigner, lamports, signBytes } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import type { Client } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { findAssociatedTokenAddress, formatAmount, IntentStatus, NATIVE_MINT } from "@intent-engine/core";
import { splitFee, splitN } from "@intent-engine/core/internal";
import { createClient } from "@intent-engine/client/node";
import { LOOKUP_TABLE_HEADER } from "@intent-engine/solver";
import { COSIGN_NEEDED, NOT_A_MEMBER, SIGNS_AT_SEND, SINGLE_JUDGED, SPLIT_VOTE_NEXT, VOTE_CHANGED } from "../src/agent/wallet/committee-split.js";
import { defaultWallet, LAMPORTS_PER_SOL } from "../src/wallet.js";
import { bytesOf, call, fresh, type Json, ok } from "./agent-wallet-kit.js";
import { announced, keyed } from "./announce.js";
import { balance, funded, h, HOME, transport } from "./harness.js";
import { approved, UNJUDGED } from "./approved.js";
import { judgedBy } from "./receipt-kit.js";

const ADDRESS_LOOKUP_TABLE_PROGRAM = "AddressLookupTab1e1111111111111111111111111" as Address;
const WEIGHTS = [6_000, 4_000];
const SHARES = splitN(splitFee(LAMPORTS_PER_SOL / 20n, 5).net, WEIGHTS);

const paidTo = async (wallet: Address) => balance(await findAssociatedTokenAddress({ owner: wallet, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS }));

const useKey = (signer: KeyPairSigner): void => {
  h.files.set(defaultWallet(HOME), JSON.stringify(Array.from(h.keypairs.get(signer.address) ?? [])));
};

const signedOver = async (signer: KeyPairSigner, envelope: string) => getBase16Decoder().decode(new Uint8Array(await signBytes(signer.keyPair.privateKey, bytesOf(envelope))));

const shareLines = (recipients: readonly { wallet: Address; weight: number }[]) => recipients.map((r, i) => `  ${r.wallet}: ${r.weight} bps -> ${formatAmount(SHARES[i] ?? 0n, 9)} of SOL`);

function lookupTable(addresses: readonly Address[], table: Address): void {
  const header = new Uint8Array(LOOKUP_TABLE_HEADER);
  const view = new DataView(header.buffer);
  view.setUint32(0, 1, true);
  view.setBigUint64(4, 0xffff_ffff_ffff_ffffn, true);
  header[20] = addresses.length;
  const data = Uint8Array.from([...header, ...addresses.flatMap((address) => [...getAddressEncoder().encode(address)])]);
  h.svm.setAccount({ address: table, data, executable: false, lamports: lamports(h.svm.minimumBalanceForRentExemption(BigInt(data.length))), programAddress: ADDRESS_LOOKUP_TABLE_PROGRAM, space: BigInt(data.length) });
}

describe("the wallet server's committee-judged split releases", () => {
  let client: Client;

  beforeEach(async () => {
    client = await fresh();
  });

  async function committeeSplit(work: string, outsider: boolean, releaser = false) {
    const lead = (await ok(client, "wallet_setup"))["address"] as Address;
    const leadKey = h.files.get(defaultWallet(HOME)) ?? "";
    h.watched.push(lead);
    const [peer, third, coauthor] = await Promise.all([funded(), funded(), keyed()]);
    const terms = { members: outsider ? [lead, peer.address, third.address] : [lead, peer.address], threshold: releaser ? 1 : 2 };
    const created = await ok(client, "wallet_committee_create", terms);
    await ok(client, "wallet_committee_create", { ...terms, approval: created["approval"], send: true });
    const committee = created["committee"] as Address;
    const escrow = await ok(client, "wallet_escrow", await approved(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: committee, spec_hash: "5c".repeat(32) }));
    const intent = escrow["intent"] as Address;
    const worker = await keyed();
    const made = await announced(intent, worker, work);
    const at = { owner: lead, nonce: BigInt(escrow["nonce"] as string), intent, specSha256: "5c".repeat(32), deliveredSha256: work, announcement: made.announcement };
    const recipients = [
      { wallet: worker.address, weight: WEIGHTS[0] as number },
      { wallet: releaser ? lead : outsider ? coauthor.address : peer.address, weight: WEIGHTS[1] as number },
    ];
    const ballot = { owner: lead, nonce: escrow["nonce"] as string, result: "1", delivered_sha256: work, recipients };
    const restore = () => h.files.set(defaultWallet(HOME), leadKey);
    return { lead, peer, coauthor, committee, intent, worker, recipients, ballot, restore, at };
  }

  const signedVote = async (ballot: object) => {
    const shown = await ok(client, "wallet_committee_vote", { ...UNJUDGED, ...ballot });
    const signed = await ok(client, "wallet_committee_vote", { ...UNJUDGED, ...ballot, approval: shown["approval"], send: true });
    return { shown, vote: signed["vote"] as { member: Address; signature: string } };
  };

  it("previews the shares, takes each member's vote over the split, counts a member's vote as its co-author signature, and pays every co-author its weight", async () => {
    const s = await committeeSplit("e1".repeat(32), false);
    const { shown, vote: leadVote } = await signedVote(s.ballot);
    expect(shown).toMatchObject({ intent: s.intent, committee: s.committee, worker: s.worker.address, signed: false, next: SPLIT_VOTE_NEXT });
    expect((shown["paid"] as Json[]).map((p) => p["amount"])).toEqual(SHARES.map((a) => formatAmount(a, 9)));
    expect(shown["summary"]).toEqual(expect.arrayContaining(shareLines(s.recipients)));
    useKey(s.peer);
    const { vote: peerVote } = await signedVote(s.ballot);
    expect(peerVote.member).toBe(s.peer.address);
    useKey(await funded());
    expect((await call(client, "wallet_committee_vote", { ...UNJUDGED, ...s.ballot })).value).toMatchObject({ code: "Unauthorized", hint: NOT_A_MEMBER });
    s.restore();

    const envelope = shown["envelope"] as string;
    const recipients = [{ ...s.recipients[0], signature: await signedOver(s.worker, envelope) }, { ...s.recipients[1] }];
    const base = { ...s.ballot, votes: [peerVote, leadVote] };
    expect((await call(client, "wallet_committee_release", { ...base, recipients: s.recipients })).value).toMatchObject({
      code: "InvalidInput",
      issues: [{ path: "recipients.0.signature", message: COSIGN_NEEDED }],
    });
    const lone = { ...base, votes: [leadVote, leadVote], recipients: [recipients[0], { ...recipients[1], signature: peerVote.signature }] };
    expect((await call(client, "wallet_committee_release", lone)).value).toMatchObject({ untrustedDetail: expect.stringContaining("needs 2 distinct votes, got 1") });
    const forged = [{ ...recipients[0], signature: peerVote.signature }, { ...recipients[1] }];
    expect((await call(client, "wallet_committee_release", { ...base, recipients: forged })).value).toMatchObject({ code: "SigMessage" });
    const preview = await ok(client, "wallet_committee_release", { ...base, recipients });
    expect(preview).toMatchObject({ intent: s.intent, committee: s.committee, sent: false, envelope });
    expect([...(preview["signers"] as Address[])].sort()).toEqual([s.lead, s.peer.address].sort());
    expect((preview["paid"] as Json[]).map((p) => p["amount"])).toEqual(SHARES.map((a) => formatAmount(a, 9)));
    expect(preview["summary"]).toEqual(expect.arrayContaining(shareLines(s.recipients)));
    h.packetLimit = true;
    const released = await ok(client, "wallet_committee_release", { ...base, recipients, approval: preview["approval"], send: true });
    expect(released).toMatchObject({ sent: true, signature: expect.any(String) });
    expect([await paidTo(s.worker.address), await paidTo(s.peer.address)]).toEqual(SHARES);
    const settled = await createClient({ url: "http://cluster", transport }).intent({ owner: s.lead, nonce: BigInt(s.ballot.nonce) });
    expect(settled?.intent.status).toBe(IntentStatus.Filled);
  });

  it("refuses a release over the packet limit and sends it with a lookup table of the preview's lookup_accounts", async () => {
    const s = await committeeSplit("e3".repeat(32), true);
    const { shown, vote: leadVote } = await signedVote(s.ballot);
    useKey(s.peer);
    const { vote: peerVote } = await signedVote(s.ballot);
    s.restore();
    const envelope = shown["envelope"] as string;
    const recipients = [
      { ...s.recipients[0], signature: await signedOver(s.worker, envelope) },
      { ...s.recipients[1], signature: await signedOver(s.coauthor, envelope) },
    ];
    const base = { ...s.ballot, votes: [leadVote, peerVote], recipients };
    const preview = await ok(client, "wallet_committee_release", base);
    expect(preview["summary"]).toEqual(expect.arrayContaining([expect.stringMatching(/^Too large: /)]));
    expect((await call(client, "wallet_committee_release", { ...base, approval: preview["approval"], send: true })).value).toMatchObject({ code: "ReleaseTooLarge" });
    expect(await paidTo(s.worker.address)).toBeLessThan(1n);
    const lookups = preview["lookup_accounts"] as Address[];
    expect(lookups).toContain(s.committee);
    const table = (await generateKeyPairSigner()).address;
    lookupTable(lookups, table);
    const tabled = await ok(client, "wallet_committee_release", { ...base, lookup_table: table });
    expect(tabled["summary"]).not.toEqual(expect.arrayContaining([expect.stringMatching(/^Too large: /)]));
    h.packetLimit = true;
    expect(await ok(client, "wallet_committee_release", { ...base, lookup_table: table, approval: tabled["approval"], send: true })).toMatchObject({ sent: true });
    expect([await paidTo(s.worker.address), await paidTo(s.coauthor.address)]).toEqual(SHARES);
  });

  it("signs nothing in a preview when the releasing wallet is a co-author that did not vote, and signs its share only on send", async () => {
    const s = await committeeSplit("e4".repeat(32), false, true);
    useKey(s.peer);
    const { shown, vote: peerVote } = await signedVote(s.ballot);
    s.restore();
    const recipients = [{ ...s.recipients[0], signature: await signedOver(s.worker, shown["envelope"] as string) }, { ...s.recipients[1] }];
    const base = { ...s.ballot, votes: [peerVote], recipients };
    expect((await call(client, "wallet_committee_release", base)).value).toMatchObject({ code: "NoJudgeReceipt" });
    await judgedBy([s.peer.address], s.at);
    expect((await call(client, "wallet_committee_release", base)).value).toMatchObject({ code: "NoJudgeReceipt" });
    await judgedBy([s.lead], s.at);
    const signing = vi.spyOn(globalThis.crypto.subtle, "sign");
    const preview = await ok(client, "wallet_committee_release", base);
    const signedBytes = () => signing.mock.calls.map((call) => Buffer.from(call[2] as ArrayBuffer).toString("hex"));
    expect(signedBytes()).not.toContain(shown["envelope"]);
    expect(preview).toMatchObject({ sent: false, signers: [s.peer.address] });
    expect(preview).not.toHaveProperty("prepared");
    expect(preview["summary"]).toContain(SIGNS_AT_SEND);
    expect((await call(client, "wallet_committee_release", { ...base, approval: "00".repeat(8), send: true })).value).toMatchObject({ code: "ReleaseChanged" });
    expect(signedBytes()).not.toContain(shown["envelope"]);
    expect(await paidTo(s.worker.address)).toBeLessThan(1n);
    expect(preview["summary"]).toEqual(expect.arrayContaining(shareLines(s.recipients)));
    h.packetLimit = true;
    expect(await ok(client, "wallet_committee_release", { ...base, approval: preview["approval"], send: true })).toMatchObject({ sent: true });
    expect(signedBytes()).toContain(shown["envelope"]);
    signing.mockRestore();
    expect([await paidTo(s.worker.address), await paidTo(s.lead)]).toEqual(SHARES);
  });

  it("refuses a split vote with a wrong or missing approval and signs nothing, then signs the same vote with the right one", async () => {
    const s = await committeeSplit("e5".repeat(32), false);
    const shown = await ok(client, "wallet_committee_vote", { ...UNJUDGED, ...s.ballot });
    const envelope = shown["envelope"] as string;
    const signing = vi.spyOn(globalThis.crypto.subtle, "sign");
    const signedBytes = () => signing.mock.calls.map((entry) => Buffer.from(entry[2] as ArrayBuffer).toString("hex"));
    for (const approval of ["00".repeat(8), undefined]) {
      const refused = await call(client, "wallet_committee_vote", { ...UNJUDGED, ...s.ballot, approval, send: true });
      expect(refused.value).toMatchObject({ code: "ReleaseChanged", hint: VOTE_CHANGED });
      expect(signedBytes()).not.toContain(envelope);
    }
    const signed = await ok(client, "wallet_committee_vote", { ...UNJUDGED, ...s.ballot, approval: shown["approval"], send: true });
    expect(signed).toMatchObject({ signed: true, vote: { member: s.lead } });
    expect(signedBytes()).toContain(envelope);
    signing.mockRestore();
  });

  it("refuses a split vote on an escrow a single key judges", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    h.watched.push(owner);
    const escrow = await ok(client, "wallet_escrow", await approved(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: owner, spec_hash: "5d".repeat(32) }));
    const worker = await keyed();
    const work = "e2".repeat(32);
    await announced(escrow["intent"] as Address, worker, work);
    const ballot = { owner, nonce: escrow["nonce"], result: "1", delivered_sha256: work, recipients: [{ wallet: worker.address, weight: 10_000 }] };
    expect((await call(client, "wallet_committee_vote", { ...UNJUDGED, ...ballot })).value).toMatchObject({ code: "KindMismatch", hint: SINGLE_JUDGED });
  });
});
