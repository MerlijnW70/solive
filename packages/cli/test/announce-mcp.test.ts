import { createHash } from "node:crypto";
import { type Address, getBase16Decoder, getBase58Decoder, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, findAssociatedTokenAddress, IntentStatus, NATIVE_MINT } from "@intent-engine/core";
import { checkAccountVersion, getCommitteeDecoder, signCommitteeVote, sortMembers } from "@intent-engine/core/internal";
import { createClient } from "@intent-engine/client/node";
import { svmTransport } from "@intent-engine/client/svm";
import { tool } from "../src/agent/names.js";
import { SYNC_FIRST, WALLET_NOTICE } from "../src/agent/wallet.js";
import { EXIT_OK, main } from "../src/main.js";
import { keyed } from "./announce.js";
import { balance, cli, DOMAIN, funded, h, runtime, transport, world } from "./harness.js";
import { approved } from "./approved.js";

type Json = Record<string, unknown> & { [key: string]: any };

const WORK_TEXT = "the delivered work\n";
const WORK = createHash("sha256").update(WORK_TEXT).digest("hex");
const WORK_URL = "https://" + "work.example.org/" + "c".repeat(32);

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

async function server(home: string): Promise<Client> {
  h.served.length = 0;
  const err: string[] = [];
  const code = await main(["mcp", "--url", "devnet", "--wallet", "--all-tools"], { ...runtime({}), home }, { out: () => undefined, err: (t) => err.push(t) });
  expect([code, err.join("\n")]).toEqual([EXIT_OK, WALLET_NOTICE.join("\n")]);
  const [near, far] = InMemoryTransport.createLinkedPair();
  await h.served[0]?.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return client;
}

async function ok(client: Client, name: string, args: object = {}): Promise<Json> {
  const result = await client.callTool({ name: tool(name), arguments: args as Record<string, unknown> });
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
  return result.structuredContent as Json;
}

async function sent(client: Client, name: string, args: object): Promise<Json> {
  const preview = await ok(client, name, args);
  expect(preview["sent"] ?? preview["signed"]).toBe(false);
  return ok(client, name, { ...args, ...(preview["approval"] === undefined ? {} : { approval: preview["approval"] }), send: true });
}

const hex = (bytes: Uint8Array) => getBase16Decoder().decode(bytes).toLowerCase();

function synced(committee: Address): boolean {
  const held = h.svm.getAccount(committee);
  return held.exists && getCommitteeDecoder().decode(checkAccountVersion(Uint8Array.from(held.data))).keysSynced === 1;
}

