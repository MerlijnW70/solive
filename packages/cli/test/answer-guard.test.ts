import { afterEach, describe, expect, it, vi } from "vitest";
import { DEVNET_TEST_MINT, NATIVE_MINT } from "@intent-engine/core";
import { walletBalance } from "../src/agent/wallet/account.js";
import { servedActions } from "../src/agent/everyday.js";
import { call, connect, ok, preset } from "./agent-wallet-kit.js";
import { h, world } from "./harness.js";
import { takeMisses } from "./answer-guard.js";

afterEach(() => {
  vi.restoreAllMocks();
});

async function served() {
  await world();
  h.files.clear();
  preset(NATIVE_MINT);
  preset(DEVNET_TEST_MINT);
  const client = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
  await ok(client, "wallet_setup");
  await takeMisses();
  return client;
}

describe("the answer guard", () => {
  it("passes the answer of a tool that keeps to its output schema", async () => {
    const client = await served();
    await ok(client, "wallet_balance");
    expect(await takeMisses()).toEqual([]);
  });

  it("reports a tool whose handler returns a field its schema does not declare", async () => {
    const client = await served();
    const real = walletBalance.run;
    vi.spyOn(walletBalance, "run").mockImplementation(async (...args) => ({ ...(await real(...args)), undeclared: "x" }));
    const failed = await call(client, "wallet_balance");
    expect(failed.error).toBe(true);
    const misses = await takeMisses();
    expect(misses).toHaveLength(1);
    expect(misses[0]).toContain("solive_wallet_balance");
    expect(misses[0]).toContain("undeclared");
  });

  it("covers every served tool with a schema that rejects an unknown field", () => {
    for (const action of servedActions({ wallet: true, allTools: true, relay: true, agent: true })) {
      const json = action.output.json as { additionalProperties?: unknown };
      expect([action.name, json.additionalProperties]).toEqual([action.name, false]);
    }
  });
});
