import { type Address, generateKeyPairSigner, getBase16Decoder } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { findAssociatedTokenAddress, Kind, formatAmount } from "@intent-engine/core";
import { getIntentDecoder, decodeParams, INTENT_ENGINE_PROGRAM_ADDRESS, splitFee, WARN_ATTESTOR, WARN_PROOF } from "@intent-engine/core/internal";
import { beforeEach, describe, expect, it } from "vitest";
import { BlockhashExpired } from "@intent-engine/client";
import { NO_SPEC_HASH } from "../src/agent/wallet/escrow.js";
import { WRAPPED } from "../src/agent/create.js";
import { InvalidInput } from "../src/agent/schema.js";
import { notAWallet, TOKEN_ACCOUNT_RECIPIENT } from "../src/agent/owner.js";
import { DELIVERED_NEEDED, notAttestor, notEarliest, piecesMayHaveLanded, piecesPartlySent, RELEASE_CHANGED, PREVIEW_ONLY, PREVIEW_APPROVAL_NEXT } from "../src/agent/wallet.js";
import { NATIVE_MINT } from "@intent-engine/core";
import { LAMPORTS_PER_SOL } from "../src/wallet.js";
import { balance, FEE_BPS, h, setNow } from "./harness.js";
import { attested, call, connect, created, fresh, type Json, ok } from "./agent-wallet-kit.js";
import { announced, keyed } from "./announce.js";
import { PAY_TO_NEEDED } from "../src/agent/wallet.js";

