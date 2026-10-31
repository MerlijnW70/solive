import type { Address } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { WORKER_SAME_KEY } from "../src/agent/wallet/worker.js";
import { h } from "./harness.js";
import { call, hireWith, lamportsOf, startHirer, WALLET, workerFiles } from "./local-worker-kit.js";

const forced = vi.hoisted(() => ({ key: undefined as { address: Address; text: string } | undefined }));

vi.mock("../src/wallet.js", async (original) => {
  const real = await original<typeof import("../src/wallet.js")>();
  return { ...real, newKeyFile: async () => forced.key ?? real.newKeyFile() };
});

describe("a local worker's key", () => {
  it("is refused when it would equal the wallet, the owner or the attestor, on preview and on send", async () => {
    const { hirer, wallet } = await startHirer();
    const { intent } = await hireWith(hirer, wallet, false);
    forced.key = { address: wallet, text: h.files.get(WALLET) as string };
    const before = lamportsOf(wallet);
    for (const send of [false, true]) {
      expect((await call(hirer, "wallet_worker", { intent, send })).value).toMatchObject({ code: "WorkerUnfit", hint: WORKER_SAME_KEY });
    }
    expect(workerFiles()).toEqual([]);
    expect(lamportsOf(wallet)).toBe(before);
  });
});
