import { type Address, generateKeyPairSigner, getBase16Decoder } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { findAssociatedTokenAddress } from "@intent-engine/core";
import { signCommitteeVote, sortMembers } from "@intent-engine/core/internal";
import { type Transport } from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import { WALLET_NOTICE } from "../../src/agent/wallet.js";
import { EXIT_OK } from "../../src/main.js";
import { announced, keyed } from "../announce.js";
import { ata, balance, cli, funded, h, transport, world, type World } from "../harness.js";
import { approved } from "../approved.js";

type Json = Record<string, unknown> & { [key: string]: any };

const sends: string[] = [];

const counting: Transport = {
  ...transport,
  send: async (instructions, payer) => {
    sends.push(payer.address);
    return transport.send(instructions, payer);
  },
  sendWire: async (wire, latest) => {
    sends.push("wire");
    return transport.sendWire(wire, latest);
  },
};

async function connect(): Promise<Client> {
  h.served.length = 0;
  h.through = counting;
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

describe("a committee release through the wallet server", () => {
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

  it("DX-4 sends a setup transaction on send: true that its preview never showed", async () => {
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
    const escrow = await ok(client, "wallet_escrow", await approved(client, "wallet_escrow", { sell: w.inputMint, record_mint: w.outputMint, amount: "0.5", attestor: committee, spec_hash: "6d".repeat(32) }));
    const intent = escrow["intent"] as Address;
    const worker = await keyed();
    const work = "e7".repeat(32);
    const made = await announced(intent, worker, work);
    const ballot = { owner: wallet, nonce: escrow["nonce"] as string, result: "1", delivered_sha256: work };
    const preview = await ok(client, "wallet_committee_vote", ballot);
    const voted = await ok(client, "wallet_committee_vote", { ...ballot, approval: preview["approval"], send: true });
    const own = voted["vote"] as { member: Address; signature: string };
    const digest = await createClient({ url: "http://cluster", transport }).committeeBallot({
      intent: { owner: wallet, nonce: BigInt(ballot.nonce) },
      announcement: made.announcement,
      opening: { sha256: work, salt: made.salt },
      result: 1n,
    });
    const theirs = await signCommitteeVote(other, digest.digest, digest.committee.members);
    const votes = [own, { member: theirs.member, signature: hex(theirs.signature) }];
    const paid = await findAssociatedTokenAddress({ owner: worker.address, mint: w.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(balance(paid)).toBe(-1n);
    const shown = await ok(client, "wallet_committee_release", { ...ballot, votes });
    expect(shown).toMatchObject({ sent: false, announcement: made.announcement });
    const setupShown = (shown["summary"] as string[]).some((line) => /setup|sets up|creates|\brent\b|own transaction/i.test(line));
    sends.length = 0;
    const released = await ok(client, "wallet_committee_release", { ...ballot, votes, approval: shown["approval"], send: true });
    expect(released).toMatchObject({ sent: true, signature: expect.any(String) });
    expect(balance(paid)).toBeGreaterThan(0n);
    const transactions = sends.length;
    expect({ transactions, setupShown }).toEqual({ transactions, setupShown: transactions > 1 });
  });
});
