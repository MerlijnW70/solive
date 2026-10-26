import { type Address, generateKeyPairSigner } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { findAssociatedTokenAddress, formatAmount } from "@intent-engine/core";
import { EVENT_IX_TAG, findIntentPda, getIntentCreatedEventEncoder, getIntentAttestedEventEncoder, splitFee } from "@intent-engine/core/internal";
import { beforeEach, describe, expect, it } from "vitest";
import { testSignature } from "@intent-engine/client/testing";
import { type EngineTransaction, type ListedSignature } from "@intent-engine/client";
import { SIGNATURE_PAGE } from "@intent-engine/client/internal";
import { InvalidInput } from "../src/agent/schema.js";
import { HISTORY_PAGES, RELEASE_UNKNOWN, PAID_WRAPPED, WAIT_SCAN, NO_CLOCK, getReceipt, stillUnreleased, WAIT_MAX } from "../src/agent/wallet.js";
import { invoke } from "../src/agent/actions.js";
import { claimsOf } from "../src/agent/claims.js";
import { DEVNET_TEST_MINT as TEST_TOKEN, NATIVE_MINT } from "@intent-engine/core";
import { LAMPORTS_PER_SOL } from "../src/wallet.js";
import { stillUnknown } from "../src/agent/wallet/receipt.js";
import { creation, FEE_BPS, h, transport } from "./harness.js";
import { PAGED_ADDRESS, attested, call, connect, created, createdFrom, deliveryReleased, fresh, indexing, ok, pagedThrough, releasedEscrow, tag, tokenAccountAt, transferSignature, zeroTransfers } from "./agent-wallet-kit.js";

