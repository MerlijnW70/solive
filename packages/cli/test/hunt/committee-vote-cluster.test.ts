import { type Address, generateKeyPairSigner, getBase16Decoder } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { findAssociatedTokenAddress } from "@intent-engine/core";
import { signCommitteeVote, sortMembers } from "@intent-engine/core/internal";
import { createClient } from "@intent-engine/client/node";
import { MAINNET_GENESIS, WALLET_NOTICE } from "../../src/agent/wallet.js";
import { EXIT_OK } from "../../src/main.js";
import { announced, keyed } from "../announce.js";
import { ata, balance, cli, funded, h, transport, world, type World } from "../harness.js";

type Json = Record<string, unknown> & { [key: string]: any };

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

describe("a wallet server whose RPC turns to mainnet after a committee vote preview", () => {
  let client: Client;
  let w: World;

  beforeEach(async () => {
    w = await world();
    h.files.clear();
    for (const name of Object.keys(h.env)) {
      delete h.env[name];
    }
    client = await connect();
  });

  async function committeeEscrow() {
    const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
    h.watched.push(wallet);
    h.engineLog = [];
    await ata(w.authority, wallet, w.inputMint, 1_000_000n);
    const other = await generateKeyPairSigner();
    const payer = await funded();
    const members = sortMembers([wallet, other.address]);
    const created = await cli(
      ["committee", "create", "--url", "devnet", "--keypair", "payer.json", "--members", members.join(","), "--threshold", "2", "--fee-wallet", payer.address, "--yes"],
      { "payer.json": payer },
    );
    expect([created.code, created.err]).toEqual([EXIT_OK, ""]);
    const committee = created.json()["committee"] as Address;
    const escrow = await ok(client, "wallet_escrow", {
      sell: w.inputMint,
      record_mint: w.outputMint,
      amount: "0.5",
      attestor: committee,
      spec_hash: "6d".repeat(32),
      send: true,
    });
    const intent = escrow["intent"] as Address;
    const workerKey = await keyed();
    const worker = workerKey.address;
    const work = "e7".repeat(32);
    const made = await announced(intent, workerKey, work);
    return { other, worker, made, ballot: { owner: wallet, nonce: escrow["nonce"] as string, result: "1", delivered_sha256: work } };
  }

  it("M-2: the RPC serves mainnet's genesis after the preview and the wallet still signs the committee vote", async () => {
    const { ballot } = await committeeEscrow();
    const preview = await ok(client, "wallet_committee_vote", ballot);
    expect(preview).toMatchObject({ signed: false });
    h.genesis = MAINNET_GENESIS;
    const { value } = await call(client, "wallet_committee_vote", { ...ballot, approval: preview["approval"], send: true });
    expect(value).not.toHaveProperty("vote");
    expect(value).toMatchObject({ code: "WalletNotMainnet" });
  });

  it("M-2: the RPC serves mainnet's genesis after the release preview and the wallet still sends the release's setup transaction", async () => {
    const e = await committeeEscrow();
    const preview = await ok(client, "wallet_committee_vote", e.ballot);
    const own = (await ok(client, "wallet_committee_vote", { ...e.ballot, approval: preview["approval"], send: true }))["vote"] as { member: Address; signature: string };
    const ballot = await createClient({ url: "http://cluster", transport }).committeeBallot({
      intent: { owner: e.ballot.owner, nonce: BigInt(e.ballot.nonce) },
      announcement: e.made.announcement,
      opening: { sha256: e.ballot.delivered_sha256, salt: e.made.salt },
      result: 1n,
    });
    const theirs = await signCommitteeVote(e.other, ballot.digest, ballot.committee.members);
    const votes = [own, { member: theirs.member, signature: getBase16Decoder().decode(theirs.signature).toLowerCase() }];
    const shown = await ok(client, "wallet_committee_release", { ...e.ballot, votes });
    expect(shown).toMatchObject({ sent: false });
    const payee = await findAssociatedTokenAddress({ owner: e.worker, mint: w.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(balance(payee)).toBe(-1n);
    h.genesis = MAINNET_GENESIS;
    const { value } = await call(client, "wallet_committee_release", { ...e.ballot, votes, approval: shown["approval"], send: true });
    expect(value).toMatchObject({ code: "WalletNotMainnet" });
    expect(balance(payee)).toBe(-1n);
  });
});
