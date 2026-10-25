import { type Address, type KeyPairSigner, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, findAssociatedTokenAddress, formatAmount, NATIVE_MINT } from "@intent-engine/core";
import {
  EVENT_IX_TAG,
  findVaultPda,
  getDeliveryAnnouncedEventEncoder,
  getDeliveryReleasedEventEncoder,
  getIntentAttestedEventEncoder,
  getIntentCreatedEventEncoder,
  getIntentDecoder,
  splitFee,
} from "@intent-engine/core/internal";
import type { EngineTransaction } from "@intent-engine/client";
import { tool } from "../src/agent/names.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { notMadeHere, PROFIT_NEEDS_JOB } from "../src/agent/wallet/history-profit.js";
import { walletHistory } from "../src/agent/wallet/history.js";
import { EXIT_OK } from "../src/main.js";
import { defaultWallet, LAMPORTS_PER_SOL } from "../src/wallet.js";
import { cli, FEE_BPS, funded, h, HOME, world } from "./harness.js";
import { approved } from "./approved.js";

type Json = Record<string, unknown>;

const URL_OF_WORK = "https://" + "example.org/resold-work-9f2a";
const CREATE_FEE = 2_000n;
const BASE_FEE = 5_000n;
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

function announcedEvent(intent: Address, announcement: Address, worker: Address, attestor: Address): Uint8Array {
  return tag(getDeliveryAnnouncedEventEncoder().encode({ intent, announcement, seq: 1n, worker, payer: worker, attestor, commitment: new Uint8Array(32), slot: 5n, recipients: 1 }));
}

function releasedEvent(intent: Address, announcement: Address, worker: Address, attestor: Address, sha256: string): Uint8Array {
  return tag(
    getDeliveryReleasedEventEncoder().encode({ intent, announcement, seq: 1n, worker, attestor, delivered: Uint8Array.from(Buffer.from(sha256, "hex")), salt: new Uint8Array(16), splitHash: new Uint8Array(32) }),
  );
}

function made(intent: Address, slot: bigint, createFee: bigint): EngineTransaction {
  const held = h.svm.getAccount(intent);
  if (!held.exists) {
    throw new Error("the escrow was not created");
  }
  const escrow = getIntentDecoder().decode(held.data);
  const event = getIntentCreatedEventEncoder().encode({
    intent,
    owner: escrow.owner,
    nonce: escrow.nonce,
    kind: escrow.kind,
    inputMint: escrow.inputMint,
    outputMint: escrow.outputMint,
    receiver: escrow.owner,
    escrowed: escrow.escrowed,
    expiresAt: escrow.expiresAt,
    rentPayer: escrow.owner,
    flags: 0,
    bounty: 0,
    createFee: Number(createFee),
  });
  return { signature: `made-${intent}`, slot, blockTime: escrow.createdAt, failed: false, emitted: [tag(event)], feePayer: escrow.owner };
}

type Release = { intent: Address; owner: Address; to: Address; payee: Address; amount: bigint; judgeFee: bigint; signature: string; slot: bigint; at: bigint };

function released(r: Release, extra: Uint8Array[] = []): EngineTransaction {
  const { fee, net } = splitFee(r.amount - r.judgeFee, FEE_BPS);
  const event = getIntentAttestedEventEncoder().encode({
    intent: r.intent,
    owner: r.owner,
    solver: r.owner,
    payee: r.payee,
    attestor: r.owner,
    amountIn: r.amount,
    result: 1n,
    fee,
    net,
    filled: r.amount,
    remaining: 0n,
    partnerFee: r.judgeFee,
  });
  return {
    signature: r.signature,
    slot: r.slot,
    blockTime: r.at,
    failed: false,
    emitted: [...extra, tag(event)],
    feePayer: r.owner,
    tokens: [{ account: r.payee, mint: NATIVE_MINT, owner: r.to }],
  };
}

const netOf = (amount: bigint, judgeFee: bigint) => splitFee(amount - judgeFee, FEE_BPS);

