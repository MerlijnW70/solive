import { type Address, generateKeyPairSigner } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { findAssociatedTokenAddress, IntentStatus, formatAmount } from "@intent-engine/core";
import { EVENT_IX_TAG, findIntentPda, getIntentAttestedEventEncoder, getIntentSplitEventEncoder, splitFee } from "@intent-engine/core/internal";
import { beforeEach, describe, expect, it } from "vitest";
import { type EngineTransaction } from "@intent-engine/client";
import { SIGNATURE_PAGE } from "@intent-engine/client/internal";
import { InvalidInput } from "../src/agent/schema.js";
import { LIFECYCLE_FETCHES, otherLifecycle, HISTORY_PAGES, RELEASE_UNKNOWN, releaseNotOf, releaseUnread, stillUnreleased } from "../src/agent/wallet.js";
import { EXIT_OK } from "../src/main.js";
import { NATIVE_MINT } from "@intent-engine/core";
import { LAMPORTS_PER_SOL } from "../src/wallet.js";
import { RELEASE_LANDING } from "../src/agent/wallet/receipt.js";
import { cli, creation, FEE_BPS, h } from "./harness.js";
import { attested, call, closeAccount, connect, connectThrough, createdAtOfEscrow, createdFrom, deliveryReleased, earlierTransfers, floodFetches, fresh, markFilled, ok, pagedThrough, preset, releasedEscrow, routedThrough, tag, zeroTransfers } from "./agent-wallet-kit.js";
import { approved } from "./approved.js";