describe("the wallet tools through a job on announcements", () => {
  let judge: Client;
  let worker: Client;
  let judgeWallet: Address;
  let workerWallet: Address;

  beforeEach(async () => {
    await world();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    h.through = svmTransport(h.svm, { genesisHash: getBase58Decoder().decode(DOMAIN) });
    h.specPages.set(WORK_URL, new TextEncoder().encode(WORK_TEXT));
    judge = await server("/home/judge");
    judgeWallet = (await ok(judge, "wallet_setup"))["address"] as Address;
    worker = await server("/home/worker");
    workerWallet = (await ok(worker, "wallet_setup"))["address"] as Address;
    h.watched.push(judgeWallet);
  });

  const paid = async (wallet: Address) => balance(await findAssociatedTokenAddress({ owner: wallet, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS }));

  it("delivers, checks the delivery, fetches the work, attests and shows the receipt", async () => {
    const escrow = await ok(judge, "wallet_escrow", await approved(judge, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: judgeWallet, spec_hash: "6d".repeat(32) }));
    const intent = escrow["intent"] as Address;
    const delivered = await sent(worker, "wallet_deliver", { intent, sha256: WORK, url: WORK_URL });
    expect(delivered).toMatchObject({ sent: true, seq: "1", attestor: judgeWallet, sealed_to: [judgeWallet] });
    const checked = await ok(worker, "wallet_check_delivery", { intent });
    expect(checked).toMatchObject({ complete: true, next_seq: "2", mine: [{ announcement: delivered["announcement"], seq: "1", state: "announced", earlier: 0 }] });
    const fetched = await ok(judge, "wallet_fetch_work", { intent });
    expect(fetched).toMatchObject({ sha256: WORK, opens_commitment: true, untrusted_text: WORK_TEXT, first: { announcement: delivered["announcement"], worker: workerWallet } });
    const attested = await sent(judge, "wallet_attest", { owner: judgeWallet, nonce: escrow["nonce"], delivered_sha256: fetched["sha256"] });
    expect(attested).toMatchObject({ sent: true, pay_to: workerWallet, announcement: delivered["announcement"], seq: "1" });
    expect(await paid(workerWallet)).toBeGreaterThan(0n);
    const receipt = await ok(worker, "wallet_receipt", { owner: judgeWallet, nonce: escrow["nonce"], sha256: WORK });
    expect(receipt).toMatchObject({ released: true, matches: true, delivered_sha256: WORK, announcement: delivered["announcement"], announcer: workerWallet, paid_to: workerWallet, paid_this_wallet: true });
  });

  it("delivers to an unsynced committee, which the announcement syncs first, then a member votes and the votes release", async () => {
    const other = await keyed();
    const members = sortMembers([judgeWallet, other.address]);
    const payer = await funded();
    const created = await cli(["committee", "create", "--url", "devnet", "--keypair", "payer.json", "--members", members.join(","), "--threshold", "2", "--fee-wallet", payer.address, "--yes"], { "payer.json": payer });
    expect([created.code, created.err]).toEqual([EXIT_OK, ""]);
    const committee = created.json()["committee"] as Address;
    expect(synced(committee)).toBe(false);
    const escrow = await ok(judge, "wallet_escrow", await approved(judge, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: committee, spec_hash: "6d".repeat(32) }));
    const intent = escrow["intent"] as Address;
    const preview = await ok(worker, "wallet_deliver", { intent, sha256: WORK, url: WORK_URL });
    expect(preview["next"]).toContain(SYNC_FIRST);
    const delivered = await ok(worker, "wallet_deliver", { intent, sha256: WORK, url: WORK_URL, send: true });
    expect(delivered).toMatchObject({ sent: true, seq: "1", sealed_to: members });
    expect(synced(committee)).toBe(true);
    const fetched = await ok(judge, "wallet_fetch_work", { intent });
    expect(fetched).toMatchObject({ sha256: WORK, first: { announcement: delivered["announcement"], worker: workerWallet } });
    const ballot = { owner: judgeWallet, nonce: escrow["nonce"], result: "1", delivered_sha256: WORK };
    const voted = await sent(judge, "wallet_committee_vote", ballot);
    expect(voted).toMatchObject({ signed: true, announcement: delivered["announcement"], worker: workerWallet, vote: { member: judgeWallet } });
    const client = createClient({ url: "http://cluster", transport: h.through ?? transport });
    const first = await client.firstOpening({ intent, sha256: WORK, keypair: h.keypairs.get(other.address) });
    const theirs = await client.committeeBallot({ intent: { owner: judgeWallet, nonce: BigInt(escrow["nonce"] as string) }, announcement: first.announcement, opening: first, result: 1n });
    const signed = await signCommitteeVote(other, theirs.digest, theirs.committee.members);
    const votes = [voted["vote"], { member: signed.member, signature: hex(signed.signature) }];
    const released = await sent(judge, "wallet_committee_release", { ...ballot, votes });
    expect(released).toMatchObject({ sent: true, announcement: delivered["announcement"], worker: workerWallet });
    expect(await paid(workerWallet)).toBeGreaterThan(0n);
    expect((await client.intent({ owner: judgeWallet, nonce: BigInt(escrow["nonce"] as string) }))?.intent.status).toBe(IntentStatus.Filled);
  });
});
