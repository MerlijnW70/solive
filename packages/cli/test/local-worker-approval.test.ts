import type { Address } from "@solana/kit";
import type { Client } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it } from "vitest";
import { claimBoardAddress, deliveryBookAddress, findConfigPda, getClaimBoardDecoder, getClaimBoardEncoder, getConfigDecoder, getConfigEncoder } from "@intent-engine/core/internal";
import { WORKER_CHANGED } from "../src/agent/wallet/worker.js";
import { PREVIEW_APPROVAL_NEXT } from "../src/agent/wallet/guard.js";
import { h } from "./harness.js";
import { call, hireWith, lamportsOf, ok, plantBook, server, startHirer, workerFiles } from "./local-worker-kit.js";

const ANNOUNCE_FEE = 12_345n;

const lamportsIn = (sol: string): bigint => {
  const [whole = "0", fraction = ""] = sol.replace(" SOL", "").split(".");
  return BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0"));
};

const raiseAnnounceFee = async () => {
  const [config] = await findConfigPda();
  const view = h.svm.getAccount(config);
  if (!view.exists) {
    throw new Error("no config");
  }
  const decoded = getConfigDecoder().decode(view.data);
  h.svm.setAccount({ ...view, data: Uint8Array.from(getConfigEncoder().encode({ ...decoded, announceFee: decoded.announceFee + Number(ANNOUNCE_FEE) })) });
};

const raiseStake = async (intent: Address) => {
  const board = await claimBoardAddress(intent);
  const view = h.svm.getAccount(board);
  if (!view.exists) {
    throw new Error("no claims board");
  }
  const decoded = getClaimBoardDecoder().decode(view.data);
  h.svm.setAccount({ ...view, data: Uint8Array.from(getClaimBoardEncoder().encode({ ...decoded, stake: decoded.stake + 1n })) });
};

const BUSY = 50_000n;

describe("a local worker's send", () => {
  let hirer: Client;
  let wallet: Address;

  beforeEach(async () => {
    ({ hirer, wallet } = await startHirer());
  });

  it("sends exactly the funding its preview showed, with the preview's approval", async () => {
    const { intent } = await hireWith(hirer, wallet, true);
    const preview = await ok(hirer, "wallet_worker", { intent });
    expect(preview).toMatchObject({ sent: false, next: PREVIEW_APPROVAL_NEXT });
    expect(preview["approval"]).toMatch(/^[0-9a-f]{16}$/);
    const before = lamportsOf(wallet);
    const done = await ok(hirer, "wallet_worker", { intent, approval: preview["approval"], send: true });
    expect(done).toMatchObject({ sent: true, funding: preview["funding"], approval: preview["approval"] });
    const funding = lamportsIn(preview["funding"] as string);
    expect(lamportsOf(done["worker"] as Address)).toBe(funding);
    expect(before - lamportsOf(wallet)).toBeGreaterThanOrEqual(funding);
  }, 60_000);

  it("refuses a send without an approval, or after the announce fee changed, and sends nothing", async () => {
    const { intent } = await hireWith(hirer, wallet, false);
    const preview = await ok(hirer, "wallet_worker", { intent });
    const before = lamportsOf(wallet);
    expect((await call(hirer, "wallet_worker", { intent, send: true })).value).toMatchObject({ code: "ReleaseChanged", hint: WORKER_CHANGED });
    expect((await call(hirer, "wallet_worker", { intent, approval: "0".repeat(16), send: true })).value).toMatchObject({ code: "ReleaseChanged", hint: WORKER_CHANGED });
    await raiseAnnounceFee();
    const refused = await call(hirer, "wallet_worker", { intent, approval: preview["approval"], send: true });
    expect(refused.value).toMatchObject({ code: "ReleaseChanged", hint: WORKER_CHANGED });
    expect(lamportsOf(wallet)).toBe(before);
    expect(workerFiles()).toEqual([]);
    const again = await ok(hirer, "wallet_worker", { intent });
    expect(lamportsIn(again["funding"] as string) - lamportsIn(preview["funding"] as string)).toBe(ANNOUNCE_FEE);
    expect(again["approval"]).not.toBe(preview["approval"]);
    const done = await ok(hirer, "wallet_worker", { intent, approval: again["approval"], send: true });
    expect(lamportsOf(done["worker"] as Address)).toBe(lamportsIn(again["funding"] as string));
  }, 60_000);

  it("refuses an approval altered by one character, or taken from another job, and sends nothing", async () => {
    const { intent } = await hireWith(hirer, wallet, false);
    const other = await hireWith(hirer, wallet, false);
    const preview = await ok(hirer, "wallet_worker", { intent });
    const approval = preview["approval"] as string;
    const altered = `${approval.slice(0, -1)}${approval.endsWith("0") ? "1" : "0"}`;
    const elsewhere = (await ok(hirer, "wallet_worker", { intent: other.intent }))["approval"];
    const before = lamportsOf(wallet);
    for (const tampered of [altered, elsewhere]) {
      expect(tampered).not.toBe(approval);
      expect((await call(hirer, "wallet_worker", { intent, approval: tampered, send: true })).value).toMatchObject({ code: "ReleaseChanged", hint: WORKER_CHANGED });
    }
    expect(lamportsOf(wallet)).toBe(before);
    expect(workerFiles()).toEqual([]);
    const done = await ok(hirer, "wallet_worker", { intent, approval, send: true });
    expect(done).toMatchObject({ sent: true, approval });
  }, 60_000);

  const refusedAfter = async (intent: Address, change: () => Promise<Client>, previewer: Client = hirer) => {
    const preview = await ok(previewer, "wallet_worker", { intent });
    const client = await change();
    const before = lamportsOf(wallet);
    expect((await call(client, "wallet_worker", { intent, approval: preview["approval"], send: true })).value).toMatchObject({ code: "ReleaseChanged", hint: WORKER_CHANGED });
    expect(lamportsOf(wallet)).toBe(before);
    expect(workerFiles()).toEqual([]);
    const again = await ok(client, "wallet_worker", { intent });
    expect(again["funding"]).not.toBe(preview["funding"]);
    return { preview, again };
  };

  it("refuses a send after the claim stake changed", async () => {
    const { intent } = await hireWith(hirer, wallet, true);
    const { preview, again } = await refusedAfter(intent, async () => {
      await raiseStake(intent);
      return hirer;
    });
    expect(lamportsIn(again["funding"] as string) - lamportsIn(preview["funding"] as string)).toBe(1n);
  }, 60_000);

  it("refuses a send after the delivery book appeared, which drops its rent", async () => {
    const { intent } = await hireWith(hirer, wallet, false);
    const { preview, again } = await refusedAfter(intent, async () => {
      await plantBook(wallet, intent);
      expect(h.svm.getAccount(await deliveryBookAddress(intent)).exists).toBe(true);
      return hirer;
    });
    expect(lamportsIn(again["funding"] as string)).toBeLessThan(lamportsIn(preview["funding"] as string));
  }, 60_000);

  it("refuses a send after the node's recent priority fees rose", async () => {
    const { intent } = await hireWith(hirer, wallet, false);
    const auto = await server(["--priority-fee", "auto"]);
    const { preview, again } = await refusedAfter(
      intent,
      async () => {
        const live = h.through as NonNullable<typeof h.through>;
        h.through = { ...live, recentFees: async () => [BUSY, BUSY, BUSY] };
        return server(["--priority-fee", "auto"]);
      },
      auto,
    );
    expect(lamportsIn(again["funding"] as string)).toBeGreaterThan(lamportsIn(preview["funding"] as string));
  }, 60_000);
});
