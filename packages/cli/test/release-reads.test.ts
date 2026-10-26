import { createHash } from "node:crypto";
import { type Address, generateKeyPairSigner, type KeyPairSigner, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, IntentStatus, Kind, NATIVE_MINT } from "@intent-engine/core";
import { findIntentPda, signCommitteeVote, sortMembers } from "@intent-engine/core/internal";
import { type Transport } from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import { TRUST_WALLETS } from "@intent-engine/client/internal";
import { svmTransport } from "@intent-engine/client/svm";
import { invoke } from "../src/agent/actions.js";
import { claimsOf } from "../src/agent/claims.js";
import { tool } from "../src/agent/names.js";
import { getReputation } from "../src/agent/reputation.js";
import { SECOND_NODE_UNREAD, WALLET_NOTICE } from "../src/agent/wallet.js";
import { EXIT_OK } from "../src/main.js";
import { announced, keyed } from "./announce.js";
import { cliWith, secondNode, SECOND } from "./confirm-node.js";
import { ata, cli, funded, h, transport, world } from "./harness.js";
import { approved } from "./approved.js";

type Json = Record<string, unknown> & { [key: string]: any };

const WORK = "7e".repeat(32);
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

async function linked(started: { code: number; err: string }): Promise<Client> {
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

const ctxOf = (over: Transport) => ({ transport: over, relay: undefined, agent: undefined, claims: claimsOf() });

describe("a worker's reputation", () => {
  async function paidWorker() {
    const w = await world();
    preset(NATIVE_MINT);
    const svm = svmTransport(h.svm);
    const client = createClient({ url: "http://cluster", transport: svm });
    const [judge, owner, worker] = await Promise.all([funded(), funded(), funded()]);
    const sha256 = "ab".repeat(32);
    const { nonce } = await client.createIntent({
      signer: owner,
      params: { kind: Kind.AttestedResult, amountIn: 1_000_000n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: new Uint8Array(32).fill(7), judgeFee: 0n },
      inputMint: NATIVE_MINT,
      outputMint: w.outputMint,
    });
    const [intent] = await findIntentPda({ owner: owner.address, nonce });
    const made = await client.announce({ worker, intent, sha256, url: URL_OF_WORK });
    await client.settleProof({ judge, intent: { owner: owner.address, nonce }, announcement: made.announcement, opening: { sha256, salt: made.salt }, result: 1n });
    return { svm, worker, intent, sha256, owner, judge };
  }

  it("shows the hash of each paid record and no refutation it does not have", async () => {
    const p = await paidWorker();
    const read = await invoke(getReputation, ctxOf(p.svm), { worker: p.worker.address });
    expect(read.ok).toBe(true);
    const records = read.ok ? (read.value["records"] as Record<string, unknown>[]) : [];
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ intent: p.intent, sha256: p.sha256, outcome: "paid" });
    expect(Object.keys(records[0] ?? {})).not.toContain("refuted_by");
  });

  it("names every seed a reader may give, and admits a path through every wallet trust can read", async () => {
    const p = await paidWorker();
    const seeds = await Promise.all(Array.from({ length: TRUST_WALLETS - 1 }, async () => (await generateKeyPairSigner()).address));
    const read = await invoke(getReputation, ctxOf(p.svm), { worker: p.worker.address, reader: p.owner.address, seeds });
    expect(read.ok, JSON.stringify(read)).toBe(true);
    const value = read.ok ? read.value : {};
    expect((value["trust"] as Json)["seeds"]).toEqual([p.owner.address, ...seeds]);
    const longest = { wallets: [p.owner.address, ...seeds, p.worker.address], trust: "0.5" };
    expect(longest.wallets).toHaveLength(TRUST_WALLETS + 1);
    expect(() => getReputation.output.read({ ...value, trust: { ...(value["trust"] as Json), paths: [longest] } }, "")).not.toThrow();
  });
});

describe("a second node that cannot be read", () => {
  it("is named with its error made printable", async () => {
    await world();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    const node = secondNode();
    node.transport = { ...node.transport, genesisHash: async () => Promise.reject(new Error("bad\nnode")) };
    h.served.length = 0;
    const client = await linked(await cliWith(["mcp", "--url", "devnet", "--wallet", "--all-tools", "--confirm-url", SECOND], {}, node));
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    const escrow = await ok(client, "wallet_escrow", await approved(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: owner, spec_hash: createHash("sha256").update("spec").digest("hex") }));
    const intent = escrow["intent"] as Address;
    await announced(intent, await keyed(), WORK, URL_OF_WORK);
    const refused = await call(client, "wallet_attest", { owner, nonce: escrow["nonce"], delivered_sha256: WORK });
    expect(refused).toMatchObject({ error: true, value: { code: "ConfirmMismatch" } });
    expect(refused.value["hint"]).toBe(SECOND_NODE_UNREAD);
    expect(refused.value["untrustedDetail"]).toContain("bad node");
    expect(refused.value["untrustedDetail"]).not.toContain("\n");
  });
});

describe("a committee release from a key file", () => {
  it("sends no setup transaction when every token account exists", async () => {
    const w = await world();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    const sends: number[] = [];
    h.through = {
      ...transport,
      send: async (instructions, payer) => {
        sends.push(instructions.length);
        return transport.send(instructions, payer);
      },
    };
    h.served.length = 0;
    const client = await linked(await cli(["mcp", "--url", "devnet", "--wallet", "--all-tools"], {}));
    const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
    const other = await keyed();
    const payer: KeyPairSigner = await funded();
    const members = sortMembers([wallet, other.address]);
    const created = await cli(["committee", "create", "--url", "devnet", "--keypair", "payer.json", "--members", members.join(","), "--threshold", "2", "--fee-wallet", payer.address, "--yes"], { "payer.json": payer });
    expect([created.code, created.err]).toEqual([EXIT_OK, ""]);
    const committee = created.json()["committee"] as Address;
    const escrow = await ok(client, "wallet_escrow", await approved(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: committee, spec_hash: "6e".repeat(32) }));
    const intent = escrow["intent"] as Address;
    const worker = await keyed();
    for (const owner of [worker.address, w.feeRecipient.address, payer.address]) {
      await ata(w.authority, owner, NATIVE_MINT);
    }
    await announced(intent, worker, WORK, URL_OF_WORK);
    const ballot = { owner: wallet, nonce: escrow["nonce"] as string, result: "1", delivered_sha256: WORK };
    const preview = await ok(client, "wallet_committee_vote", ballot);
    const own = (await ok(client, "wallet_committee_vote", { ...ballot, approval: preview["approval"], send: true }))["vote"] as { member: Address; signature: string };
    const local = createClient({ url: "http://cluster", transport });
    const first = await local.firstOpening({ intent, sha256: WORK, keypair: h.keypairs.get(other.address) });
    const digest = await local.committeeBallot({ intent: { owner: wallet, nonce: BigInt(ballot.nonce) }, announcement: first.announcement, opening: first, result: 1n });
    const theirs = await signCommitteeVote(other, digest.digest, digest.committee.members);
    const votes = [own, { member: theirs.member, signature: Buffer.from(theirs.signature).toString("hex") }];
    const shown = await ok(client, "wallet_committee_release", { ...ballot, votes });
    sends.length = 0;
    expect(await ok(client, "wallet_committee_release", { ...ballot, votes, approval: shown["approval"], send: true })).toMatchObject({ sent: true });
    expect(sends).toEqual([]);
    const account = await createClient({ url: "http://cluster", transport }).intent({ owner: wallet, nonce: BigInt(ballot.nonce) });
    expect(account?.intent.status).toBe(IntentStatus.Filled);
  });
});
