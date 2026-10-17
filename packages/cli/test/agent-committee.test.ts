import { type Address, generateKeyPairSigner, getBase16Decoder, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import {
  DEVNET_TEST_MINT as TEST_TOKEN,
  deliveryMemo,
  findAssociatedTokenAddress,
  IntentStatus,
  NATIVE_MINT,
  signCommitteeVote,
  sortMembers,
} from "@intent-engine/core";
import { createClient } from "@intent-engine/client";
import { NOT_A_MEMBER, RELEASE_CHANGED, VOTE_CHANGED, WALLET_NOTICE } from "../src/agent/wallet.js";
import { notEarliest } from "../src/agent/wallet/delivery.js";
import { EXIT_OK } from "../src/main.js";
import { balance, cli, creation, funded, h, transport, world } from "./harness.js";

type Json = Record<string, unknown> & { [key: string]: any };

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
  const server = h.served[0];
  if (server === undefined) {
    throw new Error("no server was started");
  }
  const [near, far] = InMemoryTransport.createLinkedPair();
  await server.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return client;
}

async function call(client: Client, name: string, args: object = {}) {
  const result = await client.callTool({ name: `solive_${name}`, arguments: args as Record<string, unknown> });
  return { error: result.isError === true, value: result.structuredContent as Json };
}

async function ok(client: Client, name: string, args: object = {}): Promise<Json> {
  const { error, value } = await call(client, name, args);
  expect(error, JSON.stringify(value)).toBe(false);
  return value;
}

const hex = (bytes: Uint8Array) => getBase16Decoder().decode(bytes).toLowerCase();

describe("a wallet server on a committee", () => {
  let client: Client;

  beforeEach(async () => {
    await world();
    h.files.clear();
    for (const name of Object.keys(h.env)) {
      delete h.env[name];
    }
    preset(NATIVE_MINT);
    preset(TEST_TOKEN);
    client = await connect();
  });

  async function committeeEscrow(includeWallet: boolean) {
    const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
    h.watched.push(wallet);
    h.engineLog = [];
    const other = await generateKeyPairSigner();
    const third = await generateKeyPairSigner();
    const payer = await funded();
    const members = sortMembers([includeWallet ? wallet : third.address, other.address]);
    const created = await cli(
      ["committee", "create", "--url", "devnet", "--keypair", "payer.json", "--members", members.join(","), "--threshold", "2", "--fee-wallet", payer.address, "--yes"],
      { "payer.json": payer },
    );
    expect([created.code, created.err]).toEqual([EXIT_OK, ""]);
    const committee = created.json()["committee"] as Address;
    const specHash = "6d".repeat(32);
    const escrow = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: committee, spec_hash: specHash, send: true });
    const intent = escrow["intent"] as Address;
    const worker = (await generateKeyPairSigner()).address;
    const copier = (await generateKeyPairSigner()).address;
    const work = "e7".repeat(32);
    const memo = deliveryMemo({ intent, sha256: work, url: "https://example.org/work" });
    h.engineLog = [
      { signature: "copy", slot: 9n, blockTime: null, failed: false, emitted: [], memos: [memo], feePayer: copier },
      { signature: "first", slot: 5n, blockTime: null, failed: false, emitted: [], memos: [memo], feePayer: worker },
      creation(intent),
    ];
    const ballot = { owner: wallet, nonce: escrow["nonce"] as string, pay_to: worker, result: "1", delivered_sha256: work };
    return { wallet, other, committee, intent, worker, copier, work, ballot };
  }

  it("votes after a preview, and releases once the threshold of votes is in", async () => {
    const e = await committeeEscrow(true);
    expect((await call(client, "wallet_committee_vote", { ...e.ballot, pay_to: e.copier })).value).toMatchObject({
      code: "NotEarliestAnnouncer",
      hint: notEarliest(e.worker, e.work),
    });
    const preview = await ok(client, "wallet_committee_vote", e.ballot);
    expect(preview).toMatchObject({ intent: e.intent, committee: e.committee, signed: false });
    expect(preview).not.toHaveProperty("vote");
    expect((await call(client, "wallet_committee_vote", { ...e.ballot, result: "1", send: true })).value).toMatchObject({
      code: "ReleaseChanged",
      hint: VOTE_CHANGED,
    });
    const voted = await ok(client, "wallet_committee_vote", { ...e.ballot, approval: preview["approval"], send: true });
    expect(voted).toMatchObject({ signed: true, vote: { member: e.wallet } });
    const own = voted["vote"] as { member: Address; signature: string };
    const ballot = await createClient({ url: "http://cluster", transport }).committeeBallot({
      owner: e.wallet,
      nonce: BigInt(e.ballot.nonce),
      payTo: e.worker,
      result: 1n,
    });
    const theirs = await signCommitteeVote(e.other, ballot.digest);
    const votes = [own, { member: theirs.member, signature: hex(theirs.signature) }];
    expect((await call(client, "wallet_committee_release", { ...e.ballot, votes: [own] })).value).toMatchObject({ code: "CommitteeSigners" });
    const forged = { member: e.other.address, signature: own.signature };
    expect((await call(client, "wallet_committee_release", { ...e.ballot, votes: [own, forged] })).value).toMatchObject({ code: "SigMessage" });
    const shown = await ok(client, "wallet_committee_release", { ...e.ballot, votes });
    expect(shown).toMatchObject({ intent: e.intent, committee: e.committee, signers: sortMembers([e.wallet, e.other.address]), sent: false });
    expect((await call(client, "wallet_committee_release", { ...e.ballot, votes, send: true })).value).toMatchObject({
      code: "ReleaseChanged",
      hint: RELEASE_CHANGED,
    });
    const released = await ok(client, "wallet_committee_release", { ...e.ballot, votes, approval: shown["approval"], send: true });
    expect(released).toMatchObject({ sent: true, signature: expect.any(String) });
    const paid = await findAssociatedTokenAddress({ owner: e.worker, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(balance(paid)).toBeGreaterThan(0n);
    const account = await createClient({ url: "http://cluster", transport }).intent(e.wallet, BigInt(e.ballot.nonce));
    expect(account?.intent.status).toBe(IntentStatus.Filled);
  });

  it("has no vote on a committee it does not sit on", async () => {
    const e = await committeeEscrow(false);
    expect((await call(client, "wallet_committee_vote", e.ballot)).value).toMatchObject({ code: "Unauthorized", hint: NOT_A_MEMBER });
  });
});
