import {
  type Address,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type KeyPairSigner,
  lamports,
  none,
} from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildClaimJob,
  DEVNET_TEST_MINT,
  EVENT_IX_TAG,
  findAssociatedTokenAddress,
  getIntentAttestedEventEncoder,
  getIntentCancelledEventEncoder,
  getIntentCreatedEventEncoder,
  getIntentDecoder,
  NATIVE_MINT,
  releaseMemo,
  splitFee,
} from "@intent-engine/core";
import { deliverySalt, type EngineTransaction, MEMO_PROGRAM_ADDRESS, signersAmong } from "@intent-engine/client";
import { tool } from "../src/agent/names.js";
import { claimedByOther, NO_CLAIM_HELD } from "../src/agent/job-claims.js";
import { ANNOUNCE_FIRST } from "../src/agent/wallet/delivery.js";
import { paidOther } from "../src/agent/wallet/receipt.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { EXIT_OK } from "../src/main.js";
import { defaultWallet, LAMPORTS_PER_SOL } from "../src/wallet.js";
import { cli, FEE_BPS, funded, h, HOME, NOW, send, setNow, world } from "./harness.js";

type Json = Record<string, unknown>;

const SPEC_HASH = "7d".repeat(32);
const WORK = "e5".repeat(32);
const WORK_URL = "https://" + "example.org/work-5f0c9a7e31d2";
const ESCROWED = LAMPORTS_PER_SOL / 20n;

const tag = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);

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
  const started = await cli(["mcp", "--url", "devnet", "--wallet"], {});
  expect([started.code, started.err]).toEqual([EXIT_OK, WALLET_NOTICE.join("\n")]);
  const [near, far] = InMemoryTransport.createLinkedPair();
  await h.served[0]?.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return client;
}

async function ok(client: Client, name: string, args: object = {}): Promise<Json> {
  const result = await client.callTool({ name: tool(name), arguments: args as Record<string, unknown> });
  expect(result.isError === true, JSON.stringify(result.structuredContent)).toBe(false);
  return result.structuredContent as Json;
}

const useKey = (signer: KeyPairSigner) => h.files.set(defaultWallet(HOME), JSON.stringify(Array.from(h.keypairs.get(signer.address) ?? [])));

function landedAs(wire: string, slot: bigint): EngineTransaction {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(wire));
  const message = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
  const keys = message.staticAccounts;
  const memos = ("instructions" in message ? message.instructions : []).filter((ix) => keys[ix.programAddressIndex] === MEMO_PROGRAM_ADDRESS);
  return {
    signature: getSignatureFromTransaction(tx),
    slot,
    blockTime: null,
    failed: false,
    emitted: [],
    memos: memos.map((ix) => new TextDecoder().decode(Uint8Array.from(ix.data ?? []))),
    memoSigners: memos.map((ix) => signersAmong(keys, ix.accountIndices ?? [], message.header.numSignerAccounts)),
    ...(keys[0] === undefined ? {} : { feePayer: keys[0] }),
  };
}

function createdFrom(intent: Address): EngineTransaction {
  const held = h.svm.getAccount(intent);
  if (!held.exists) {
    throw new Error("the escrow was not created");
  }
  const escrow = getIntentDecoder().decode(held.data);
  const { owner, nonce, kind, inputMint, outputMint, escrowed, expiresAt } = escrow;
  const event = getIntentCreatedEventEncoder().encode({ intent, owner, nonce, kind, inputMint, outputMint, receiver: owner, escrowed, expiresAt, rentPayer: owner, flags: 0, bounty: 0, createFee: 0 });
  return { signature: `made-${intent}`, slot: 1n, blockTime: null, failed: false, emitted: [tag(event)], feePayer: owner };
}

