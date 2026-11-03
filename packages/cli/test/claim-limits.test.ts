import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Address, getBase58Decoder } from "@solana/kit";
import type { Client } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, NATIVE_MINT } from "@intent-engine/core";
import { getStandbySize } from "@intent-engine/core/internal";
import { svmTransport } from "@intent-engine/client/svm";
import { AgentRefusal } from "../src/agent/problems.js";
import { salesPath } from "../src/agent/sales.js";
import { EXIT_FAILED, EXIT_OK } from "../src/main.js";
import { cli, DOMAIN, funded, h, saleBook, world } from "./harness.js";
import { call, hireWith, lamportsOf, ok, preset, rentOf, server, STAKE } from "./local-worker-kit.js";

const walletAt = (home: string) => `${home}/.config/intent-engine/wallet.json`;

const salesOf = (home: string) => {
  const rows = JSON.parse(readFileSync(join(h.saleRoot, salesPath(walletAt(home))), "utf8")) as { mint: string; amount: string }[];
  return rows.map(({ mint, amount }) => ({ mint, amount }));
};

async function wallet(home: string, limits: string[] = []): Promise<{ client: Client; address: Address }> {
  const client = await server(limits, { home });
  const address = (await ok(client, "wallet_setup"))["address"] as Address;
  return { client, address };
}

describe("wallet_claim stakes count against the wallet's sell limits", () => {
  let hirer: Client;
  let owner: Address;

  beforeEach(async () => {
    await world();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    h.through = svmTransport(h.svm, { genesisHash: getBase58Decoder().decode(DOMAIN) });
    ({ client: hirer, address: owner } = await wallet("/home/hirer"));
    h.watched.push(owner);
  });

  const hire = async () => {
    const { intent, nonce } = await hireWith(hirer, owner, true);
    return { intent, escrow: { owner, nonce } };
  };

  const taken = async (client: Client, escrow: object, action = "take") => {
    const args = { ...escrow, action, secs: 600 };
    const preview = await ok(client, "wallet_claim", args);
    return ok(client, "wallet_claim", { ...args, approval: preview["approval"], send: true });
  };

  it("refuses a take whose stake passes the per-trade limit, on preview and on send, and sends nothing", async () => {
    const { escrow } = await hire();
    const worker = await wallet("/home/worker", ["--wallet-per-trade", "SOL=0.005"]);
    const before = lamportsOf(worker.address);
    for (const args of [{ ...escrow, action: "take", secs: 600 }, { ...escrow, action: "take", secs: 600, approval: "0".repeat(16), send: true }]) {
      expect((await call(worker.client, "wallet_claim", args)).value).toMatchObject({
        code: "WalletTradeLimit",
        hint: "this server sells at most 0.005 SOL per trade and this sells 0.01; sell less, or the user restarts the server with a higher --wallet-per-trade",
      });
    }
    expect(lamportsOf(worker.address)).toBe(before);
    expect(await ok(hirer, "get_claims", escrow)).toMatchObject({ state: "free", worker: null });
  });

  it("refuses a stake when the server sells only another token", async () => {
    const { escrow } = await hire();
    const worker = await wallet("/home/worker", ["--wallet-per-trade", "TEST=1"]);
    expect((await call(worker.client, "wallet_claim", { ...escrow, action: "take", secs: 600 })).value).toMatchObject({ code: "WalletTokenNotAllowed" });
  });

  it("records a sent take's stake and a stand-by's stake and rent, and counts them against the hour", async () => {
    const { escrow } = await hire();
    const worker = await wallet("/home/worker", ["--wallet-per-hour", "SOL=0.015"]);
    expect(await taken(worker.client, escrow)).toMatchObject({ sent: true });
    expect(salesOf("/home/worker")).toEqual([{ mint: NATIVE_MINT, amount: STAKE.toString() }]);
    const second = await hire();
    expect((await call(worker.client, "wallet_claim", { ...second.escrow, action: "take", secs: 600 })).value).toMatchObject({ code: "WalletHourLimit" });
    expect(await ok(hirer, "get_claims", second.escrow)).toMatchObject({ state: "free" });
    const waiter = await wallet("/home/waiter", ["--wallet-per-hour", "SOL=0.015"]);
    expect(await taken(waiter.client, escrow, "standby")).toMatchObject({ sent: true });
    expect(salesOf("/home/waiter")).toEqual([{ mint: NATIVE_MINT, amount: (STAKE + rentOf(getStandbySize())).toString() }]);
    expect(await ok(hirer, "get_claims", escrow)).toMatchObject({ waiting: 1 });
  });

  it("checks the hourly limit again under the sale book's lock", async () => {
    const { escrow } = await hire();
    const limit = ["--wallet-per-hour", "SOL=0.015"];
    const worker = await wallet("/home/worker", limit);
    await taken(worker.client, escrow);
    const second = await hire();
    const stale = await server(limit, { home: "/home/worker", saleBook: { ...saleBook, read: async () => [] } });
    const args = { ...second.escrow, action: "take", secs: 600 };
    const preview = await ok(stale, "wallet_claim", args);
    const before = lamportsOf(worker.address);
    expect((await call(stale, "wallet_claim", { ...args, approval: preview["approval"], send: true })).value).toMatchObject({ code: "WalletHourLimit" });
    expect(lamportsOf(worker.address)).toBe(before);
    expect(salesOf("/home/worker")).toHaveLength(1);
    expect(await ok(hirer, "get_claims", second.escrow)).toMatchObject({ state: "free" });
  });

  it("takes the sale back out when the send is refused before it lands", async () => {
    const { escrow } = await hire();
    const limit = ["--wallet-per-hour", "SOL=10"];
    const worker = await wallet("/home/worker", limit);
    const args = { ...escrow, action: "take", secs: 600 };
    const preview = await ok(worker.client, "wallet_claim", args);
    const live = h.through as NonNullable<typeof h.through>;
    h.through = {
      ...live,
      sendWire: async () => {
        throw new AgentRefusal("Failed", "the node refused it");
      },
    };
    const refusing = await server(limit, { home: "/home/worker" });
    const before = lamportsOf(worker.address);
    expect((await call(refusing, "wallet_claim", { ...args, approval: preview["approval"], send: true })).error).toBe(true);
    expect(lamportsOf(worker.address)).toBe(before);
    expect(salesOf("/home/worker")).toEqual([]);
    expect(await ok(hirer, "get_claims", escrow)).toMatchObject({ state: "free" });
  });

  it("refuses a stand-by whose stake and rent pass the per-trade limit", async () => {
    const { escrow } = await hire();
    const worker = await wallet("/home/worker");
    await taken(worker.client, escrow);
    const waiter = await wallet("/home/waiter", ["--wallet-per-trade", "SOL=0.01"]);
    const before = lamportsOf(waiter.address);
    expect((await call(waiter.client, "wallet_claim", { ...escrow, action: "standby", secs: 600 })).value).toMatchObject({ code: "WalletTradeLimit" });
    expect(lamportsOf(waiter.address)).toBe(before);
    expect(await ok(hirer, "get_claims", escrow)).toMatchObject({ waiting: 0 });
  });
});

