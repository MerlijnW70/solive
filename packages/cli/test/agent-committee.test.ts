import { type Address, generateKeyPairSigner, getBase16Decoder, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT as TEST_TOKEN, findAssociatedTokenAddress, IntentStatus, NATIVE_MINT } from "@intent-engine/core";
import { signCommitteeVote, sortMembers } from "@intent-engine/core/internal";
import { createClient } from "@intent-engine/client/node";
import { NOT_A_MEMBER, RELEASE_CHANGED, VOTE_CHANGED, WALLET_NOTICE } from "../src/agent/wallet.js";
import { EXIT_OK } from "../src/main.js";
import { announced, keyed } from "./announce.js";
import { TOKEN_NAMES } from "../src/tokens.js";
import { sol, tokenAccountRent } from "../src/agent/wallet/costs.js";
import { ata, balance, cli, funded, h, transport, world } from "./harness.js";

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
    const workerKey = await keyed();
    const worker = workerKey.address;
    const work = "e7".repeat(32);
    const made = await announced(intent, workerKey, work);
    const ballot = { owner: wallet, nonce: escrow["nonce"] as string, result: "1", delivered_sha256: work };
    return { wallet, other, committee, intent, worker, work, ballot, made };
  }

  it("votes after a preview, and releases once the threshold of votes is in", async () => {
    const e = await committeeEscrow(true);
    expect((await call(client, "wallet_committee_vote", { ...e.ballot, delivered_sha256: "e8".repeat(32) })).value).toMatchObject({ code: "NotAnnounced" });
    const preview = await ok(client, "wallet_committee_vote", e.ballot);
    expect(preview).toMatchObject({ intent: e.intent, committee: e.committee, announcement: e.made.announcement, worker: e.worker, signed: false });
    expect(preview).not.toHaveProperty("vote");
    expect((await call(client, "wallet_committee_vote", { ...e.ballot, result: "1", send: true })).value).toMatchObject({
      code: "ReleaseChanged",
      hint: VOTE_CHANGED,
    });
    const voted = await ok(client, "wallet_committee_vote", { ...e.ballot, approval: preview["approval"], send: true });
    expect(voted).toMatchObject({ signed: true, vote: { member: e.wallet } });
    const own = voted["vote"] as { member: Address; signature: string };
    const ballot = await createClient({ url: "http://cluster", transport }).committeeBallot({
      intent: { owner: e.wallet, nonce: BigInt(e.ballot.nonce) },
      announcement: e.made.announcement,
      opening: { sha256: e.work, salt: e.made.salt },
      result: 1n,
    });
    const theirs = await signCommitteeVote(e.other, ballot.digest, ballot.committee.members);
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
    const account = await createClient({ url: "http://cluster", transport }).intent({ owner: e.wallet, nonce: BigInt(e.ballot.nonce) });
    expect(account?.intent.status).toBe(IntentStatus.Filled);
  });

  it("previews the setup that creates the worker's token account and its rent, and refuses a send whose setup changed since", async () => {
    const e = await committeeEscrow(true);
    const preview = await ok(client, "wallet_committee_vote", e.ballot);
    const own = (await ok(client, "wallet_committee_vote", { ...e.ballot, approval: preview["approval"], send: true }))["vote"] as { member: Address; signature: string };
    const ballot = await createClient({ url: "http://cluster", transport }).committeeBallot({
      intent: { owner: e.wallet, nonce: BigInt(e.ballot.nonce) },
      announcement: e.made.announcement,
      opening: { sha256: e.work, salt: e.made.salt },
      result: 1n,
    });
    const theirs = await signCommitteeVote(e.other, ballot.digest, ballot.committee.members);
    const votes = [own, { member: theirs.member, signature: hex(theirs.signature) }];
    const paid = await findAssociatedTokenAddress({ owner: e.worker, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const rent = sol(await tokenAccountRent(transport, TOKEN_PROGRAM_ADDRESS));
    const setup = `Setup: creates ${e.worker}'s ${TOKEN_NAMES[NATIVE_MINT] ?? NATIVE_MINT} account ${paid}, in its own transaction before the release; ${rent} of rent from this wallet ${e.wallet}`;
    const shown = await ok(client, "wallet_committee_release", { ...e.ballot, votes });
    expect(shown["summary"]).toContain(setup);
    await ata(await funded(), e.worker, NATIVE_MINT);
    expect((await call(client, "wallet_committee_release", { ...e.ballot, votes, approval: shown["approval"], send: true })).value).toMatchObject({
      code: "ReleaseChanged",
      hint: RELEASE_CHANGED,
    });
    const again = await ok(client, "wallet_committee_release", { ...e.ballot, votes });
    const setups = (summary: unknown) => (summary as string[]).filter((line) => line.startsWith("Setup:"));
    expect(setups(again["summary"])).toEqual(setups(shown["summary"]).filter((line) => line !== setup));
    expect(again["approval"]).not.toBe(shown["approval"]);
    expect(await ok(client, "wallet_committee_release", { ...e.ballot, votes, approval: again["approval"], send: true })).toMatchObject({ sent: true });
    expect(balance(paid)).toBeGreaterThan(0n);
  });

  it("has no vote on a committee it does not sit on", async () => {
    const e = await committeeEscrow(false);
    expect((await call(client, "wallet_committee_vote", e.ballot)).value).toMatchObject({ code: "Unauthorized", hint: NOT_A_MEMBER });
  });
});