describe("a worker without the claim on a job that takes claims", () => {
  let client: Client;
  let payer: Address;
  let payerKey: string;

  const escrow = async (claims: boolean) =>
    ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: payer, spec_hash: SPEC_HASH, ...(claims ? { claim_stake: "0.05", claim_secs: 3600 } : {}), send: true });

  const announce = async (worker: KeyPairSigner, intent: Address, slot: bigint) => {
    useKey(worker);
    h.wires.length = 0;
    await ok(client, "wallet_deliver", { intent, sha256: WORK, url: WORK_URL, send: true });
    return landedAs(h.wires[0] as string, slot);
  };

  beforeEach(async () => {
    await world();
    h.files.clear();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    client = await connect();
    payer = (await ok(client, "wallet_setup"))["address"] as Address;
    payerKey = h.files.get(defaultWallet(HOME)) ?? "";
    h.watched.push(payer);
    h.engineLog = [];
  });

  it("is warned by the deliver preview, and told by the receipt and the history that the release paid the claiming worker", async () => {
    const claimed = await escrow(true);
    const free = await escrow(true);
    const plain = await escrow(false);
    const intent = claimed["intent"] as Address;
    const holder = await funded();
    await send(holder, [await buildClaimJob({ worker: holder, intent, owner: payer, secs: 600 })]);
    const until = BigInt((await ok(client, "get_claims", { owner: payer, nonce: claimed["nonce"] }))["until"] as string);
    const rival = await funded();

    useKey(rival);
    const warned = await ok(client, "wallet_deliver", { intent, sha256: WORK, url: WORK_URL });
    expect(warned["warnings"]).toEqual([claimedByOther(holder.address, until, rival.address), ANNOUNCE_FIRST]);
    expect(warned["warnings"]).toContainEqual(expect.stringContaining(`${holder.address} holds this job's claim until ${new Date(Number(until) * 1000).toISOString()}`));
    expect(claimedByOther(holder.address, until, rival.address)).toContain(`this wallet ${rival.address} cannot be paid for this work`);
    const unclaimed = await ok(client, "wallet_deliver", { intent: free["intent"], sha256: WORK, url: WORK_URL });
    expect(unclaimed["warnings"]).toEqual([NO_CLAIM_HELD, ANNOUNCE_FIRST]);
    expect(NO_CLAIM_HELD).toContain("claim it with solive_wallet_claim before working on it");
    expect((await ok(client, "wallet_deliver", { intent: plain["intent"], sha256: WORK, url: WORK_URL }))["warnings"]).toEqual([ANNOUNCE_FIRST]);
    useKey(holder);
    expect((await ok(client, "wallet_deliver", { intent, sha256: WORK, url: WORK_URL }))["warnings"]).toEqual([ANNOUNCE_FIRST]);

    const first = await announce(holder, intent, 5n);
    const copied = await announce(rival, intent, 6n);
    const waiting = await announce(rival, plain["intent"] as Address, 7n);
    const made = createdFrom(intent);
    h.files.set(defaultWallet(HOME), payerKey);
    h.engineLog = [waiting, copied, first, made];
    const release = { owner: payer, nonce: claimed["nonce"], pay_to: holder.address, delivered_sha256: WORK };
    const shown = await ok(client, "wallet_attest", release);
    expect(await ok(client, "wallet_attest", { ...release, approval: shown["approval"], send: true })).toMatchObject({ sent: true });

    const payee = await findAssociatedTokenAddress({ owner: holder.address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const { fee, net } = splitFee(ESCROWED, FEE_BPS);
    const attested = getIntentAttestedEventEncoder().encode({
      intent,
      owner: payer,
      solver: payer,
      payee,
      attestor: payer,
      amountIn: ESCROWED,
      result: 1n,
      fee,
      net,
      filled: ESCROWED,
      remaining: 0n,
      partnerFee: 0n,
    });
    h.engineLog = [
      {
        signature: "released",
        slot: 9n,
        blockTime: null,
        failed: false,
        emitted: [tag(attested)],
        memos: [releaseMemo(WORK, await deliverySalt(holder, intent, WORK))],
        memoSigners: [[payer]],
        feePayer: payer,
        tokens: [{ account: payee, mint: NATIVE_MINT, owner: holder.address }],
      },
      waiting,
      copied,
      first,
      made,
    ];

    useKey(rival);
    const receipt = await ok(client, "wallet_receipt", { owner: payer, nonce: claimed["nonce"], sha256: WORK });
    expect(receipt).toMatchObject({ released: true, paid_to: holder.address, matches: true, valid: true, paid_this_wallet: false, next: paidOther([holder.address], rival.address) });
    expect(receipt["next"]).toContain(`this release paid ${holder.address}, not this wallet ${rival.address}`);
    const both = await ok(client, "wallet_receipt", { owner: payer, nonce: plain["nonce"], also: [{ owner: payer, nonce: claimed["nonce"] }] });
    expect(both).toMatchObject({ released: true, owner: payer, nonce: claimed["nonce"], paid_to: holder.address, paid_this_wallet: false });
    expect(both["escrows"]).toEqual([
      expect.objectContaining({ owner: payer, nonce: plain["nonce"], intent: plain["intent"], released: false }),
      { owner: payer, nonce: claimed["nonce"], intent, released: true, paid_to: holder.address, paid_this_wallet: false },
    ]);
    expect(both["escrows"] as Json[]).not.toContainEqual(expect.objectContaining({ released: false, paid_to: expect.anything() }));

    const history = await ok(client, "wallet_history");
    expect(history["work"]).toEqual([
      expect.objectContaining({ intent: plain["intent"], signature: waiting.signature, paid: false, unpaid_reason: "open", released_to: null }),
      expect.objectContaining({ intent, signature: copied.signature, paid: false, unpaid_reason: "released_to_other", released_to: holder.address }),
    ]);

    useKey(holder);
    const own = await ok(client, "wallet_receipt", { owner: payer, nonce: claimed["nonce"], sha256: WORK });
    expect(own).toMatchObject({ paid_to: holder.address, paid_this_wallet: true });
    expect(String(own["next"] ?? "")).not.toContain("not this wallet");
    expect((await ok(client, "wallet_history"))["work"]).toEqual([expect.objectContaining({ intent, signature: first.signature, paid: true, unpaid_reason: null, released_to: null })]);

    h.files.set(defaultWallet(HOME), payerKey);
    const books = ((await ok(client, "wallet_history"))["activity"] as Json[]).filter((entry) => entry["kind"] === "AttestedResult");
    expect(books.length).toBeGreaterThan(0);
    expect(books.map((entry) => [entry["received"], entry["receive_token"]])).toEqual(books.map(() => [null, null]));
  });

  it("gives each unpaid announcement its reason: cancelled, expired, or unknown when the end was not found", async () => {
    const cancelled = await escrow(false);
    const lost = await escrow(false);
    const lapsed = await escrow(false);
    const worker = await funded();
    const onCancelled = await announce(worker, cancelled["intent"] as Address, 5n);
    const onLost = await announce(worker, lost["intent"] as Address, 6n);
    const onLapsed = await announce(worker, lapsed["intent"] as Address, 7n);
    h.files.set(defaultWallet(HOME), payerKey);
    for (const job of [cancelled, lost]) {
      expect(await ok(client, "wallet_cancel", { nonce: job["nonce"], send: true })).toMatchObject({ sent: true });
    }
    const cancel = getIntentCancelledEventEncoder().encode({ intent: cancelled["intent"] as Address, owner: payer, refunded: ESCROWED });
    h.engineLog = [{ signature: "cancel", slot: 8n, blockTime: null, failed: false, emitted: [tag(cancel)] }, onLapsed, onLost, onCancelled];
    setNow(NOW + 366n * 86_400n);
    useKey(worker);
    const reasons = ((await ok(client, "wallet_history"))["work"] as Json[]).map((item) => [item["intent"], item["paid"], item["unpaid_reason"], item["released_to"]]);
    expect(reasons).toEqual([
      [lapsed["intent"], false, "expired", null],
      [lost["intent"], false, "unknown", null],
      [cancelled["intent"], false, "cancelled", null],
    ]);
  });
});