describe("the wallet server's release history", () => {
  let client: Client;

  beforeEach(async () => {
    client = await fresh();
  });

  it("a receipt by release signature ignores any flood", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    const [intent] = await findIntentPda({ owner, nonce: 13n });
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
    const work = "d1".repeat(32);
    const release = { signature: "9".repeat(88), slot: 3n, blockTime: null, failed: false, emitted: [tag(attested)], feePayer: owner } satisfies EngineTransaction;
    const stray = { signature: "7".repeat(87) + "f", slot: 5n, blockTime: null, failed: false, emitted: [] };
    const flood = HISTORY_PAGES * SIGNATURE_PAGE + 2_000;
    const fetched: string[] = [];
    let log: EngineTransaction[] = [...zeroTransfers(flood), stray, release];
    h.through = pagedThrough(() => log, fetched);
    const paged = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    expect(await ok(paged, "wallet_receipt", { nonce: "13" })).toEqual({ intent, released: false, complete: false, next: RELEASE_UNKNOWN });
    fetched.length = 0;
    const receipt = { intent, released: true, attestor: owner, payee, signature: release.signature };
    expect(await ok(paged, "wallet_receipt", { nonce: "13", release: release.signature })).toMatchObject(receipt);
    expect(fetched).toEqual([release.signature]);
    log = [...zeroTransfers(flood), stray, ...zeroTransfers(flood, flood), release];
    fetched.length = 0;
    const plain = await connect(["mcp", "--url", "devnet"]);
    expect(await ok(plain, "get_receipt", { owner, nonce: "13", sha256: work, release: release.signature })).toMatchObject({ ...receipt, matches: false });
    expect(fetched).toEqual([release.signature]);
    const shown = await cli(["receipt", "--url", "devnet", "--owner", owner, "--nonce", "13", "--sha256", work, "--release", release.signature], {});
    expect([shown.code, shown.err]).toEqual([EXIT_OK, ""]);
    expect(shown.json()).toMatchObject({ ...receipt, matches: false });
    expect((await call(paged, "wallet_receipt", { nonce: "13", release: stray.signature })).value).toMatchObject({ code: "NotARelease", hint: releaseNotOf(stray.signature, intent) });
    expect((await call(paged, "wallet_receipt", { nonce: "13", release: "6".repeat(88) })).value).toMatchObject({ code: "ReleaseUnread", hint: releaseUnread("6".repeat(88)) });
    expect((await call(paged, "wallet_receipt", { nonce: "13", release: "l0" })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "release" }] });
    h.through = null;
    h.engineLog = [];
  });

  it("an unread transaction makes the receipt incomplete", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    const [intent] = await findIntentPda({ owner, nonce: 14n });
    const lagging = { signature: "5".repeat(87) + "f", slot: 2n, blockTime: null, failed: false, emitted: [], unread: true as const };
    h.engineLog = [creation(intent)];
    expect(await ok(client, "wallet_receipt", { nonce: "14" })).toEqual({ intent, released: false, next: stillUnreleased("wallet_receipt") });
    h.engineLog = [lagging, creation(intent)];
    expect(await ok(client, "wallet_receipt", { nonce: "14" })).toEqual({ intent, released: false, complete: false, next: RELEASE_UNKNOWN });
    const fetched: string[] = [];
    h.through = pagedThrough(() => [lagging, creation(intent)], fetched);
    const paged = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    expect(await ok(paged, "wallet_receipt", { nonce: "14" })).toEqual({ intent, released: false, complete: false, next: RELEASE_UNKNOWN });
    expect((await call(paged, "wallet_receipt", { nonce: "14", release: lagging.signature })).value).toMatchObject({ code: "ReleaseUnread" });
    h.through = pagedThrough(() => [creation(intent)], fetched);
    const kept = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    expect(await ok(kept, "wallet_receipt", { nonce: "14" })).toEqual({ intent, released: false, next: stillUnreleased("wallet_receipt") });
    h.through = pagedThrough(() => [], fetched);
    const empty = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    expect(await ok(empty, "wallet_receipt", { nonce: "14" })).toEqual({ intent, released: false, complete: false, next: RELEASE_UNKNOWN });
    h.through = null;
    h.engineLog = [];
  });

  it("a receipt for a closed escrow shows whole tokens", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    const [intent] = await findIntentPda({ owner, nonce: 15n });
    const mint = (await generateKeyPairSigner()).address;
    preset(mint, 6);
    const attestor = (await generateKeyPairSigner()).address;
    const tag = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);
    const { fee, net } = splitFee(3_000_000n, FEE_BPS);
    const split = getIntentSplitEventEncoder().encode({
      intent,
      owner,
      solver: attestor,
      attestor,
      amountIn: 3_000_000n,
      result: 1n,
      fee,
      net,
      partnerFee: 0n,
      recipients: 2,
      splitHash: new Uint8Array(32),
    });
    const vault = (await generateKeyPairSigner()).address;
    const elsewhere = (await generateKeyPairSigner()).address;
    const work = "a7".repeat(32);
    const release = {
      signature: "2".repeat(87) + "f",
      slot: 3n,
      blockTime: null,
      failed: false,
      emitted: [deliveryReleased(intent, attestor, attestor, attestor, work), tag(split)],
      feePayer: attestor,
      tokens: [
        { account: elsewhere, mint: NATIVE_MINT, owner: elsewhere },
        { account: vault, mint, owner: intent },
      ],
    } satisfies EngineTransaction;
    h.engineLog = [{ ...release, tokens: [] }];
    expect(await ok(client, "wallet_receipt", { nonce: "15" })).toMatchObject({ released: true, paid: `${net} raw units` });
    h.engineLog = [release];
    expect(await ok(client, "wallet_receipt", { nonce: "15", sha256: work })).toMatchObject({
      intent,
      released: true,
      paid: formatAmount(net, 6),
      mint: expect.any(String),
      attestor,
      result: "1",
      recipients: "2",
      signature: release.signature,
      delivered_sha256: work,
      matches: true,
    });
    expect(await ok(client, "wallet_receipt", { nonce: "15", release: release.signature })).toMatchObject({ paid: formatAmount(net, 6) });
    const payee = (await generateKeyPairSigner()).address;
    const attested = getIntentAttestedEventEncoder().encode({
      intent,
      owner,
      solver: attestor,
      payee,
      attestor,
      amountIn: 3_000_000n,
      result: 1n,
      fee,
      net,
      filled: 3_000_000n,
      remaining: 0n,
      partnerFee: 0n,
    });
    h.engineLog = [{ ...release, emitted: [tag(attested)], tokens: [{ account: payee, mint, owner: owner }] }];
    expect(await ok(client, "wallet_receipt", { nonce: "15" })).toMatchObject({ payee, paid: formatAmount(net, 6) });
    h.engineLog = [];
  });

  it("a release from an earlier lifecycle of the same address is refused", async () => {
    const { wallet, owner, intent, nonce, attestedTo } = await releasedEscrow(client, "53");
    const payee = await findAssociatedTokenAddress({ owner: (await generateKeyPairSigner()).address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const first = createdFrom(intent);
    const earlier = { signature: "3".repeat(87) + "e", slot: 3n, blockTime: null, failed: false, emitted: [attestedTo(payee)], feePayer: wallet } satisfies EngineTransaction;
    const remade = { ...first, signature: "remade", slot: 5n };
    const args = { owner, nonce, release: earlier.signature };
    const refused = { code: "OtherLifecycle", hint: otherLifecycle(earlier.signature, intent) };
    h.engineLog = [earlier, first];
    expect(await ok(client, "wallet_receipt", args)).toMatchObject({ intent, released: true, payee, signature: earlier.signature });
    h.engineLog = [remade, earlier, first];
    expect((await call(client, "wallet_receipt", args)).value).toMatchObject(refused);
    expect(await ok(client, "wallet_receipt", { owner, nonce })).toEqual({ intent, released: false, complete: false, next: RELEASE_LANDING });
    const dated = { ...earlier, blockTime: createdAtOfEscrow(intent) - 1n };
    h.through = pagedThrough(() => [remade, dated, first], []);
    const paged = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    expect((await call(paged, "wallet_receipt", args)).value).toMatchObject(refused);
    markFilled(intent, IntentStatus.Open);
    h.through = pagedThrough(() => [remade, earlier, first], []);
    const reopened = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    expect((await call(reopened, "wallet_receipt", args)).value).toMatchObject(refused);
    h.through = null;
    closeAccount(intent);
    expect((await call(client, "wallet_receipt", args)).value).toMatchObject(refused);
    expect(await ok(client, "wallet_receipt", { owner, nonce })).toEqual({ intent, released: false, next: stillUnreleased("wallet_receipt") });
    h.engineLog = [earlier, first];
    expect(await ok(client, "wallet_receipt", args)).toMatchObject({ intent, released: true, signature: earlier.signature });
    h.engineLog = [];
  });

  it("a flood before the release does not make a named receipt fetch it", async () => {
    const { wallet, owner, intent, nonce, attestedTo } = await releasedEscrow(client, "56");
    const payee = await findAssociatedTokenAddress({ owner: (await generateKeyPairSigner()).address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const work = "f6".repeat(32);
    const createdAt = createdAtOfEscrow(intent);
    const made = { ...createdFrom(intent), blockTime: createdAt };
    const release = {
      signature: "5".repeat(87) + "d",
      slot: 3n,
      blockTime: createdAt + 5n,
      failed: false,
      emitted: [attestedTo(payee)],
      feePayer: wallet,
    } satisfies EngineTransaction;
    const flood = 4 * LIFECYCLE_FETCHES;
    const args = { owner, nonce, sha256: work, release: release.signature };
    const receipt = { intent, released: true, signature: release.signature, matches: false };
    const fetched: string[] = [];
    const before = [release, ...earlierTransfers(flood), made];
    const around = [...zeroTransfers(flood, flood), ...before];
    for (const log of [before, around]) {
      fetched.length = 0;
      const routed = await connectThrough(routedThrough(new Map(), log, fetched));
      const read = await ok(routed, "wallet_receipt", args);
      expect(read).toMatchObject(receipt);
      expect(read).not.toHaveProperty("complete");
      expect(floodFetches(fetched)).toBe(0);
      expect(fetched.length).toBeLessThanOrEqual(2);
    }
    closeAccount(intent);
    fetched.length = 0;
    const closed = await connectThrough(routedThrough(new Map(), around, fetched));
    expect(await ok(closed, "wallet_receipt", args)).toMatchObject(receipt);
    expect(fetched.length).toBeLessThanOrEqual(LIFECYCLE_FETCHES + 1);
    h.through = null;
    h.engineLog = [];
  });

  it("wait reports the payout of an owned escrow as paid out", async () => {
    const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
    h.engineLog = [];
    const escrow = await ok(client, "wallet_escrow", await approved(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: wallet, min_result: "1", max_result: "1", spec_hash: "5e".repeat(32) }));
    const intent = escrow["intent"] as Address;
    const tag = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);
    const { fee, net } = splitFee(LAMPORTS_PER_SOL / 20n, FEE_BPS);
    const worker = (await generateKeyPairSigner()).address;
    const payee = await findAssociatedTokenAddress({ owner: worker, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const attested = getIntentAttestedEventEncoder().encode({
      intent,
      owner: wallet,
      solver: wallet,
      payee,
      attestor: wallet,
      amountIn: LAMPORTS_PER_SOL / 20n,
      result: 1n,
      fee,
      net,
      filled: LAMPORTS_PER_SOL / 20n,
      remaining: 0n,
      partnerFee: 0n,
    });
    const vault = (await generateKeyPairSigner()).address;
    const release = {
      signature: "5".repeat(87) + "e",
      slot: 3n,
      blockTime: null,
      failed: false,
      emitted: [tag(attested)],
      feePayer: wallet,
      tokens: [{ account: vault, mint: NATIVE_MINT, owner: intent }],
    } satisfies EngineTransaction;
    const made = createdFrom(intent);
    markFilled(intent);
    h.engineLog = [release, made];
    const paid = { intent, status: "filled", waited: 0, paid_out: formatAmount(net, 9), token: "SOL", signature: release.signature };
    const shown = await ok(client, "wallet_wait", { nonce: escrow["nonce"] });
    expect(shown).toEqual(paid);
    expect(shown).not.toHaveProperty("received");
    closeAccount(intent);
    expect(await ok(client, "wallet_wait", { nonce: escrow["nonce"] })).toEqual({ ...paid, status: "filled" });
    const later = { ...made, signature: "remade", slot: 5n };
    h.engineLog = [later, release, made];
    expect(await ok(client, "wallet_wait", { nonce: escrow["nonce"] })).toEqual({ intent, status: "closed", waited: 0 });
    const marked = { ...release };
    let log: EngineTransaction[] = [marked, made];
    h.through = pagedThrough(() => log, []);
    const paged = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    expect(await ok(paged, "wallet_wait", { nonce: escrow["nonce"] })).toEqual({ ...paid, signature: marked.signature });
    log = [later, marked, made];
    expect(await ok(paged, "wallet_wait", { nonce: escrow["nonce"] })).toEqual({ intent, status: "closed", waited: 0 });
    h.through = null;
    h.engineLog = [];
  });
});
