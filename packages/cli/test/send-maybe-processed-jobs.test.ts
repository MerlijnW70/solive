import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Address } from "@solana/kit";
import type { Client } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Transport } from "@intent-engine/client";
import { salesPath } from "../src/agent/sales.js";
import { h } from "./harness.js";
import { approved } from "./approved.js";
import { call, hireWith, ok, removeWorkFiles, server, startHirer, WALLET, workerFiles } from "./local-worker-kit.js";
import { forwardsThenAnswers, type Gateway, passesThrough, TIMEOUTS } from "./maybe-processed-kit.js";

const WORKER_HOME = "/home/worker";

const salesAt = (wallet: string): unknown[] => {
  try {
    return JSON.parse(readFileSync(join(h.saleRoot, salesPath(wallet)), "utf8")) as unknown[];
  } catch {
    return [];
  }
};

const gateways: [string, (live: Transport, status: number) => Gateway][] = [
  ["through the client transport", (live, status) => forwardsThenAnswers(live, status)],
  ["through a transport that passes the status on", (live, status) => passesThrough(live, status, true)],
];

describe("a job send that a gateway answers with a timeout", () => {
  let hirer: Client;
  let wallet: Address;

  beforeEach(async () => {
    ({ hirer, wallet } = await startHirer());
  });

  afterEach(removeWorkFiles);

  for (const [route, gatewayOf] of gateways) {
    for (const status of TIMEOUTS) {
      it(`keeps the worker's key, its job file and the funding sale after a ${status} ${route}`, async () => {
        const { intent } = await hireWith(hirer, wallet, false);
        const gateway = gatewayOf(h.through as Transport, status);
        h.through = gateway.transport;
        const funding = await server(["--wallet-per-hour", "SOL=10"]);
        const unsure = await call(funding, "wallet_worker", await approved(funding, "wallet_worker", { intent }));
        expect(unsure.error).toBe(true);
        expect(unsure.value["code"]).toBe(route.includes("client") ? "MaybeSent" : "Failed");
        expect(gateway.sends()).toBe(1);
        expect(workerFiles()).toHaveLength(2);
        expect(salesAt(WALLET)).toHaveLength(1);
      });

      it(`keeps a claim's stake sale after a ${status} ${route}`, async () => {
        const { nonce } = await hireWith(hirer, wallet, true);
        const escrow = { owner: wallet, nonce, action: "take", secs: 600 };
        const worker = await server(["--wallet-per-hour", "SOL=10"], { home: WORKER_HOME });
        const address = (await ok(worker, "wallet_setup"))["address"] as Address;
        const preview = await ok(worker, "wallet_claim", escrow);
        const gateway = gatewayOf(h.through as Transport, status);
        h.through = gateway.transport;
        const sending = await server(["--wallet-per-hour", "SOL=10"], { home: WORKER_HOME });
        const unsure = await call(sending, "wallet_claim", { ...escrow, approval: preview["approval"], send: true });
        expect(unsure.error).toBe(true);
        expect(unsure.value["code"]).toBe(route.includes("client") ? "MaybeSent" : "Failed");
        expect(gateway.sends()).toBe(1);
        expect(salesAt(`${WORKER_HOME}/.config/intent-engine/wallet.json`)).toHaveLength(1);
        expect(await ok(hirer, "get_claims", { owner: wallet, nonce })).toMatchObject({ state: "held", worker: address });
      });
    }
  }

  it("removes the worker's key and refunds the sale when a 400 proves the node refused the funding send", async () => {
    const { intent } = await hireWith(hirer, wallet, false);
    const gateway = passesThrough(h.through as Transport, 400, false);
    h.through = gateway.transport;
    const funding = await server(["--wallet-per-hour", "SOL=10"]);
    expect((await call(funding, "wallet_worker", await approved(funding, "wallet_worker", { intent }))).error).toBe(true);
    expect(gateway.sends()).toBe(1);
    expect(workerFiles()).toEqual([]);
    expect(salesAt(WALLET)).toEqual([]);
  });
});
