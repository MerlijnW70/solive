import { type Address, getBase58Decoder } from "@solana/kit";
import { afterEach, describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, NATIVE_MINT } from "@intent-engine/core";
import { svmTransport } from "@intent-engine/client/svm";
import { EXIT_OK } from "../src/main.js";
import { cli, DOMAIN, funded, h, NOW, transport, world } from "./harness.js";
import { claimOf } from "../src/agent/job-claims.js";
import { AgentRefusal } from "../src/agent/problems.js";
import { claimable } from "../src/agent/wallet/worker.js";
import { call, hireWith, lamportsOf, ok, preset, removeWorkFiles, server, workerFiles } from "./local-worker-kit.js";

describe("wallet_worker refuses a job whose fills are stopped, before funding anything", () => {
  afterEach(removeWorkFiles);

  it("refuses on a fill pause and on a stopped kind, for a job with claims and one without", async () => {
    const w = await world();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    h.through = svmTransport(h.svm, { genesisHash: getBase58Decoder().decode(DOMAIN) });
    const hirer = await server();
    const wallet = (await ok(hirer, "wallet_setup"))["address"] as Address;
    h.watched.push(wallet);
    const keys = { "a.json": w.authority };
    const admin = async (args: string[]) => expect((await cli([...args, "--keypair", "a.json", "--yes"], keys)).code).toBe(EXIT_OK);
    const jobs = [await hireWith(hirer, wallet, true), await hireWith(hirer, wallet, false)];
    const before = lamportsOf(wallet);
    const refused = async (intent: string, code: string) => {
      for (const args of [{ intent }, { intent, send: true, approval: "0000000000000000" }]) {
        const result = await call(hirer, "wallet_worker", args);
        expect(result.error).toBe(true);
        expect(result.value).toMatchObject({ code });
      }
      expect(lamportsOf(wallet)).toBe(before);
      expect(workerFiles()).toEqual([]);
    };

    await admin(["raise-pause", "--flags", "fill"]);
    for (const { intent } of jobs) await refused(intent, "FillPaused");
    await admin(["lower-pause", "--flags", "fill"]);

    await admin(["update-config", "--fill-disabled", "attested"]);
    for (const { intent } of jobs) await refused(intent, "FillKindDisabled");
    await admin(["update-config", "--fill-disabled", "none"]);

    for (const { intent } of jobs) {
      expect((await call(hirer, "wallet_worker", { intent })).error).toBe(false);
    }
  });

  it("judges a held claim on the clock read after the view", async () => {
    const w = await world();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    h.through = svmTransport(h.svm, { genesisHash: getBase58Decoder().decode(DOMAIN) });
    const hirer = await server();
    const wallet = (await ok(hirer, "wallet_setup"))["address"] as Address;
    h.watched.push(wallet);
    const { intent, nonce } = await hireWith(hirer, wallet, true);
    const holder = await funded();
    const taken = await cli(["claims", "take", "--keypair", "holder.json", "--owner", wallet, "--nonce", nonce, "--secs", "60", "--yes"], { "holder.json": holder, "a.json": w.authority });
    expect(taken.code).toBe(EXIT_OK);
    const view = await claimOf(transport, intent as Address);
    expect(() => claimable(intent as Address, view, NOW)).toThrow(AgentRefusal);
    expect(() => claimable(intent as Address, view, NOW + 60n)).not.toThrow();
  });
});