describe("the wallet server's receipts", () => {
  let client: Client;

  beforeEach(async () => {
    client = await fresh();
  });

  it("shows an escrow's release and checks received work against the hash the release recorded", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    const [intent] = await findIntentPda({ owner, nonce: 7n });
    const payee = await findAssociatedTokenAddress({ owner: (await generateKeyPairSigner()).address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    h.engineLog = [];
    expect(await ok(client, "wallet_receipt", { nonce: "7" })).toEqual({ intent, released: false, complete: false, next: RELEASE_UNKNOWN });
    h.engineLog = [creation(intent)];
    expect(await ok(client, "wallet_receipt", { nonce: "7" })).toEqual({ intent, released: false, next: stillUnreleased("wallet_receipt") });
    const tag = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);
    const { fee, net } = splitFee(LAMPORTS_PER_SOL / 20n, FEE_BPS);
    const attested = getIntentAttestedEventEncoder().encode({
      intent,
      owner,
      solver: owner,
      payee,
      attestor: owner,
      amountIn: LAMPORTS_PER_SOL / 20n,
      result: 2n,
      fee,
      net,
      filled: LAMPORTS_PER_SOL / 20n,
      remaining: 0n,
      partnerFee: 0n,
    });
    const work = "b".repeat(64);
    const worker = (await generateKeyPairSigner()).address;
    const announcement = (await generateKeyPairSigner()).address;
    const released = { signature: testSignature("release"), slot: 3n, blockTime: null, failed: false, emitted: [deliveryReleased(intent, announcement, worker, owner, work), tag(attested)] };
    h.engineLog = [{ ...released, signature: testSignature("failed"), failed: true }, released];
    expect(await ok(client, "wallet_receipt", { owner, nonce: "7", sha256: work.toUpperCase() })).toEqual({
      intent,
      released: true,
      payee,
      paid: `${net} raw units`,
      attestor: owner,
      result: "2",
      signature: testSignature("release"),
      delivered_sha256: work,
      delivered_salt: "ab".repeat(16),
      matches: true,
      announcement,
      seq: "1",
      announcer: worker,
      standing_complete: false,
    });
    const created = getIntentCreatedEventEncoder().encode({
      intent,
      owner,
      nonce: 7n,
      kind: 4,
      inputMint: NATIVE_MINT,
      outputMint: TEST_TOKEN,
      receiver: owner,
      escrowed: LAMPORTS_PER_SOL / 20n,
      expiresAt: 0n,
      rentPayer: owner,
      flags: 0,
      bounty: 0,
      createFee: 0,
    });
    h.engineLog = [{ ...released, emitted: [tag(attested)] }, { signature: testSignature("create"), slot: 1n, blockTime: null, failed: false, emitted: [tag(created)] }];
    const plain = await ok(client, "wallet_receipt", { nonce: "7", sha256: work });
    expect(plain).toMatchObject({ paid: formatAmount(net, 9), matches: false });
    expect(plain).not.toHaveProperty("delivered_sha256");
    expect((await call(client, "wallet_receipt", { nonce: "7", sha256: "xyz" })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "sha256" }] });
  });

  it("receipt waits for a release when given wait and reads once without it", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    const [intent] = await findIntentPda({ owner, nonce: 7n });
    const payee = await findAssociatedTokenAddress({ owner: (await generateKeyPairSigner()).address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const tag = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);
    const { fee, net } = splitFee(LAMPORTS_PER_SOL / 20n, FEE_BPS);
    const attested = getIntentAttestedEventEncoder().encode({
      intent,
      owner,
      solver: owner,
      payee,
      attestor: owner,
      amountIn: LAMPORTS_PER_SOL / 20n,
      result: 2n,
      fee,
      net,
      filled: LAMPORTS_PER_SOL / 20n,
      remaining: 0n,
      partnerFee: 0n,
    });
    const released = { signature: testSignature("release"), slot: 3n, blockTime: null, failed: false, emitted: [tag(attested)] };
    const paid = { intent, released: true, payee, paid: `${net} raw units`, attestor: owner, result: "2", signature: testSignature("release") };
    const tools = [
      ["wallet_receipt", { nonce: "7" }],
      ["get_receipt", { owner, nonce: "7" }],
    ] as const;
    h.rounds = 10;
    for (const [name, args] of tools) {
      h.engineLog = [released];
      h.sleeps.length = 0;
      expect(await ok(client, name, { ...args, wait: 5 })).toEqual(paid);
      expect(h.sleeps).toEqual([]);
      expect(await ok(client, name, args)).toEqual(paid);
      h.engineLog = [creation(intent)];
      h.onSleep = [() => undefined, () => (h.engineLog = [released])];
      expect(await ok(client, name, { ...args, wait: 5 })).toEqual(paid);
      expect(h.sleeps).toEqual([1, 1]);
      h.engineLog = [creation(intent)];
      h.sleeps.length = 0;
      expect(await ok(client, name, { ...args, wait: 3 })).toEqual({ intent, released: false, next: stillUnreleased(name) });
      expect(h.sleeps).toEqual([1, 1, 1]);
      h.sleeps.length = 0;
      expect(await ok(client, name, args)).toEqual({ intent, released: false, next: stillUnreleased(name) });
      expect(h.sleeps).toEqual([]);
      h.engineLog = [];
      expect(await ok(client, name, { ...args, wait: 1 })).toEqual({ intent, released: false, complete: false, next: stillUnknown(name) });
      expect(await ok(client, name, args)).toEqual({ intent, released: false, complete: false, next: RELEASE_UNKNOWN });
      expect((await call(client, name, { ...args, wait: WAIT_MAX + 1 })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "wait" }] });
      expect((await call(client, name, { ...args, wait: 0 })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "wait" }] });
    }
    expect(stillUnreleased("get_receipt")).toContain("solive_get_receipt again with wait, in seconds");
    h.sleeps.length = 0;
    h.rounds = 2;
    h.engineLog = [creation(intent)];
    expect(await ok(client, "wallet_receipt", { nonce: "7", wait: WAIT_MAX })).toEqual({ intent, released: false, next: stillUnreleased("wallet_receipt") });
    expect(h.sleeps).toEqual([1, 1]);
    const bare = { transport, relay: undefined, agent: undefined, claims: claimsOf() };
    expect(await invoke(getReceipt, bare, { owner, nonce: "7", wait: 1 })).toEqual({ ok: false, problem: expect.objectContaining({ code: "NoClock", hint: NO_CLOCK }) });
    expect(await invoke(getReceipt, bare, { owner, nonce: "7" })).toMatchObject({ ok: true });
  });

  it("a receipt is found after many later transactions", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    const [intent] = await findIntentPda({ owner, nonce: 9n });
    const payee = await findAssociatedTokenAddress({ owner: (await generateKeyPairSigner()).address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const tag = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);
    const { fee, net } = splitFee(LAMPORTS_PER_SOL / 20n, FEE_BPS);
    const attested = getIntentAttestedEventEncoder().encode({
      intent,
      owner,
      solver: owner,
      payee,
      attestor: owner,
      amountIn: LAMPORTS_PER_SOL / 20n,
      result: 1n,
      fee,
      net,
      filled: LAMPORTS_PER_SOL / 20n,
      remaining: 0n,
      partnerFee: 0n,
    });
    const work = "d7".repeat(32);
    const release = { signature: testSignature("release"), slot: 3n, blockTime: null, failed: false, emitted: [deliveryReleased(intent, owner, owner, owner, work), tag(attested)] };
    const dust = (count: number) => Array.from({ length: count }, (_, i) => ({ signature: testSignature(`dust${i}`), slot: 9n, blockTime: null, failed: false, emitted: [] }));
    const receipt = { intent, released: true, signature: testSignature("release"), delivered_sha256: work, matches: true };
    h.engineLog = [...dust(WAIT_SCAN * 2), release];
    h.through = { ...transport, engineTransactions: async (limit) => h.engineLog.slice(0, limit) };
    const windowed = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    expect(await ok(windowed, "wallet_receipt", { nonce: "9", sha256: work })).toMatchObject(receipt);
    h.engineLog = [...dust(SIGNATURE_PAGE + 10), release];
    const listed = (tx: EngineTransaction): ListedSignature => ({ signature: tx.signature, slot: tx.slot, blockTime: tx.blockTime, failed: tx.failed, memo: null });
    h.through = {
      ...transport,
      engineTransactions: async (limit) => h.engineLog.slice(0, limit),
      signaturesOf: async (_, limit, before) => {
        const start = before === undefined ? 0 : h.engineLog.findIndex((tx) => tx.signature === before) + 1;
        return h.engineLog.slice(start, start + limit).map(listed);
      },
      transactionsOf: async (wanted) => wanted.flatMap((entry) => h.engineLog.filter((tx) => tx.signature === entry.signature)),
    };
    const paged = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    expect(await ok(paged, "wallet_receipt", { nonce: "9", sha256: work })).toMatchObject(receipt);
    const plain = await connect(["mcp", "--url", "devnet"]);
    expect(await ok(plain, "get_receipt", { owner, nonce: "9", sha256: work })).toMatchObject(receipt);
    h.through = null;
    h.engineLog = [];
  });

  it("the fake rpc pages ten thousand entries quickly", async () => {
    let log = zeroTransfers(10_000);
    const fetched: string[] = [];
    const paged = pagedThrough(() => log, fetched);
    const builds = indexing.builds;
    const listed: string[] = [];
    let before: string | undefined;
    for (let page = 0; page < 10; page++) {
      const entries = await paged.signaturesOf(PAGED_ADDRESS, SIGNATURE_PAGE, before);
      expect(entries).toHaveLength(SIGNATURE_PAGE);
      listed.push(...entries.map((entry) => entry.signature));
      expect((await paged.transactionsOf(entries)).map((tx) => tx.signature)).toEqual(entries.map((entry) => entry.signature));
      before = entries.at(-1)?.signature;
    }
    expect(listed).toEqual(log.map((tx) => tx.signature));
    expect(fetched).toEqual(listed);
    expect(await paged.signaturesOf(PAGED_ADDRESS, SIGNATURE_PAGE, before)).toEqual([]);
    expect(await paged.transactionOf(transferSignature(9_999))).toBe(log[9_999]);
    expect(await paged.transactionOf("missing")).toBeNull();
    expect(indexing.builds - builds).toBe(1);
    log = zeroTransfers(12_000);
    expect((await paged.signaturesOf(PAGED_ADDRESS, SIGNATURE_PAGE, transferSignature(10_999))).map((entry) => entry.signature)).toEqual(
      Array.from({ length: SIGNATURE_PAGE }, (_, i) => transferSignature(11_000 + i)),
    );
    expect(await paged.transactionOf(transferSignature(11_999))).toBe(log[11_999]);
    expect(indexing.builds - builds).toBe(2);
  });

  it("a receipt that hits the page cap says it is incomplete", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    const [intent] = await findIntentPda({ owner, nonce: 12n });
    const tag = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);
    const { fee, net } = splitFee(LAMPORTS_PER_SOL / 20n, FEE_BPS);
    const attested = getIntentAttestedEventEncoder().encode({
      intent,
      owner,
      solver: owner,
      payee: owner,
      attestor: owner,
      amountIn: LAMPORTS_PER_SOL / 20n,
      result: 1n,
      fee,
      net,
      filled: LAMPORTS_PER_SOL / 20n,
      remaining: 0n,
      partnerFee: 0n,
    });
    const plain = { signature: testSignature("plain"), slot: 3n, blockTime: null, failed: false, emitted: [tag(attested)], feePayer: owner };
    const fetched: string[] = [];
    let log: EngineTransaction[] = [...zeroTransfers(HISTORY_PAGES * SIGNATURE_PAGE), plain];
    h.through = pagedThrough(() => log, fetched);
    const paged = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    expect(await ok(paged, "wallet_receipt", { nonce: "12" })).toEqual({ intent, released: false, complete: false, next: RELEASE_UNKNOWN });
    expect(fetched).toHaveLength(HISTORY_PAGES * SIGNATURE_PAGE);
    log = [...zeroTransfers(HISTORY_PAGES * SIGNATURE_PAGE - 1), plain];
    expect(await ok(paged, "wallet_receipt", { nonce: "12" })).toMatchObject({ intent, released: true, signature: plain.signature });
    log = zeroTransfers(10);
    expect(await ok(paged, "wallet_receipt", { nonce: "12" })).toEqual({ intent, released: false, complete: false, next: RELEASE_UNKNOWN });
    log = [...zeroTransfers(10), creation(intent)];
    expect(await ok(paged, "wallet_receipt", { nonce: "12" })).toEqual({ intent, released: false, next: stillUnreleased("wallet_receipt") });
    h.through = null;
    h.engineLog = [];
  });

  it("tells a wallet paid in wrapped SOL how to turn it into SOL, and nobody else", async () => {
    const { wallet, owner, intent, nonce, attestedTo } = await releasedEscrow(client, "56");
    const payee = (await generateKeyPairSigner()).address;
    tokenAccountAt(payee, wallet);
    const release = (holder: Address) =>
      ({
        signature: testSignature("wrapped release"),
        slot: 3n,
        blockTime: null,
        failed: false,
        emitted: [attestedTo(payee)],
        feePayer: wallet,
        tokens: [{ account: payee, mint: NATIVE_MINT, owner: holder }],
      }) satisfies EngineTransaction;
    h.engineLog = [release(wallet), createdFrom(intent)];
    const paid = await ok(client, "wallet_receipt", { owner, nonce });
    expect(paid).toMatchObject({ released: true, paid_to: wallet, mint: NATIVE_MINT });
    expect(paid["next"]).toContain(PAID_WRAPPED);
    const other = (await generateKeyPairSigner()).address;
    h.engineLog = [release(other), createdFrom(intent)];
    const theirs = await ok(client, "wallet_receipt", { owner, nonce });
    expect(theirs).toMatchObject({ released: true, paid_to: other });
    expect(String(theirs["next"] ?? "")).not.toContain(PAID_WRAPPED);
    h.engineLog = [];
  });

  it("plain mode reads a receipt", async () => {
    const plain = await connect(["mcp", "--url", "devnet"]);
    const owner = (await generateKeyPairSigner()).address;
    const [intent] = await findIntentPda({ owner, nonce: 7n });
    const payee = await findAssociatedTokenAddress({ owner: (await generateKeyPairSigner()).address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    h.engineLog = [creation(intent)];
    expect(await ok(plain, "get_receipt", { owner, nonce: "7" })).toEqual({ intent, released: false, next: stillUnreleased("get_receipt") });
    expect((await call(plain, "get_receipt", { nonce: "7" })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "owner" }] });
    const tag = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);
    const { fee, net } = splitFee(LAMPORTS_PER_SOL / 20n, FEE_BPS);
    const attested = getIntentAttestedEventEncoder().encode({
      intent,
      owner,
      solver: owner,
      payee,
      attestor: owner,
      amountIn: LAMPORTS_PER_SOL / 20n,
      result: 1n,
      fee,
      net,
      filled: LAMPORTS_PER_SOL / 20n,
      remaining: 0n,
      partnerFee: 0n,
    });
    const work = "c".repeat(64);
    h.engineLog = [{ signature: testSignature("release"), slot: 3n, blockTime: null, failed: false, emitted: [deliveryReleased(intent, owner, owner, owner, work), tag(attested)] }];
    const receipt = { intent, released: true, payee, paid: `${net} raw units`, attestor: owner, result: "1", signature: testSignature("release"), delivered_sha256: work, matches: true, announcer: owner };
    expect(await ok(plain, "get_receipt", { owner, nonce: "7", sha256: work })).toMatchObject(receipt);
    await ok(client, "wallet_setup");
    expect(await ok(client, "wallet_receipt", { owner, nonce: "7", sha256: work })).toMatchObject(receipt);
    h.engineLog = [];
  });
});