describe("wallet_history of a job a contractor resold", () => {
  it("returns the job's profit from its client release and two sub-escrow releases, and narrows the lists to the job", async () => {
    await world();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    const client = await connect();
    const payer = (await ok(client, "wallet_setup"))["address"] as Address;
    const payerKey = h.files.get(defaultWallet(HOME)) ?? "";
    const job = await ok(client, "wallet_escrow", await approved(client, "wallet_escrow", { sell: "SOL", amount: "0.1", attestor: payer, spec_hash: "71".repeat(32) }));
    const jobIntent = job["intent"] as Address;
    const jobMade = made(jobIntent, 1n, 0n);
    const at = jobMade.blockTime ?? 0n;

    const contractor = await funded();
    useKey(contractor);
    const work = "e4".repeat(32);
    const delivered = await ok(client, "wallet_deliver", { intent: jobIntent, sha256: work, url: URL_OF_WORK, send: true });
    const announcement = delivered["announcement"] as Address;
    const announced: EngineTransaction = {
      signature: delivered["signature"] as string,
      slot: 5n,
      blockTime: at + 5n,
      failed: false,
      emitted: [announcedEvent(jobIntent, announcement, contractor.address, payer)],
      feePayer: contractor.address,
    };

    h.files.set(defaultWallet(HOME), payerKey);
    h.engineLog = [announced, jobMade];
    const attest = { owner: payer, nonce: job["nonce"], delivered_sha256: work };
    const shown = await ok(client, "wallet_attest", attest);
    expect(await ok(client, "wallet_attest", { ...attest, approval: shown["approval"], send: true })).toMatchObject({ sent: true });

    useKey(contractor);
    const subs: Address[] = [];
    for (const hint of ["72", "73"]) {
      subs.push((await ok(client, "wallet_escrow", await approved(client, "wallet_escrow", { sell: "SOL", amount: "0.03", attestor: contractor.address, spec_hash: hint.repeat(32) })))["intent"] as Address);
    }
    const [first, second] = subs as [Address, Address];
    const payeeOf = (owner: Address) => findAssociatedTokenAddress({ owner, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const jobAmount = LAMPORTS_PER_SOL / 10n;
    const subAmount = (LAMPORTS_PER_SOL * 3n) / 100n;
    const judgeFee = 1_000_000n;
    const jobRelease = released(
      { intent: jobIntent, owner: payer, to: contractor.address, payee: await payeeOf(contractor.address), amount: jobAmount, judgeFee: 0n, signature: "job-released", slot: 9n, at: at + 9n },
      [releasedEvent(jobIntent, announcement, contractor.address, payer, work)],
    );
    const firstRelease = released({ intent: first, owner: contractor.address, to: payer, payee: await payeeOf(payer), amount: subAmount, judgeFee, signature: "first-released", slot: 14n, at: at + 14n });
    const secondRelease = released({ intent: second, owner: contractor.address, to: payer, payee: await payeeOf(payer), amount: subAmount, judgeFee: 0n, signature: "second-released", slot: 15n, at: at + 15n });
    h.engineLog = [secondRelease, firstRelease, made(second, 12n, CREATE_FEE), made(first, 11n, CREATE_FEE), jobRelease, announced, jobMade];

    const seen = await ok(client, "wallet_history", { escrow: jobIntent, paid_from: subs });
    const received = netOf(jobAmount, 0n).net;
    const firstSplit = netOf(subAmount, judgeFee);
    const secondSplit = netOf(subAmount, 0n);
    const paidOut = firstSplit.net + secondSplit.net;
    const fees = firstSplit.fee + judgeFee + secondSplit.fee;
    const feesSol = 2n * CREATE_FEE + 4n * BASE_FEE;
    const vaultRent = h.svm.minimumBalanceForRentExemption(165n);
    let rentSol = 0n;
    for (const intent of subs) {
      const [vault] = await findVaultPda({ intent });
      expect(h.svm.getAccount(vault).exists).toBe(true);
      const held = h.svm.getAccount(intent);
      rentSol += (held.exists ? BigInt(held.lamports) : 0n) + vaultRent;
    }
    expect(rentSol).toBeGreaterThan(2n * vaultRent);
    const difference = received - paidOut - fees - feesSol - rentSol;
    expect(seen["profit"]).toEqual({
      escrow: jobIntent,
      token: "SOL",
      received: formatAmount(received, 9),
      paid_out: formatAmount(paidOut, 9),
      fees: formatAmount(fees, 9),
      fees_sol: formatAmount(feesSol, 9),
      rent_sol: formatAmount(rentSol, 9),
      difference: difference < 0n ? `-${formatAmount(-difference, 9)}` : formatAmount(difference, 9),
      escrows: subs,
    });
    expect(difference).toBeGreaterThan(0n);
    expect(seen["activity"]).toEqual([]);
    expect((seen["work"] as Json[]).map((item) => [item["intent"], item["paid"]])).toEqual([[jobIntent, true]]);

    const own = await ok(client, "wallet_history", { escrow: first });
    expect((own["activity"] as Json[]).map((item) => item["intent"])).toEqual([first]);
    expect(own["work"]).toEqual([]);
    expect(own).not.toHaveProperty("profit");
    const all = await ok(client, "wallet_history");
    expect((all["activity"] as Json[]).map((item) => item["intent"])).toEqual([second, first]);
    expect((await ok(client, "wallet_history", { since: String(at + 6n) }))["work"]).toEqual([]);
    expect((await ok(client, "wallet_history", { until: String(at + 5n) }))["work"]).toHaveLength(1);
    expect((await ok(client, "wallet_history", { until: String(at + 4n) }))["work"]).toEqual([]);

    expect((await call(client, "wallet_history", { paid_from: subs })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "paid_from", message: PROFIT_NEEDS_JOB }] });
    expect((await call(client, "wallet_history", { escrow: jobIntent, paid_from: [first, jobIntent] })).value).toMatchObject({
      code: "InvalidInput",
      issues: [{ path: "paid_from.1", message: notMadeHere }],
    });
    expect((await call(client, "wallet_history", { escrow: first, paid_from: [second] })).value).toMatchObject({ code: "NotReleased" });
    expect(walletHistory.description).toContain("paid_from adds profit");
  });
});
