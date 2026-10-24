import { type Address, type KeyPairSigner, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT as TEST_TOKEN, findAssociatedTokenAddress, getCommitteeSize, IntentStatus, NATIVE_MINT, sortMembers } from "@intent-engine/core";
import { createClient } from "@intent-engine/client";
import { EVERYDAY_TOOLS } from "../src/agent/everyday.js";
import { tool } from "../src/agent/names.js";
import { COMMITTEE_CHANGED, COMMITTEE_EXISTS, COMMITTEE_LIVE, PREVIEW_APPROVAL_NEXT, WALLET_NOTICE } from "../src/agent/wallet.js";
import { walletCommitteeCreate, walletCommitteeRelease, walletCommitteeVote } from "../src/agent/wallet/committee.js";
import { sol } from "../src/agent/wallet/costs.js";
import { EXIT_OK } from "../src/main.js";
import { defaultWallet } from "../src/wallet.js";
import { announced, keyed } from "./announce.js";
import { balance, cli, funded, h, HOME, transport, world } from "./harness.js";

type Json = Record<string, unknown> & { [key: string]: any };

const URL_OF_WORK = "https://" + "example.org/team-work-5e1d";

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

async function connect(): Promise<{ client: Client; tools: string[] }> {
  h.served.length = 0;
  const started = await cli(["mcp", "--url", "devnet", "--wallet"], {});
  expect([started.code, started.err]).toEqual([EXIT_OK, WALLET_NOTICE.join("\n")]);
  const [near, far] = InMemoryTransport.createLinkedPair();
  await h.served[0]?.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return { client, tools: (await client.listTools()).tools.map((t) => t.name) };
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

const useKey = (signer: KeyPairSigner): void => {
  h.files.set(defaultWallet(HOME), JSON.stringify(Array.from(h.keypairs.get(signer.address) ?? [])));
};

describe("a team judging together through the default wallet tools", () => {
  beforeEach(async () => {
    await world();
    h.files.clear();
    for (const name of Object.keys(h.env)) {
      delete h.env[name];
    }
    preset(NATIVE_MINT);
    preset(TEST_TOKEN);
  });

  it("serves the committee and profile tools without --all-tools, and says how a team judges together", async () => {
    const { tools } = await connect();
    for (const name of ["wallet_committee_create", "wallet_committee_vote", "wallet_committee_release", "wallet_profile", "get_profile"].map(tool)) {
      expect(tools).toContain(name);
      expect(EVERYDAY_TOOLS.has(name)).toBe(true);
    }
    expect(walletCommitteeCreate.description).toContain("so a team judges together");
    expect(walletCommitteeCreate.description).toContain(`Name the committee as attestor in ${tool("wallet_escrow")}`);
    expect(walletCommitteeVote.description).toContain("A team judges together: each member checks the work against the spec and votes");
    expect(walletCommitteeRelease.description).toContain("any one wallet collects the members' votes");
  });

  it("creates a committee after a preview, escrows work it judges, and releases it on both members' votes", async () => {
    const { client, tools } = await connect();
    const used = ["wallet_setup", "wallet_committee_create", "wallet_escrow", "wallet_committee_vote", "wallet_committee_release"].map(tool);
    expect(used.filter((name) => !tools.includes(name))).toEqual([]);
    const lead = (await ok(client, "wallet_setup"))["address"] as Address;
    const leadKey = h.files.get(defaultWallet(HOME)) ?? "";
    h.watched.push(lead);
    const peer = await funded();
    const terms = { members: [peer.address, lead], threshold: 2 };

    const preview = await ok(client, "wallet_committee_create", terms);
    const members = sortMembers([lead, peer.address]);
    expect(preview).toMatchObject({ members, threshold: 2, fee_wallet: lead, exists: false, sent: false, next: PREVIEW_APPROVAL_NEXT });
    const committee = preview["committee"] as Address;
    expect(h.svm.getAccount(committee).exists).toBe(false);
    expect(preview["summary"]).toContain(`Rent: ${sol(h.svm.minimumBalanceForRentExemption(BigInt(getCommitteeSize())))} from this wallet ${lead}, kept by the committee account`);
    expect((await call(client, "wallet_committee_create", { ...terms, threshold: 1, approval: preview["approval"], send: true })).value).toMatchObject({
      code: "ReleaseChanged",
      hint: COMMITTEE_CHANGED,
    });
    expect((await call(client, "wallet_committee_create", { members: [lead], threshold: 2 })).value).toMatchObject({ code: "CommitteeInvalid" });
    const made = await ok(client, "wallet_committee_create", { ...terms, approval: preview["approval"], send: true });
    expect(made).toMatchObject({ committee, sent: true, signature: expect.any(String), next: COMMITTEE_LIVE });
    const read = await createClient({ url: "http://cluster", transport }).committee(committee);
    expect(read).toMatchObject({ members, threshold: 2, feeWallet: lead });
    expect(await ok(client, "wallet_committee_create", terms)).toMatchObject({ committee, exists: true, sent: false, next: COMMITTEE_EXISTS });

    const escrow = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: committee, spec_hash: "5a".repeat(32), send: true });
    const intent = escrow["intent"] as Address;
    const workerKey = await keyed();
    const worker = workerKey.address;
    const work = "b6".repeat(32);
    await announced(intent, workerKey, work, URL_OF_WORK);
    const ballot = { owner: lead, nonce: escrow["nonce"] as string, result: "1", delivered_sha256: work };

    const vote = async (): Promise<{ member: Address; signature: string }> => {
      const shown = await ok(client, "wallet_committee_vote", ballot);
      expect(shown).toMatchObject({ intent, committee, signed: false });
      const signed = await ok(client, "wallet_committee_vote", { ...ballot, approval: shown["approval"], send: true });
      expect(signed).toMatchObject({ signed: true });
      return signed["vote"];
    };
    const leadVote = await vote();
    useKey(peer);
    const peerVote = await vote();
    expect([leadVote.member, peerVote.member]).toEqual([lead, peer.address]);
    h.files.set(defaultWallet(HOME), leadKey);

    expect((await call(client, "wallet_committee_release", { ...ballot, votes: [leadVote] })).value).toMatchObject({ code: "CommitteeSigners" });
    const votes = [peerVote, leadVote];
    const shown = await ok(client, "wallet_committee_release", { ...ballot, votes });
    expect(shown).toMatchObject({ intent, committee, signers: members, sent: false });
    const released = await ok(client, "wallet_committee_release", { ...ballot, votes, approval: shown["approval"], send: true });
    expect(released).toMatchObject({ sent: true, signature: expect.any(String) });
    const paid = await findAssociatedTokenAddress({ owner: worker, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(balance(paid)).toBeGreaterThan(0n);
    const settled = await createClient({ url: "http://cluster", transport }).intent(lead, BigInt(ballot.nonce));
    expect(settled?.intent.status).toBe(IntentStatus.Filled);
  });
});
