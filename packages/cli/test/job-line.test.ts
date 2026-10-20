import { createHash } from "node:crypto";
import { type Address, generateKeyPairSigner } from "@solana/kit";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { claimBoardAddress, Kind, standbyAddress } from "@intent-engine/core";
import { createClient } from "@intent-engine/client";
import { agentServer } from "../src/agent/mcp.js";
import { claimsOf } from "../src/agent/claims.js";
import { heldBy, lineWaiting } from "../src/claim-commands.js";
import { NOT_SENT } from "../src/flows.js";
import { EXIT_FAILED, EXIT_OK } from "../src/main.js";
import { cli, funded, h, NOW, setNow, transport, world } from "./harness.js";

type Json = Record<string, unknown> & { [key: string]: any };

const STAKE = 50_000_000n;
const SPEC = new Uint8Array(createHash("sha256").update("the job with a line").digest());

async function job() {
  const w = await world();
  h.watched.push(w.owner.address);
  const [worker, first, second, payer] = await Promise.all([funded(), funded(), funded(), funded()]);
  const judge = (await generateKeyPairSigner()).address;
  const client = createClient({ url: "http://cluster", transport });
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge, specHash: SPEC, judgeFee: 0n } as const;
  const { intent } = await client.createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  const keys = { "owner.json": w.owner, "worker.json": worker, "first.json": first, "second.json": second, "payer.json": payer };
  const ref = ["--owner", w.owner.address, "--nonce", "0"];
  const run = (args: string[]) => cli(args, keys);
  const ok = async (args: string[]) => {
    const result = await run(args);
    expect([result.code, result.err]).toEqual([EXIT_OK, ""]);
    return result.json() as Json;
  };
  const refused = async (args: string[]) => {
    const result = await run(args);
    expect(result.code).toBe(EXIT_FAILED);
    return result.err;
  };
  await ok(["claims", "open", "--keypair", "owner.json", "--nonce", "0", "--max-secs", "3600", "--stake", "0.05", "--yes"]);
  const show = async () => ok(["claims", "show", ...ref]);
  const sol = (address: Address) => h.svm.getBalance(address) ?? 0n;
  const standBy = (who: string, secs: string, yes = true) => ok(["claims", "standby", "--keypair", who, ...ref, "--secs", secs, ...(yes ? ["--yes"] : [])]);
  return { w, client, intent, worker, first, second, payer, ref, run, ok, refused, show, sol, standBy };
}

