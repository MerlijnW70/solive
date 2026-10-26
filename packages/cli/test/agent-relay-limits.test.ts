import { MAX_PENDING_PER_OWNER } from "../src/agent/claims.js";
import { getBase58Decoder, getBase64Encoder, signBytes } from "@solana/kit";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it } from "vitest";
import { testSignature } from "@intent-engine/client/testing";
import { findAssociatedTokenAddress } from "@intent-engine/core";
import { FailedOnChain } from "@intent-engine/client";
import { failure } from "@intent-engine/client/internal";
import { createCost, rentFor, rentRate, SIGNATURE_FEE, TOKEN_ACCOUNT_RENT_BYTES } from "../src/agent/budget.js";
import { RELAY_TOO_LARGE } from "../src/agent/signed.js";
import { ata, balance, cli, funded, h, NOW, setNow, transport, type World } from "./harness.js";
import { connect, exists, execute, fail, ok, served, swapOf } from "./agent-kit.js";
import { SERVER_PROBLEMS } from "../src/agent/problems.js";

describe("agent server against the deployed engine", () => {
  let w: World;
  const free = () => ["--relay-fee", `${w.inputMint}=0`];
  let client: Client;

  const swap = (over: object = {}) => swapOf(w, over);

  beforeEach(async () => {
    ({ w, client } = await served());
  });

  it("refuses before the owner signs any terms its relayer could not fit in one transaction", async () => {
    const relayer = await funded();
    const owner = await funded();
    await ata(w.authority, owner.address, w.inputMint, 1_000n);
    const partner = { account: w.feeRecipient.address, bps: 50 };
    const priced = await connect(relayer, ["--relay-fee", `${w.inputMint}=25`, "--priority-fee", "1000"]);
    expect(await fail(priced, "prepare_signed_intent", swap({ owner: owner.address, partner }))).toEqual({
      code: "RelayTooLarge",
      retryable: false,
      hint: RELAY_TOO_LARGE,
    });
    const plain = await ok(priced, "prepare_signed_intent", swap({ owner: owner.address }));
    expect(plain["submit"]).toMatchObject({ relayer_fee: "25" });
    const unpriced = await connect(relayer, ["--relay-fee", `${w.inputMint}=25`]);
    expect(await ok(unpriced, "prepare_signed_intent", swap({ owner: owner.address, partner }))).toMatchObject({ nonce: expect.any(String) });
  });

  it("opens its own fee account in a separate transaction when the relay would not fit with it", async () => {
    const relayer = await funded();
    const owner = await funded();
    await ata(w.authority, owner.address, w.inputMint, 1_000n);
    const partner = { account: w.feeRecipient.address, bps: 50 };
    const relaying = await connect(relayer, ["--relay-fee", `${w.inputMint}=25`]);
    const p = await ok(relaying, "prepare_signed_intent", swap({ owner: owner.address, partner }));
    await execute(p["setup"], owner);
    const signature = getBase58Decoder().decode(await signBytes(owner.keyPair.privateKey, getBase64Encoder().encode(p["message"])));
    const fees = await findAssociatedTokenAddress({ owner: relayer.address, mint: w.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(exists(fees)).toBe(false);
    expect(await ok(relaying, "submit_signed_intent", { ...p["submit"], signature })).toMatchObject({ intent: p["intent"] });
    expect(balance(fees)).toBe(25n);
    expect(exists(p["intent"])).toBe(true);
  });

  it("charges its budget for its own fee account, and for a second transaction only when it has to split", async () => {
    const owner = await funded();
    await ata(w.authority, owner.address, w.inputMint, 1_000n);
    const rate = await rentRate(transport);
    const cost = createCost({ createFee: 0, crankBounty: 0 }, rate);
    const base = cost + rentFor(TOKEN_ACCOUNT_RENT_BYTES, rate);
    const needed = async (extra: string[], nonce: string, holding = false) => {
      const relayer = await funded();
      if (holding) {
        await ata(w.authority, relayer.address, w.inputMint, 0n);
      }
      const signer = await connect(relayer, ["--relay-fee", `${w.inputMint}=25`, ...extra]);
      const p = await ok(signer, "prepare_signed_intent", swap({ owner: owner.address, nonce }));
      await execute(p["setup"], owner);
      const signature = getBase58Decoder().decode(await signBytes(owner.keyPair.privateKey, getBase64Encoder().encode(p["message"])));
      const broke = await connect(relayer, ["--relay-fee", `${w.inputMint}=25`, "--relay-hourly-lamports", "1", ...extra]);
      const refused = await fail(broke, "submit_signed_intent", { ...p["submit"], signature });
      expect(refused["code"]).toBe("BudgetExhausted");
      return BigInt(/this needs (\d+)$/.exec(refused["hint"] as string)?.[1] ?? "0");
    };
    expect(await needed([], "39", true)).toBe(cost);
    expect(await needed([], "40")).toBe(base + SIGNATURE_FEE);
    const split = await needed(["--priority-fee", "1000", "--relay-max-lamports", "100000"], "41");
    expect(split - base - SIGNATURE_FEE).toBeGreaterThan(0n);
    expect((split - base - SIGNATURE_FEE) % 2n).toBe(0n);
  });

  it("lets nobody hold more than a few of an owner's nonces with signed intents that are never signed", async () => {
    const relayer = await funded();
    const relaying = await connect(relayer, free());
    const owner = await funded();
    await ata(w.authority, owner.address, w.inputMint, 1_000n);
    const nonces = [];
    for (let i = 0; i < MAX_PENDING_PER_OWNER; i++) {
      nonces.push((await ok(relaying, "prepare_signed_intent", swap({ owner: owner.address })))["nonce"]);
    }
    expect(nonces).toEqual(Array.from({ length: MAX_PENDING_PER_OWNER }, (_, i) => i.toString()));
    expect(await fail(relaying, "prepare_signed_intent", swap({ owner: owner.address }))).toEqual({
      code: "TooManyPending",
      retryable: true,
      hint: `${owner.address} already has ${MAX_PENDING_PER_OWNER} prepared requests waiting; submit some or let them expire (a signed intent holds its nonce until its submit_by), then ask again`,
    });
    expect((await ok(relaying, "prepare_signed_intent", swap({ owner: w.owner.address })))["nonce"]).toBe("0");
  });

  it("gives back the budget and the owner's hourly slot when a relay it admitted is never delivered", async () => {
    const owner = await funded();
    await ata(w.authority, owner.address, w.inputMint, 1_000n);
    const relayer = await funded();
    const cost = createCost({ createFee: 0, crankBounty: 0 }, await rentRate(transport));
    const limits = [...free(), "--relay-per-hour", "1", "--relay-hourly-lamports", cost.toString()];
    const relaying = await connect(relayer, limits);
    const p = await ok(relaying, "prepare_signed_intent", swap({ owner: owner.address }));
    await execute(p["setup"], owner);
    const signature = getBase58Decoder().decode(await signBytes(owner.keyPair.privateKey, getBase64Encoder().encode(p["message"])));
    const delivered = transport.send;
    transport.send = async () => {
      throw new Error("the node dropped the transaction");
    };
    try {
      expect(await fail(relaying, "submit_signed_intent", { ...p["submit"], signature })).toEqual({
        code: "Failed",
        retryable: false,
        hint: SERVER_PROBLEMS.Failed.hint,
        untrustedDetail: "the node dropped the transaction",
      });
    } finally {
      transport.send = delivered;
    }
    expect(exists(p["intent"])).toBe(false);
    expect(await ok(relaying, "submit_signed_intent", { ...p["submit"], signature })).toMatchObject({ intent: p["intent"] });
    expect(exists(p["intent"])).toBe(true);
    const second = await ok(relaying, "prepare_signed_intent", swap({ owner: owner.address }));
    await execute(second["setup"], owner);
    const again = getBase58Decoder().decode(await signBytes(owner.keyPair.privateKey, getBase64Encoder().encode(second["message"])));
    expect((await fail(relaying, "submit_signed_intent", { ...second["submit"], signature: again }))["code"]).toBe("RelayRateLimited");
  });

  it("keeps the budget and the owner's hourly slot when a relay may already have been paid for", async () => {
    const owner = await funded();
    await ata(w.authority, owner.address, w.inputMint, 1_000n);
    const relayer = await funded();
    const relaying = await connect(relayer, [...free(), "--relay-per-hour", "1"]);
    const p = await ok(relaying, "prepare_signed_intent", swap({ owner: owner.address }));
    await execute(p["setup"], owner);
    const signature = getBase58Decoder().decode(await signBytes(owner.keyPair.privateKey, getBase64Encoder().encode(p["message"])));
    const delivered = transport.send;
    transport.send = async () => {
      throw new FailedOnChain("transaction landed and failed", failure(testSignature("sent"), null));
    };
    try {
      expect((await fail(relaying, "submit_signed_intent", { ...p["submit"], signature }))["code"]).toBe("Failed");
    } finally {
      transport.send = delivered;
    }
    expect((await fail(relaying, "submit_signed_intent", { ...p["submit"], signature }))["code"]).toBe("RelayRateLimited");
  });

  it("relays only the tokens its operator priced, so nobody can make it pay for intents in a throwaway token", async () => {
    const relayer = await funded();
    const owner = await funded();
    await ata(w.authority, owner.address, w.inputMint, 1_000n);
    const priced = await connect(relayer, free());
    const p = await ok(priced, "prepare_signed_intent", swap({ owner: owner.address }));
    await execute(p["setup"], owner);
    const signature = getBase58Decoder().decode(await signBytes(owner.keyPair.privateKey, getBase64Encoder().encode(p["message"])));
    const elsewhere = await connect(relayer, ["--relay-fee", `${w.outputMint}=0`]);
    const refusal = {
      code: "RelayMintNotAccepted",
      retryable: false,
      hint: `this server's relayer does not relay intents selling ${w.inputMint}; it relays only ${w.outputMint}`,
    };
    expect(await fail(elsewhere, "prepare_signed_intent", swap({ owner: owner.address }))).toEqual(refusal);
    expect(await fail(elsewhere, "submit_signed_intent", { ...p["submit"], signature })).toEqual(refusal);
    expect(await ok(priced, "submit_signed_intent", { ...p["submit"], signature })).toMatchObject({ intent: p["intent"] });
  });

  it("relays only within the relayer's cost, expiry and rate limits", async () => {
    const relayer = await funded();
    const owner = await funded();
    await ata(w.authority, owner.address, w.inputMint, 1_000n);
    const small = { kind: "swap", amount_in: "10", min_out: "1" };
    const signedBy = async (server: Client, nonce: string, over: object = {}) => {
      const p = await ok(server, "prepare_signed_intent", { ...swap({ owner: owner.address, order: small, nonce }), ...over });
      await execute(p["setup"], owner);
      const signature = getBase58Decoder().decode(await signBytes(owner.keyPair.privateKey, getBase64Encoder().encode(p["message"])));
      return { ...p["submit"], signature };
    };
    const strict = await connect(relayer, [...free(), "--relay-max-ttl", "3600", "--relay-per-hour", "1"]);
    const lax = await connect(relayer, [...free(), "--relay-max-lamports", "10000"]);
    expect(await fail(strict, "submit_signed_intent", await signedBy(lax, "0", { expires_in: 3_601 }))).toMatchObject({
      code: "RelayTooLong",
    });
    await ok(strict, "submit_signed_intent", await signedBy(strict, "1"));
    const limited = await signedBy(strict, "2");
    expect(await fail(strict, "submit_signed_intent", limited)).toMatchObject({ code: "RelayRateLimited", retryable: true });
    setNow(NOW + 3_600n);
    await ok(strict, "submit_signed_intent", await signedBy(strict, "4"));
    await cli(["set-economics", "--keypair", "a.json", "--yes", "--bounty", "6000", "--create-fee", "4000"], { "a.json": w.authority });
    const costly = await signedBy(lax, "3");
    expect(await fail(strict, "submit_signed_intent", costly)).toEqual({
      code: "RelayTooCostly",
      retryable: false,
      hint: "relaying this intent costs 10000 lamports in create fee, crank bounty and priority fee; this relayer pays at most 0",
    });
    const before = h.svm.getBalance(relayer.address) ?? 0n;
    await ok(lax, "submit_signed_intent", costly);
    expect(before - (h.svm.getBalance(relayer.address) ?? 0n)).toBeGreaterThan(10_000n);
  });

  it("prepare signed intent refuses an expiry beyond the relayer ttl", async () => {
    const relayer = await funded();
    const owner = await funded();
    await ata(w.authority, owner.address, w.inputMint, 1_000n);
    const strict = await connect(relayer, [...free(), "--relay-max-ttl", "3600"]);
    expect(await fail(strict, "prepare_signed_intent", swap({ owner: owner.address, expires_in: 3_601 }))).toEqual({
      code: "RelayTooLong",
      retryable: false,
      hint: "this relayer only relays intents that expire within 3600 seconds; sign one with an earlier expiry",
    });
    expect(await ok(strict, "prepare_signed_intent", swap({ owner: owner.address, expires_in: 3_600 }))).toMatchObject({ nonce: "0" });
  });

  it("prepare signed intent refuses terms beyond the relayer lamports", async () => {
    const relayer = await funded();
    const owner = await funded();
    await ata(w.authority, owner.address, w.inputMint, 1_000n);
    await cli(["set-economics", "--keypair", "a.json", "--yes", "--bounty", "6000", "--create-fee", "4000"], { "a.json": w.authority });
    const cheap = await connect(relayer, [...free(), "--relay-max-lamports", "9999"]);
    expect(await fail(cheap, "prepare_signed_intent", swap({ owner: owner.address }))).toEqual({
      code: "RelayTooCostly",
      retryable: false,
      hint: "relaying this intent costs at least 10000 lamports in create fee and crank bounty before any priority fee; this relayer pays at most 9999",
    });
    const enough = await connect(relayer, [...free(), "--relay-max-lamports", "10000"]);
    expect(await ok(enough, "prepare_signed_intent", swap({ owner: owner.address }))).toMatchObject({ nonce: "0" });
  });
});