describe("wallet_claim and claims take share one fill pre-check", () => {
  it("refuses take and standby on a fill-paused or fill-stopped config before sending, through MCP and the CLI alike", async () => {
    const w = await world();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    h.through = svmTransport(h.svm, { genesisHash: getBase58Decoder().decode(DOMAIN) });
    const hirer = await server([], { home: "/home/hirer" });
    const owner = (await ok(hirer, "wallet_setup"))["address"] as Address;
    h.watched.push(owner);
    const { intent, nonce } = await hireWith(hirer, owner, true);
    const escrow = { owner, nonce };
    const mcp = await server([], { home: "/home/worker" });
    const address = (await ok(mcp, "wallet_setup"))["address"] as Address;
    const keys = { "a.json": w.authority, "cli.json": await funded() };
    const admin = async (args: string[]) => expect((await cli([...args, "--keypair", "a.json", "--yes"], keys)).code).toBe(EXIT_OK);
    const cliTake = (verb: string) => cli(["claims", verb, "--keypair", "cli.json", "--owner", owner, "--nonce", nonce, "--secs", "600", "--yes"], keys);
    const paused = `fills are paused by the guardian or admin, and with them new claims and stand-by joins on escrow ${intent}; try again once the pause is lowered; nothing was sent`;
    const stopped = `the admin stopped fills of the kind of escrow ${intent}, and with them new claims and stand-by joins on it; nothing was sent`;

    await admin(["raise-pause", "--flags", "fill"]);
    const before = lamportsOf(address);
    expect((await call(mcp, "wallet_claim", { ...escrow, action: "take", secs: 600 })).value).toMatchObject({ code: "FillPaused", hint: paused });
    const refused = await cliTake("take");
    expect([refused.code, refused.err]).toEqual([EXIT_FAILED, expect.stringContaining(paused)]);
    expect(lamportsOf(address)).toBe(before);
    expect(await ok(hirer, "get_claims", escrow)).toMatchObject({ state: "free", worker: null });
    await admin(["lower-pause", "--flags", "fill"]);

    await admin(["update-config", "--fill-disabled", "attested"]);
    expect((await call(mcp, "wallet_claim", { ...escrow, action: "take", secs: 600 })).value).toMatchObject({ code: "FillKindDisabled", hint: stopped });
    expect((await cliTake("take")).err).toContain(stopped);
    await admin(["update-config", "--fill-disabled", "none"]);

    const preview = await ok(mcp, "wallet_claim", { ...escrow, action: "take", secs: 600 });
    expect(await ok(mcp, "wallet_claim", { ...escrow, action: "take", secs: 600, approval: preview["approval"], send: true })).toMatchObject({ sent: true });
    await admin(["raise-pause", "--flags", "fill"]);
    const waiter = await server([], { home: "/home/waiter" });
    await ok(waiter, "wallet_setup");
    expect((await call(waiter, "wallet_claim", { ...escrow, action: "standby", secs: 600 })).value).toMatchObject({ code: "FillPaused", hint: paused });
    expect((await cliTake("standby")).err).toContain(paused);
    await admin(["lower-pause", "--flags", "fill"]);
    await admin(["update-config", "--fill-disabled", "attested"]);
    expect((await call(waiter, "wallet_claim", { ...escrow, action: "standby", secs: 600 })).value).toMatchObject({ code: "FillKindDisabled", hint: stopped });
    expect(await ok(hirer, "get_claims", escrow)).toMatchObject({ state: "held", worker: address, waiting: 0 });
  });
});
