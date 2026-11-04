import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Address, getBase64Encoder, getSignatureFromTransaction, getTransactionDecoder } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import { findIntentPda } from "@intent-engine/core/internal";
import { MaybeSent } from "@intent-engine/client";
import { testSignature } from "@intent-engine/client/testing";
import { SERVER_PROBLEMS } from "../src/agent/problems.js";
import { salesPath } from "../src/agent/sales.js";
import { mayHaveLanded, partlySent, piecesMayHaveLanded, piecesPartlySent } from "../src/agent/wallet.js";
import { mayHaveSent, refusedBeforeSending, rpcRefused } from "../src/agent/wallet/guard.js";
import { defaultWallet } from "../src/wallet.js";
import { h, HOME, setNow, transport } from "./harness.js";
import { call, connect, fresh, ok } from "./agent-wallet-kit.js";
import { approved } from "./approved.js";
import { forwardsThenAnswers, httpError, TIMEOUTS } from "./maybe-processed-kit.js";

const LIMITED = ["mcp", "--url", "devnet", "--wallet", "--all-tools", "--wallet-per-hour", "SOL=0.15"];
const OPEN = ["mcp", "--url", "devnet", "--wallet", "--all-tools"];
const SWAP = { sell: "SOL", buy: "TEST", amount: "0.1", min_receive: "5" };
const FAILED = `Failed: ${SERVER_PROBLEMS.Failed.hint}`;

const sales = (): unknown[] => {
  try {
    return JSON.parse(readFileSync(join(h.saleRoot, salesPath(defaultWallet(HOME))), "utf8")) as unknown[];
  } catch {
    return [];
  }
};

const signatureOf = (wire: string) => getSignatureFromTransaction(getTransactionDecoder().decode(getBase64Encoder().encode(wire)));

const nextHour = () => setNow(h.svm.getClock().unixTimestamp + 3_601n);

describe("the wallet's rule for a send that may have been processed", () => {
  it("counts only a refusal status as refused before sending, and every other answer as maybe sent", () => {
    for (let status = 100; status < 600; status++) {
      expect(rpcRefused(httpError(status)), String(status)).toBe([400, 401, 403, 404, 405, 407, 411, 413, 414, 415, 421, 429, 431].includes(status));
      expect(mayHaveSent(httpError(status)), String(status)).toBe(!rpcRefused(httpError(status)));
    }
    for (const status of [...TIMEOUTS, 499]) {
      expect(refusedBeforeSending(httpError(status))).toBe(false);
      expect(refusedBeforeSending(new Error("wrapped", { cause: httpError(status) }))).toBe(false);
    }
    expect(refusedBeforeSending(httpError(400))).toBe(true);
    expect(mayHaveSent(new MaybeSent(testSignature("sent"), 1n, "may have landed"))).toBe(true);
    expect(mayHaveSent(new Error("plain"))).toBe(false);
  });
});

describe("a wallet send that a gateway answers with a timeout", () => {
  beforeEach(async () => {
    await fresh();
  });

  for (const status of TIMEOUTS) {
    it(`reports a ${status} after the node took the swap as MaybeSent, keeps its sale counted and sends it once`, async () => {
      const gateway = forwardsThenAnswers(transport, status);
      h.through = gateway.transport;
      const client = await connect(LIMITED);
      const owner = (await ok(client, "wallet_setup"))["address"] as Address;
      const unsure = await call(client, "wallet_swap", await approved(client, "wallet_swap", SWAP));
      expect(unsure.error).toBe(true);
      expect(unsure.value).toMatchObject({ code: "MaybeSent", retryable: false, signature: signatureOf(h.wires.at(-1) as string) });
      expect(gateway.sends()).toBe(1);
      const [intent] = await findIntentPda({ owner, nonce: 0n });
      expect(h.svm.getAccount(intent).exists).toBe(true);
      expect(sales()).toHaveLength(1);
      expect((await call(client, "wallet_swap", SWAP)).value).toMatchObject({ code: "WalletHourLimit" });
    });
  }

  it("keeps the sale counted when a transport passes a 408 or 425 through unwrapped, and frees it only for a 400", async () => {
    for (const status of TIMEOUTS) {
      const client = await connect(LIMITED);
      await ok(client, "wallet_setup");
      h.sendFails = { error: httpError(status), landed: true };
      expect((await call(client, "wallet_swap", await approved(client, "wallet_swap", SWAP))).error).toBe(true);
      expect((await call(client, "wallet_swap", SWAP)).value).toMatchObject({ code: "WalletHourLimit" });
      nextHour();
    }
    const client = await connect(LIMITED);
    h.sendFails = { error: httpError(400, "Bad Request"), landed: false };
    expect((await call(client, "wallet_swap", await approved(client, "wallet_swap", SWAP))).error).toBe(true);
    expect(await ok(client, "wallet_swap", SWAP)).toMatchObject({ sent: false });
  });

  it("never signs a swap again under a fresh nonce after a send that may have been processed, whatever its text says", async () => {
    for (const error of [new MaybeSent(testSignature("sent"), 0n, "the gateway said: account already in use"), httpError(408, "account already in use")]) {
      let sends = 0;
      h.through = {
        ...transport,
        sendWire: async (wire, latest) => {
          sends += 1;
          return transport.sendWire(wire, latest);
        },
      };
      const client = await connect(OPEN);
      const owner = (await ok(client, "wallet_setup"))["address"] as Address;
      const nonce = BigInt(((await ok(client, "wallet_swap", SWAP))["nonce"] as string) ?? "0");
      h.sendFails = { error, landed: true };
      expect((await call(client, "wallet_swap", await approved(client, "wallet_swap", SWAP))).error).toBe(true);
      expect(sends).toBe(1);
      const [taken] = await findIntentPda({ owner, nonce });
      const [next] = await findIntentPda({ owner, nonce: nonce + 1n });
      expect(h.svm.getAccount(taken).exists).toBe(true);
      expect(h.svm.getAccount(next).exists).toBe(false);
    }
  });

  it("words a schedule or a plan cut short by a 408 or 425 as maybe landed, and one cut short by a 400 as partly sent", async () => {
    const client = await connect(OPEN);
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    const schedule = { sell: "SOL", buy: "TEST", amount: "0.01", min_receive: "5", every: 600, times: 2, send: true };
    const plan = { sell: "SOL", attestor: owner, pieces: [{ name: "a", amount: "0.01" }, { name: "b", amount: "0.01" }], send: true };
    for (const status of TIMEOUTS) {
      h.sendFails = { error: httpError(status), landed: true, after: 1 };
      expect(await ok(client, "wallet_recurring", await approved(client, "wallet_recurring", schedule))).toMatchObject({ sent: true, next: mayHaveLanded(1, 2, FAILED) });
      h.sendFails = { error: httpError(status), landed: true, after: 1 };
      expect(await ok(client, "wallet_escrow_plan", await approved(client, "wallet_escrow_plan", plan))).toMatchObject({ sent: true, next: piecesMayHaveLanded(1, 2, FAILED) });
    }
    h.sendFails = { error: httpError(400, "Bad Request"), landed: false, after: 1 };
    expect(await ok(client, "wallet_recurring", await approved(client, "wallet_recurring", schedule))).toMatchObject({ next: partlySent(1, 2, FAILED) });
    h.sendFails = { error: httpError(400, "Bad Request"), landed: false, after: 1 };
    expect(await ok(client, "wallet_escrow_plan", await approved(client, "wallet_escrow_plan", plan))).toMatchObject({ next: piecesPartlySent(1, 2, FAILED) });
  });
});
