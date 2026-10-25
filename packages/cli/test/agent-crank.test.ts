import { generateKeyPairSigner, getBase58Decoder, getBase64Encoder, lamports, signBytes } from "@solana/kit";
import { getCloseAccountInstruction, getTokenDecoder, getTransferInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it } from "vitest";
import { findAssociatedTokenAddress, formatAmount } from "@intent-engine/core";
import { findIntentPda, findUserStatePda } from "@intent-engine/core/internal";
import { OWNER_ACCOUNT_MISSING } from "../src/agent/settle.js";
import { costlyFunding, fundingRent } from "../src/crank.js";
import { SETTLED_LINE } from "../src/agent/shapes.js";
import { ata, balance, cli, ESCROW, funded, h, NOW, send, setNow, transport, type World } from "./harness.js";
import { connect, createIntentOf, exists, execute, fail, heldBy, ok, served, swapOf } from "./agent-kit.js";

describe("agent server against the deployed engine", () => {
  let w: World;
  const free = () => ["--relay-fee", `${w.inputMint}=0`];
  let client: Client;

  const swap = (over: object = {}) => swapOf(w, over);

  const createIntent = async (over: object = {}, owner = w.owner) => createIntentOf(client, w, over, owner);

  beforeEach(async () => {
    ({ w, client } = await served());
  });

  it("prepares a cancel that refunds the owner", async () => {
    await createIntent();
    const cancel = await ok(client, "prepare_cancel", { owner: w.owner.address, nonce: "0" });
    expect([cancel["refund"], cancel["prepared"]["signers"]]).toEqual([ESCROW.toString(), [w.owner.address]]);
    const [intent] = await findIntentPda({ owner: w.owner.address, nonce: 0n });
    const held = await heldBy(intent);
    expect(held).toBeGreaterThan(h.svm.getBalance(intent) ?? 0n);
    const rent = `${held} lamports (${formatAmount(held, 9)} SOL)`;
    expect(cancel["summary"]).toEqual([
      `Cancels intent ${intent} (nonce 0); nobody can fill it afterwards`,
      `Cancelled terms: Sell: exactly 0.0004 of ${w.inputMint}`,
      `Cancelled terms: Receive: at least 0.0003 of ${w.outputMint}`,
      `Returns 0.0004 of ${w.inputMint} to your token account`,
      `The intent and its escrow account stay readable as cancelled and hold ${rent} of rent and bounty that are yours; set close to get them back in this transaction, or close it later with solive_prepare_crank`,
    ]);
    expect(cancel["warnings"]).toEqual([]);
    await execute(cancel["prepared"], w.owner);
    expect(balance(w.ownerInput)).toBe(1_000n);
    expect(await heldBy(intent)).toBe(held);
    const settled = await ok(client, "get_intent", { owner: w.owner.address, nonce: "0" });
    expect(settled["status"]).toBe("cancelled");
    expect(settled["escrowed"]).toBe(ESCROW.toString());
    expect(settled["summary"].at(-1)).toBe(SETTLED_LINE);
    expect((await fail(client, "prepare_cancel", { owner: w.owner.address, nonce: "0" }))["code"]).toBe("InvalidTransition");
  });

  it("closes a cancelled intent in the same transaction when asked and returns its rent to the owner who paid it", async () => {
    const made = await createIntent();
    const open = await ok(client, "get_intent", { owner: w.owner.address, nonce: "0" });
    expect(open["summary"]).not.toContain(SETTLED_LINE);
    const held = await heldBy(made["intent"]);
    const cancel = await ok(client, "prepare_cancel", { owner: w.owner.address, nonce: "0", close: true });
    expect(cancel["summary"].at(-1)).toBe(
      `Closes the intent and its escrow account in the same transaction and returns their ${held} lamports (${formatAmount(held, 9)} SOL) of rent and bounty to you; the intent can no longer be read afterwards`,
    );
    const before = h.svm.getBalance(w.owner.address) ?? 0n;
    await execute(cancel["prepared"], w.owner);
    expect(exists(made["intent"])).toBe(false);
    expect(balance(w.ownerInput)).toBe(1_000n);
    expect((h.svm.getBalance(w.owner.address) ?? 0n) - before).toBe(held - 5_000n);
    expect((await fail(client, "get_intent", { owner: w.owner.address, nonce: "0" }))["code"]).toBe("NotFound");
  });

  it("finds crank work and prepares expires and closes that pay the bounty", async () => {
    await cli(["set-economics", "--keypair", "a.json", "--yes", "--bounty", "50000", "--create-fee", "0"], { "a.json": w.authority });
    const small = { kind: "swap", amount_in: "100", min_out: "1" };
    const expiring = await createIntent({ expires_in: 60, order: small });
    await createIntent({ expires_in: 3_600, order: small });
    const cancelled = await createIntent({ expires_in: 3_600, order: small });
    const cancel = await ok(client, "prepare_cancel", { owner: w.owner.address, nonce: "2" });
    await execute(cancel["prepared"], w.owner);
    const cranker = await funded();
    expect(await fail(client, "prepare_crank", { cranker: cranker.address, owner: w.owner.address, nonce: "1" })).toEqual({
      code: "NothingToCrank",
      retryable: true,
      hint: "this intent is still open and not yet expired, was cancelled and pays nothing to this cranker, or is not one this client can read",
    });
    expect(await ok(client, "find_crank_work")).toEqual({ now: NOW.toString(), work: [], more: false });
    expect(await ok(client, "find_crank_work", { cranker: w.owner.address })).toEqual({
      now: NOW.toString(),
      work: [{ intent: cancelled["intent"], owner: w.owner.address, nonce: "2", action: "close", bounty: "50000" }],
      more: false,
    });
    setNow(NOW + 60n);
    const work = await ok(client, "find_crank_work", { cranker: w.owner.address, limit: 1 });
    expect(work).toMatchObject({ more: true, work: [{ intent: expiring["intent"], action: "expire", bounty: "50000" }] });
    expect((await ok(client, "find_crank_work", { cranker: w.owner.address, limit: 2 }))["more"]).toBe(false);
    expect((await ok(client, "find_crank_work", { limit: 1 }))["more"]).toBe(false);
    const before = h.svm.getBalance(cranker.address) ?? 0n;
    const expire = await ok(client, "prepare_crank", { cranker: cranker.address, owner: w.owner.address, nonce: "0" });
    expect([expire["action"], expire["bounty"], expire["prepared"]["signers"]]).toEqual(["expire", "50000", [cranker.address]]);
    await execute(expire["prepared"], cranker);
    expect(exists(expiring["intent"])).toBe(false);
    expect((h.svm.getBalance(cranker.address) ?? 0n) > before).toBe(true);
    expect((await fail(client, "prepare_crank", { cranker: cranker.address, owner: w.owner.address, nonce: "2" }))["code"]).toBe(
      "NothingToCrank",
    );
    const ownerBefore = h.svm.getBalance(w.owner.address) ?? 0n;
    const close = await ok(client, "prepare_crank", { cranker: w.owner.address, owner: w.owner.address, nonce: "2" });
    expect(close["action"]).toBe("close");
    await execute(close["prepared"], w.owner);
    expect(exists(cancelled["intent"])).toBe(false);
    expect((h.svm.getBalance(w.owner.address) ?? 0n) - ownerBefore).toBeGreaterThan(50_000n);
  });

  it("asks before paying for an owner's missing refund account and pays only what the bounty covers", async () => {
    await createIntent({ expires_in: 60 });
    await cli(["set-economics", "--keypair", "a.json", "--yes", "--bounty", (await fundingRent(transport)).toString(), "--create-fee", "0"], { "a.json": w.authority });
    await createIntent({ expires_in: 60 });
    const sink = await ata(w.authority, (await generateKeyPairSigner()).address, w.inputMint);
    await send(w.owner, [
      getTransferInstruction({ source: w.ownerInput, destination: sink, authority: w.owner, amount: balance(w.ownerInput) }),
      getCloseAccountInstruction({ account: w.ownerInput, destination: w.owner.address, owner: w.owner }),
    ]);
    setNow(NOW + 60n);
    const cranker = await funded();
    const ref = { cranker: cranker.address, owner: w.owner.address, nonce: "0" };
    expect(await fail(client, "prepare_crank", ref)).toEqual({ code: "OwnerAccountMissing", retryable: false, hint: OWNER_ACCOUNT_MISSING });
    expect(await fail(client, "prepare_crank", { ...ref, fund_accounts: false })).toMatchObject({ code: "OwnerAccountMissing" });
    expect(await fail(client, "prepare_crank", { ...ref, fund_accounts: true })).toEqual({
      code: "FundingExceedsBounty",
      retryable: false,
      hint: costlyFunding(0n, await fundingRent(transport)),
    });
    const funded2 = await ok(client, "prepare_crank", { ...ref, nonce: "1", fund_accounts: true });
    await execute(funded2["prepared"], cranker);
    expect(balance(w.ownerInput)).toBe(ESCROW);
  });

  it("keeps serving an owner whose engine and token account addresses a stranger funded first", async () => {
    const relayer = await funded();
    const relaying = await connect(relayer, free());
    for (const flow of ["create", "signed"] as const) {
      const owner = await funded();
      const ownerInput = await ata(w.authority, owner.address, w.inputMint, 1_000n);
      const [userState] = await findUserStatePda({ owner: owner.address });
      const receiver = await findAssociatedTokenAddress({ owner: owner.address, mint: w.outputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
      const [firstIntent] = await findIntentPda({ owner: owner.address, nonce: 0n });
      for (const address of [userState, receiver, firstIntent]) {
        h.svm.airdrop(address, lamports(h.svm.minimumBalanceForRentExemption(0n)));
        expect(h.svm.getAccount(address)).toMatchObject({ exists: true, data: new Uint8Array() });
      }
      expect((await ok(client, "get_balances", { owner: owner.address, mints: [w.outputMint] }))["tokens"]).toMatchObject([
        { account: receiver, exists: false, balance: "0" },
      ]);
      if (flow === "create") {
        const made = await ok(client, "prepare_create", swap({ owner: owner.address }));
        expect(made["summary"].slice(-2)).toEqual([
          "Setup: registers you with the engine (a one-time account you pay rent for)",
          `Setup: creates your token account for ${w.outputMint} (you pay its rent)`,
        ]);
        expect(made["intent"]).toBe(firstIntent);
        await execute(made["prepared"], owner);
        expect(exists(made["intent"])).toBe(true);
      } else {
        const terms = { ...swap({ owner: owner.address }), submit_within: 600 };
        const prepared = await ok(relaying, "prepare_signed_intent", terms);
        expect(prepared["intent"]).toBe(firstIntent);
        await execute(prepared["setup"], owner);
        const signature = getBase58Decoder().decode(
          await signBytes(owner.keyPair.privateKey, getBase64Encoder().encode(prepared["message"])),
        );
        await ok(relaying, "submit_signed_intent", { ...prepared["submit"], signature });
        expect(exists(prepared["intent"])).toBe(true);
      }
      expect(balance(ownerInput)).toBe(1_000n - ESCROW);
      expect(getTokenDecoder().decode((h.svm.getAccount(receiver) as { data: Uint8Array }).data).owner).toBe(owner.address);
    }
  });
});