describe("the stand-by line from the command line", () => {
  it("claims standby joins the line only while the job is held, and claims take then refuses", async () => {
    const j = await job();
    expect(await j.refused(["claims", "standby", "--keypair", "first.json", ...j.ref, "--secs", "600", "--yes"])).toContain("claim it with claims take");
    await j.ok(["claims", "take", "--keypair", "worker.json", ...j.ref, "--secs", "600", "--yes"]);
    const preview = await j.standBy("first.json", "600", false);
    expect(preview).toMatchObject({ seq: 0, sent: false, next: NOT_SENT });
    expect(preview["summary"][0]).toContain("place 1 in its line");
    expect(await j.refused(["claims", "standby", "--keypair", "first.json", ...j.ref, "--secs", "3601"])).toContain("at most 3600 seconds");
    const before = j.sol(j.first.address);
    expect(await j.standBy("first.json", "600")).toMatchObject({ sent: true });
    expect(before - j.sol(j.first.address)).toBeGreaterThan(STAKE);
    expect(h.svm.getAccount(await standbyAddress(j.intent, 0)).exists).toBe(true);
    expect(await j.show()).toMatchObject({ state: "held", line: { head: 0, tail: 1, waiting: 1 } });
    setNow(NOW + 600n);
    expect(await j.refused(["claims", "take", "--keypair", "second.json", ...j.ref, "--secs", "60", "--yes"])).toBe(lineWaiting(j.intent, 1));
  });

  it("claims take and claims standby refuse while fills are paused, and a waiter still leaves", async () => {
    const j = await job();
    const pause = (verb: string) => cli([verb, "--keypair", "a.json", "--yes", "--flags", "fill"], { "a.json": j.w.authority });
    const paused = `fills are paused by the guardian or admin, and with them new claims and stand-by joins on escrow ${j.intent}; try again once the pause is lowered; nothing was sent`;
    expect((await pause("raise-pause")).code).toBe(EXIT_OK);
    expect(await j.refused(["claims", "take", "--keypair", "worker.json", ...j.ref, "--secs", "600", "--yes"])).toContain(paused);
    expect((await pause("lower-pause")).code).toBe(EXIT_OK);
    await j.ok(["claims", "take", "--keypair", "worker.json", ...j.ref, "--secs", "600", "--yes"]);
    await j.standBy("first.json", "600");
    expect((await pause("raise-pause")).code).toBe(EXIT_OK);
    expect(await j.refused(["claims", "standby", "--keypair", "second.json", ...j.ref, "--secs", "600", "--yes"])).toContain(paused);
    const before = j.sol(j.first.address);
    await j.ok(["claims", "leave", "--keypair", "first.json", ...j.ref, "--yes"]);
    expect(j.sol(j.first.address) - before).toBeGreaterThan(STAKE);
  });

  it("claims drop hands the job to the first worker still in the line", async () => {
    const j = await job();
    await j.ok(["claims", "take", "--keypair", "worker.json", ...j.ref, "--secs", "600", "--yes"]);
    await j.standBy("first.json", "600");
    await j.standBy("second.json", "900");
    const left = j.sol(j.first.address);
    const leave = await j.ok(["claims", "leave", "--keypair", "first.json", ...j.ref, "--yes"]);
    expect(leave).toMatchObject({ seq: 0, worker: j.first.address, sent: true });
    expect(j.sol(j.first.address) - left).toBeGreaterThan(STAKE);
    const drop = ["claims", "drop", "--keypair", "worker.json", ...j.ref];
    const preview = await j.ok(drop);
    expect(preview["summary"]).toContain(`Hands: the job to ${j.second.address}, first in the line`);
    expect(preview["summary"]).toContain("Skips: 1 line entry whose worker left");
    await j.ok([...drop, "--yes"]);
    expect(await j.show()).toMatchObject({ state: "held", worker: j.second.address, until: String(NOW + 900n), line: { head: 2, tail: 2, waiting: 0 } });
  });

  it("claims advance forfeits a lapsed holder's stake to the owner and hands the job on", async () => {
    const j = await job();
    await j.ok(["claims", "take", "--keypair", "worker.json", ...j.ref, "--secs", "60", "--yes"]);
    const advance = ["claims", "advance", "--keypair", "payer.json", ...j.ref];
    expect(await j.refused(advance)).toContain("nobody stands by");
    await j.standBy("first.json", "600");
    expect(await j.refused(advance)).toContain(heldBy(j.intent, j.worker.address, 60n));
    setNow(NOW + 60n);
    const preview = await j.ok(advance);
    expect(preview["summary"]).toContain(`Ends: the lapsed claim of ${j.worker.address}, whose stake of 0.05 SOL goes to the owner ${j.w.owner.address}`);
    expect(preview["summary"]).toContain(`Hands: the job to ${j.first.address}, first in the line`);
    const owner = j.sol(j.w.owner.address);
    await j.ok([...advance, "--yes"]);
    expect(j.sol(j.w.owner.address) - owner).toBe(STAKE);
    expect(await j.show()).toMatchObject({ state: "held", worker: j.first.address, line: { waiting: 0 } });
  });

  it("claims leave lets anyone return a waiter's stake once the escrow is done, even after its board closed", async () => {
    const j = await job();
    await j.ok(["claims", "take", "--keypair", "worker.json", ...j.ref, "--secs", "600", "--yes"]);
    await j.standBy("first.json", "600");
    await j.standBy("second.json", "600");
    expect(await j.refused(["claims", "leave", "--keypair", "payer.json", ...j.ref, "--seq", "0", "--yes"])).toContain(`only ${j.first.address} can take entry 0`);
    expect(await j.refused(["claims", "leave", "--keypair", "payer.json", ...j.ref, "--yes"])).toContain(`${j.payer.address} stands by nowhere`);
    await j.client.cancel(j.w.owner, 0n);
    const first = j.sol(j.first.address);
    await j.ok(["claims", "leave", "--keypair", "payer.json", ...j.ref, "--seq", "0", "--yes"]);
    expect(j.sol(j.first.address) - first).toBeGreaterThan(STAKE);
    await j.ok(["claims", "settle", "--keypair", "payer.json", ...j.ref, "--yes"]);
    expect(h.svm.getAccount(await claimBoardAddress(j.intent)).exists).toBe(false);
    expect(await j.refused(["claims", "leave", "--keypair", "second.json", ...j.ref, "--yes"])).toContain("pass --seq");
    expect(await j.refused(["claims", "leave", "--keypair", "payer.json", ...j.ref, "--seq", "0", "--yes"])).toContain("entry 0 stands nowhere");
    const second = j.sol(j.second.address);
    await j.ok(["claims", "leave", "--keypair", "payer.json", ...j.ref, "--seq", "1", "--yes"]);
    expect(j.sol(j.second.address) - second).toBeGreaterThan(STAKE);
  });

  it("jobs and solive_find_jobs count the workers standing by, and unclaimed leaves such a job out", async () => {
    const j = await job();
    await j.ok(["claims", "take", "--keypair", "worker.json", ...j.ref, "--secs", "60", "--yes"]);
    await j.standBy("first.json", "600");
    await j.standBy("second.json", "600");
    setNow(NOW + 60n);
    const listed = await j.ok(["jobs"]);
    expect(listed["jobs"]).toEqual([expect.objectContaining({ intent: j.intent, claimed_by: null, waiting: 2 })]);
    expect((await j.ok(["jobs", "--unclaimed"]))["jobs"]).toEqual([]);
    const server = agentServer({ transport, relay: undefined, agent: undefined, claims: claimsOf() });
    const [near, far] = InMemoryTransport.createLinkedPair();
    await server.connect(near);
    const mcp = new Client({ name: "test", version: "0.0.0" });
    await mcp.connect(far);
    const found = await mcp.callTool({ name: "solive_find_jobs", arguments: {} });
    expect((found.structuredContent as Json)["jobs"]).toEqual([expect.objectContaining({ intent: j.intent, claimed_by: null, waiting: 2 })]);
    const unclaimed = await mcp.callTool({ name: "solive_find_jobs", arguments: { unclaimed: true } });
    expect((unclaimed.structuredContent as Json)["jobs"]).toEqual([]);
  });
});