describe("the wallet server's escrows", () => {
  let client: Client;

  beforeEach(async () => {
    client = await fresh();
  });

  it("escrows a payment that only the named attestor can release, to the wallet it names", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    const worker = (await generateKeyPairSigner()).address;
    const stranger = (await generateKeyPairSigner()).address;
    const preview = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: owner });
    expect(preview).toMatchObject({ sent: false, next: PREVIEW_ONLY, warnings: expect.arrayContaining([WARN_ATTESTOR]) });
    expect(h.svm.getAccount(preview["intent"] as Address).exists).toBe(false);
    const escrow = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: owner, min_result: "1", max_result: "3", send: true });
    const intent = escrow["intent"] as Address;
    const nonce = escrow["nonce"] as string;
    expect(h.svm.getAccount(intent).exists).toBe(true);
    const release = { owner, nonce, pay_to: worker };
    expect((await call(client, "wallet_attest", { ...release, result: "4" })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "result" }] });
    h.simulated.length = 0;
    const shown = await ok(client, "wallet_attest", release);
    expect(shown).toMatchObject({ sent: false, next: PREVIEW_APPROVAL_NEXT });
    expect(h.simulated).toEqual([]);
    expect(shown["summary"][0]).toContain(WRAPPED);
    const wrapped = await findAssociatedTokenAddress({ owner, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect((await call(client, "wallet_attest", { ...release, pay_to: wrapped })).value).toMatchObject({
      code: "InvalidInput",
      issues: [{ path: "pay_to", message: TOKEN_ACCOUNT_RECIPIENT }],
    });
    const payee = await findAssociatedTokenAddress({ owner: worker, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const { fee, net } = splitFee(LAMPORTS_PER_SOL / 20n, FEE_BPS);
    expect(shown).toMatchObject({ intent, pay_to: worker, payee, result: "1", paid: formatAmount(net, 9), fee: formatAmount(fee, 9), sent: false });
    expect(shown["summary"][0]).toBe(`Pays: ${formatAmount(net, 9)} of SOL to ${worker} from ${owner}'s escrow${WRAPPED}`);
    expect(shown["summary"]).toContain(`Setup: creates ${worker}'s SOL account, paid by this wallet: ${formatAmount(h.svm.minimumBalanceForRentExemption(165n), 9)} SOL of rent`);
    expect(shown["summary"]).toContain(`Setup: creates the engine treasury's SOL account for the fee, paid by this wallet: ${formatAmount(h.svm.minimumBalanceForRentExemption(165n), 9)} SOL of rent`);
    expect(JSON.stringify(shown)).not.toMatch(/transaction/);
    expect(h.svm.getAccount(payee).exists).toBe(false);
    expect((await call(client, "wallet_attest", { ...release, pay_to: intent })).value).toMatchObject({
      code: "InvalidInput",
      issues: [{ path: "pay_to", message: notAWallet(INTENT_ENGINE_PROGRAM_ADDRESS) }],
    });
    const changed = { code: "ReleaseChanged", hint: RELEASE_CHANGED };
    expect((await call(client, "wallet_attest", { ...release, result: "2", send: true })).value).toMatchObject(changed);
    expect((await call(client, "wallet_attest", { ...release, result: "2", approval: shown["approval"], send: true })).value).toMatchObject(changed);
    const second = await ok(client, "wallet_attest", { ...release, result: "2" });
    expect(second["approval"]).toMatch(/^[0-9a-f]{16}$/);
    expect(second["approval"]).not.toBe(shown["approval"]);
    expect(second).not.toHaveProperty("delivered_sha256");
    expect((await call(client, "wallet_attest", { ...release, result: "1", approval: second["approval"], send: true })).value).toMatchObject(changed);
    expect((await call(client, "wallet_attest", { owner, nonce })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "pay_to", message: PAY_TO_NEEDED }] });
    expect(h.svm.getAccount(payee).exists).toBe(false);
    expect(await ok(client, "wallet_attest", { ...release, result: "2", approval: second["approval"], send: true })).toMatchObject({
      sent: true,
      signature: expect.any(String),
    });
    expect(balance(payee)).toBe(net);
    expect((await call(client, "wallet_attest", release)).value).toMatchObject({ code: "InvalidTransition" });
    const other = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.01", attestor: stranger, send: true });
    expect((await call(client, "wallet_attest", { owner, nonce: other["nonce"], pay_to: worker, send: true })).value).toMatchObject({
      code: "Unauthorized",
      hint: notAttestor(stranger),
    });
    expect((await call(client, "wallet_attest", { owner, nonce: "99", pay_to: worker })).value).toMatchObject({ code: "NotFound" });
    expect(await ok(client, "wallet_cancel", { nonce: other["nonce"], send: true })).toMatchObject({ sent: true });
    expect(h.svm.getAccount(other["intent"] as Address).exists).toBe(false);
    const brief = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.01", attestor: owner, expires_in: 60, send: true });
    setNow(h.svm.getClock().unixTimestamp + 3_600n);
    expect((await call(client, "wallet_attest", { owner, nonce: brief["nonce"], pay_to: worker })).value).toMatchObject({ code: "IntentExpired" });
  });

  it("escrows a proof intent that binds a spec, pays the first announcement that opens to the work and the judge out of the escrow", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    const specHash = "6a".repeat(32);
    expect((await call(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: owner, judge_fee: "0.001" })).value).toMatchObject({
      code: "InvalidInput",
      issues: [{ path: "judge_fee" }],
    });
    const escrow = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: owner, min_result: "1", max_result: "1", spec_hash: specHash, judge_fee: "0.001", send: true });
    expect(escrow["warnings"]).toContain(WARN_PROOF);
    expect(escrow["warnings"]).not.toContain(WARN_ATTESTOR);
    const intent = escrow["intent"] as Address;
    const nonce = escrow["nonce"] as string;
    const account = h.svm.getAccount(intent);
    if (!account.exists) {
      throw new Error("the proof intent was not created");
    }
    const held = getIntentDecoder().decode(account.data);
    const params = decodeParams(held.kind, Uint8Array.from(held.params));
    expect(params.kind).toBe(Kind.AttestedResult);
    if (params.kind === Kind.AttestedResult) {
      expect(getBase16Decoder().decode(params.specHash)).toBe(specHash);
      expect(params.judgeFee).toBe(LAMPORTS_PER_SOL / 1_000n);
    }
    const work = "ab".repeat(32);
    const release = { owner, nonce, delivered_sha256: work };
    expect((await call(client, "wallet_attest", { owner, nonce })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "delivered_sha256", message: DELIVERED_NEEDED }] });
    expect((await call(client, "wallet_attest", release)).value).toMatchObject({ code: "AnnouncementsIncomplete" });
    const copier = await keyed();
    await announced(intent, copier, "cd".repeat(32));
    const worker = await keyed();
    const made = await announced(intent, worker, work);
    expect((await call(client, "wallet_attest", { ...release, pay_to: copier.address })).value).toMatchObject({ code: "NotEarliestAnnouncer", hint: notEarliest(worker.address, work) });
    expect((await call(client, "wallet_attest", { ...release, delivered_sha256: "ef".repeat(32) })).value).toMatchObject({ code: "NotAnnounced" });
    const shown = await ok(client, "wallet_attest", { ...release, delivered_sha256: work.toUpperCase() });
    expect(shown).toMatchObject({ pay_to: worker.address, announcement: made.announcement, seq: "2", delivered_sha256: work, sent: false });
    expect(shown["warnings"]).toEqual([WARN_PROOF]);
    expect(shown["summary"]).toEqual(expect.arrayContaining([expect.stringContaining("Pays the judge"), expect.stringContaining(`Binds: the result to the committed spec ${specHash}`)]));
    const settled = await ok(client, "wallet_attest", { ...release, approval: shown["approval"], send: true });
    const judgeFee = LAMPORTS_PER_SOL / 1_000n;
    const { fee } = splitFee(LAMPORTS_PER_SOL / 20n - judgeFee, FEE_BPS);
    expect(settled["paid"]).toBe(formatAmount(LAMPORTS_PER_SOL / 20n - judgeFee - fee, 9));
    const workerAta = await findAssociatedTokenAddress({ owner: worker.address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const judgeAta = await findAssociatedTokenAddress({ owner, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(balance(workerAta)).toBe(LAMPORTS_PER_SOL / 20n - judgeFee - fee);
    expect(balance(judgeAta)).toBe(judgeFee);
  });

  it("escrows a task's pieces in one plan: one preview with the total, one send, each piece released on its own", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    const other = (await generateKeyPairSigner()).address;
    const worker = (await generateKeyPairSigner()).address;
    const plan = {
      sell: "SOL",
      attestor: owner,
      pieces: [
        { name: "parser", amount: "0.01" },
        { name: "api client", amount: "0.02", attestor: other },
        { name: "page", amount: "0.01" },
      ],
    };
    h.watched.push(owner);
    const preview = await ok(client, "wallet_escrow_plan", plan);
    expect(preview).toMatchObject({
      total: "0.04",
      sent: false,
      next: PREVIEW_ONLY,
      pieces: [
        { name: "parser", amount: "0.01", attestor: owner },
        { name: "api client", amount: "0.02", attestor: other },
        { name: "page", amount: "0.01", attestor: owner },
      ],
      warnings: [WARN_ATTESTOR, `Piece 1 (parser): ${NO_SPEC_HASH}`, `Piece 2 (api client): ${NO_SPEC_HASH}`, `Piece 3 (page): ${NO_SPEC_HASH}`],
    });
    expect(preview["pieces"][0]).not.toHaveProperty("intent");
    expect(preview["summary"].slice(0, 4)).toEqual([
      "Plan: 3 pieces, 0.04 of SOL in all, each escrowed now and released on its own",
      `Piece 1: parser, 0.01 of SOL, released by ${owner}`,
      `Piece 2: api client, 0.02 of SOL, released by ${other}`,
      `Piece 3: page, 0.01 of SOL, released by ${owner}`,
    ]);
    expect((await ok(client, "wallet_intents"))["intents"]).toEqual([]);
    const sent = await ok(client, "wallet_escrow_plan", { ...plan, send: true });
    expect(sent).toMatchObject({ sent: true, total: "0.04", pieces: [0, 1, 2].map((i) => ({ nonce: String(i), signature: expect.any(String) })) });
    expect(sent["next"]).toContain("pieces escrowed");
    const listed = ((await ok(client, "wallet_intents"))["intents"] as Json[]).sort((a, b) => Number(a["nonce"]) - Number(b["nonce"]));
    expect(listed.map((intent) => intent["order"])).toEqual([
      expect.objectContaining({ kind: "attested", amount_in: String(LAMPORTS_PER_SOL / 100n), attestor: owner }),
      expect.objectContaining({ kind: "attested", amount_in: String(LAMPORTS_PER_SOL / 50n), attestor: other }),
      expect.objectContaining({ kind: "attested", amount_in: String(LAMPORTS_PER_SOL / 100n), attestor: owner }),
    ]);
    const release = { owner, nonce: "0", pay_to: worker };
    const shown = await ok(client, "wallet_attest", release);
    expect(await ok(client, "wallet_attest", { ...release, approval: shown["approval"], send: true })).toMatchObject({ sent: true });
    expect((await call(client, "wallet_attest", { owner, nonce: "1", pay_to: worker })).value).toMatchObject({ code: "Unauthorized" });
    expect(await ok(client, "wallet_cancel", { nonce: "2", send: true })).toMatchObject({ sent: true });
    const left = ((await ok(client, "wallet_intents"))["intents"] as Json[]).sort((a, b) => Number(a["nonce"]) - Number(b["nonce"]));
    expect(left.map((intent) => [intent["nonce"], intent["status"]])).toEqual([
      ["0", "filled"],
      ["1", "open"],
    ]);
    expect((await call(client, "wallet_escrow_plan", { ...plan, pieces: [plan.pieces[0]] })).value).toMatchObject({ code: "InvalidInput" });
    expect((await call(client, "wallet_escrow_plan", { ...plan, pieces: [plan.pieces[0], { name: "bad", amount: "0.0000000001" }] })).value).toMatchObject({
      code: "InvalidInput",
      issues: [{ path: "pieces.1.amount" }],
    });
  });

  it("refuses a plan past the hourly limit before escrowing any of it, and reports how far a failed one got", async () => {
    client = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools", "--wallet-per-hour", "SOL=0.05"]);
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    h.watched.push(owner);
    const plan = { sell: "SOL", attestor: owner, pieces: [{ name: "a", amount: "0.02" }, { name: "b", amount: "0.02" }, { name: "c", amount: "0.02" }], send: true };
    expect((await call(client, "wallet_escrow_plan", plan)).value).toMatchObject({ code: "WalletHourLimit" });
    expect((await ok(client, "wallet_intents"))["intents"]).toEqual([]);
    const two = { ...plan, pieces: plan.pieces.slice(0, 2).map((piece) => ({ ...piece, amount: "0.01" })) };
    h.sendFails = { error: new BlockhashExpired("expired"), landed: false, after: 1 };
    const partly = await ok(client, "wallet_escrow_plan", two);
    expect(partly).toMatchObject({ sent: true, total: "0.02", next: piecesPartlySent(1, 2, "Failed: expired") });
    expect(partly["pieces"][0]).toHaveProperty("intent");
    expect(partly["pieces"][1]).not.toHaveProperty("intent");
    h.sendFails = { error: new Error("timed out"), landed: true, after: 1 };
    const unsure = await ok(client, "wallet_escrow_plan", two);
    expect(unsure).toMatchObject({ sent: true, next: piecesMayHaveLanded(1, 2, "Failed: timed out") });
    expect((await ok(client, "wallet_intents"))["intents"]).toHaveLength(3);
  });

  it("shows what the payee receives after the protocol fee before an escrow is sent", async () => {
    const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
    const preview = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: wallet, spec_hash: "57".repeat(32) });
    const { net } = splitFee(LAMPORTS_PER_SOL / 20n, FEE_BPS);
    expect(preview["summary"]).toContain(`Payee receives: ${formatAmount(net, 9)}, after the ${FEE_BPS / 100}% protocol fee at today's config`);
  });
});
