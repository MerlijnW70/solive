import { type Address, generateKeyPairSigner } from "@solana/kit";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { Kind } from "@intent-engine/core";
import { createClient } from "@intent-engine/client";
import { agentServer } from "../src/agent/mcp.js";
import { claimsOf } from "../src/agent/claims.js";
import { NO_CLOCK } from "../src/agent/wallet/receipt.js";
import { NO_JOB_YET } from "../src/agent/jobs.js";
import { WAIT_MAX } from "../src/agent/wallet/guard.js";
import { ata, h, NOW, runtime, transport, type World, world } from "./harness.js";

type Json = Record<string, unknown>;

const specHash = new Uint8Array(32).fill(7);
const proof = (attestor: Address, amountIn: bigint) => ({ kind: Kind.AttestedResult, amountIn, minResult: 1n, maxResult: 1n, attestor, specHash, judgeFee: 0n }) as const;

describe("solive_find_jobs with wait", () => {
  let w: World;
  let judge: Address;
  let opening: (() => Promise<unknown>)[];
  let nonce: bigint;

  const open = (inputMint: Address, outputMint: Address, amountIn: bigint) => async () => {
    nonce += 1n;
    const client = createClient({ url: "http://cluster", transport });
    return (await client.createIntent({ signer: w.owner, inputMint, outputMint, params: proof(judge, amountIn), nonce, expiresAt: NOW + 3_600n + nonce })).intent;
  };

  async function linked(withClock = true): Promise<Client> {
    const rt = runtime({});
    const clock = {
      now: rt.now,
      sleep: async (seconds: number) => {
        await opening.shift()?.();
        return rt.sleep(seconds);
      },
    };
    const server = agentServer({ transport, relay: undefined, agent: undefined, claims: claimsOf(), ...(withClock ? { clock } : {}) });
    const [near, far] = InMemoryTransport.createLinkedPair();
    await server.connect(near);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(far);
    return client;
  }

  const call = async (client: Client, args: Json) => {
    const result = await client.callTool({ name: "solive_find_jobs", arguments: { attestor: judge, ...args } });
    return { error: result.isError === true, value: result.structuredContent as Json };
  };

  const ok = async (client: Client, args: Json) => {
    const { error, value } = await call(client, args);
    expect(error, JSON.stringify(value)).toBe(false);
    return value;
  };

  const intents = (value: Json) => (value["jobs"] as { intent: Address }[]).map(({ intent }) => intent);

  beforeEach(async () => {
    w = await world();
    h.watched.push(w.owner.address);
    await ata(w.authority, w.owner.address, w.outputMint, 1_000n);
    judge = (await generateKeyPairSigner()).address;
    opening = [];
    nonce = 0n;
    h.rounds = 10;
  });

  it("returns a job already open without waiting", async () => {
    const client = await linked();
    const job = await open(w.inputMint, w.outputMint, 100n)();
    const value = await ok(client, { wait: 5 });
    expect(intents(value)).toEqual([job]);
    expect(value["next"]).toBeUndefined();
    expect(h.sleeps).toEqual([]);
  });

  it("reads afresh until a job opened during the wait appears", async () => {
    const client = await linked();
    expect(intents(await ok(client, {}))).toEqual([]);
    let job: unknown;
    opening = [async () => undefined, async () => (job = await open(w.inputMint, w.outputMint, 100n)())];
    const value = await ok(client, { wait: 5 });
    expect(intents(value)).toEqual([job]);
    expect(value["next"]).toBeUndefined();
    expect(h.sleeps).toEqual([1, 1]);
  });

  it("says when the time ran out with no job and that wait keeps waiting", async () => {
    const client = await linked();
    const value = await ok(client, { wait: 3 });
    expect(value).toEqual({ fee_bps: expect.any(Number), jobs: [], next: NO_JOB_YET });
    expect(NO_JOB_YET).toContain("solive_find_jobs again with wait to keep waiting");
    expect(h.sleeps).toEqual([1, 1, 1]);
  });

  it("waits past jobs the mint and min_pay filters leave out", async () => {
    const client = await linked();
    let job: unknown;
    opening = [
      open(w.outputMint, w.inputMint, 500n),
      open(w.inputMint, w.outputMint, 100n),
      async () => (job = await open(w.inputMint, w.outputMint, 300n)()),
    ];
    const value = await ok(client, { mint: w.inputMint, min_pay: "0.0002", wait: 10 });
    expect(intents(value)).toEqual([job]);
    expect(h.sleeps).toEqual([1, 1, 1]);
    h.sleeps.length = 0;
    expect(await ok(client, { mint: "SOL", min_pay: "0.0001", wait: 2 })).toEqual({ fee_bps: expect.any(Number), jobs: [], next: NO_JOB_YET });
    expect(h.sleeps).toEqual([1, 1]);
  });

  it("refuses a wait above the maximum or below one second", async () => {
    const client = await linked();
    for (const wait of [WAIT_MAX + 1, 0]) {
      const { error, value } = await call(client, { wait });
      expect(error).toBe(true);
      expect(value).toMatchObject({ code: "InvalidInput", issues: [{ path: "wait" }] });
    }
    expect(h.sleeps).toEqual([]);
  });

  it("without wait reads once and adds no next", async () => {
    const client = await linked();
    expect(await ok(client, {})).toEqual({ fee_bps: expect.any(Number), jobs: [] });
    const job = await open(w.inputMint, w.outputMint, 100n)();
    const value = await ok(client, {});
    expect(intents(value)).toEqual([job]);
    expect(Object.keys(value).sort()).toEqual(["fee_bps", "jobs"]);
    expect(h.sleeps).toEqual([]);
    const bare = await linked(false);
    expect(intents(await ok(bare, {}))).toEqual([job]);
    expect((await call(bare, { wait: 1 })).value).toMatchObject({ code: "NoClock", hint: NO_CLOCK });
  });
});
