import { type Address, generateKeyPairSigner } from "@solana/kit";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Kind } from "@intent-engine/core";
import type { ProgramAccount } from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import type { IntentChanges } from "@intent-engine/client/internal";
import { agentServer } from "../src/agent/mcp.js";
import { claimsOf } from "../src/agent/claims.js";
import { NO_CLOCK } from "../src/agent/wallet/receipt.js";
import { NO_JOB_NOW, NO_JOB_YET } from "../src/agent/jobs.js";
import { WAIT_MAX } from "../src/agent/wallet/guard.js";
import { elapsedOf } from "../src/monotonic.js";
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

  async function linked(withClock = true, jobChanges?: () => IntentChanges): Promise<Client> {
    const rt = runtime({});
    const clock = {
      now: rt.now,
      elapsed: () => elapsedOf(rt),
      sleep: async (seconds: number) => {
        await opening.shift()?.();
        return rt.sleep(seconds);
      },
    };
    const server = agentServer({ transport, relay: undefined, agent: undefined, claims: claimsOf(), ...(withClock ? { clock } : {}), ...(jobChanges === undefined ? {} : { url: "http://cluster", jobChanges }) });
    const [near, far] = InMemoryTransport.createLinkedPair();
    await server.connect(near);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(far);
    return client;
  }

  const call = async (client: Client, args: Json) => {
    const result = await client.callTool({ name: "solive_find_jobs", arguments: { attestor: judge, all: true, ...args } });
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

  it("does not return early for a job it already listed", async () => {
    const client = await linked();
    const job = await open(w.inputMint, w.outputMint, 100n)();
    const value = await ok(client, { wait: 5 });
    expect(intents(value)).toEqual([job]);
    expect(value["next"]).toContain("solive_get_spec");
    expect(h.sleeps).toEqual([4, 1]);
  });

  it("returns early once a job its first read did not list appears beside one it did", async () => {
    const client = await linked();
    const seen = await open(w.inputMint, w.outputMint, 100n)();
    let job: unknown;
    opening = [async () => undefined, async () => (job = await open(w.inputMint, w.outputMint, 100n)())];
    const value = await ok(client, { wait: 10 });
    expect(new Set(intents(value))).toEqual(new Set([seen, job]));
    expect(h.sleeps).toEqual([4, 4]);
  });

  it("reads afresh until a job opened during the wait appears", async () => {
    const client = await linked();
    expect(intents(await ok(client, {}))).toEqual([]);
    let job: unknown;
    opening = [async () => undefined, async () => (job = await open(w.inputMint, w.outputMint, 100n)())];
    const value = await ok(client, { wait: 5 });
    expect(intents(value)).toEqual([job]);
    expect(value["next"]).toContain("solive_get_spec");
    expect(h.sleeps).toEqual([4, 1]);
  });

  it("says when the time ran out with no job and that wait keeps waiting", async () => {
    const client = await linked();
    const value = await ok(client, { wait: 3 });
    expect(value).toEqual({ fee_bps: expect.any(Number), jobs: [], next: NO_JOB_YET });
    expect(NO_JOB_YET).toContain("solive_find_jobs again with wait to keep waiting");
    expect(h.sleeps).toEqual([3]);
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
    expect(h.sleeps).toEqual([4, 4, 2]);
    h.sleeps.length = 0;
    expect(await ok(client, { mint: "SOL", min_pay: "0.0001", wait: 2 })).toEqual({ fee_bps: expect.any(Number), jobs: [], next: NO_JOB_YET });
    expect(h.sleeps).toEqual([2]);
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

  it("without wait reads once and hints a wait when it finds nothing", async () => {
    const client = await linked();
    expect(await ok(client, {})).toEqual({ fee_bps: expect.any(Number), jobs: [], next: NO_JOB_NOW });
    const job = await open(w.inputMint, w.outputMint, 100n)();
    const value = await ok(client, {});
    expect(intents(value)).toEqual([job]);
    expect(Object.keys(value).sort()).toEqual(["fee_bps", "jobs", "next"]);
    expect(h.sleeps).toEqual([]);
    const bare = await linked(false);
    expect(intents(await ok(bare, {}))).toEqual([job]);
    expect((await call(bare, { wait: 1 })).value).toMatchObject({ code: "NoClock", hint: NO_CLOCK });
  });
  const heard = (script: (step: number, calls: number) => Promise<ProgramAccount[] | null>) => {
    const steps: number[] = [];
    const state = { closed: 0 };
    const changes: IntentChanges = {
      wait: async (seconds) => {
        steps.push(seconds);
        return script(seconds, steps.length);
      },
      close: () => {
        state.closed++;
      },
    };
    return { steps, state, changes };
  };

  const noted = [{ address: "11111111111111111111111111111112" as Address, data: new Uint8Array() }];

  it("with notifications reads at the slow interval, not once a second, and closes them", async () => {
    const { steps, state, changes } = heard(async () => []);
    const client = await linked(true, () => changes);
    const before = h.scans;
    const value = await ok(client, { wait: 40 });
    expect(steps).toEqual([10, 10, 10, 10]);
    expect(h.sleeps).toEqual([]);
    expect(h.scans - before).toBeLessThanOrEqual(10);
    expect(value["next"]).toBe(NO_JOB_YET);
    expect(state.closed).toBe(1);
  });

  it("with notifications reads again as soon as one arrives, and lists the job it announced", async () => {
    let job: unknown;
    const { steps, changes } = heard(async (_, calls) => {
      job = calls === 1 ? await open(w.inputMint, w.outputMint, 100n)() : job;
      return calls === 1 ? noted : [];
    });
    const client = await linked(true, () => changes);
    expect(intents(await ok(client, {}))).toEqual([]);
    const value = await ok(client, { wait: 30 });
    expect(intents(value)).toEqual([job]);
    expect(steps).toEqual([10]);
    expect(h.sleeps).toEqual([2]);
  });

  it("with notifications bounds the reads when they keep coming", async () => {
    h.rounds = 100;
    const { changes } = heard(async () => noted);
    const client = await linked(true, () => changes);
    const before = h.scans;
    await ok(client, { wait: 40 });
    expect(h.sleeps.every((seconds) => seconds === 2)).toBe(true);
    expect(h.sleeps.length).toBeLessThanOrEqual(20);
    expect(h.scans - before).toBeLessThanOrEqual(42);
  });

  it("falls back to polling at a bounded rate when the notifications end", async () => {
    h.rounds = 100;
    const { steps, state, changes } = heard(async () => null);
    const client = await linked(true, () => changes);
    const before = h.scans;
    await ok(client, { wait: 30 });
    expect(steps).toEqual([10]);
    expect(h.sleeps).toEqual([4, 4, 4, 4, 4]);
    expect(h.scans - before).toBeLessThanOrEqual(14);
    expect(state.closed).toBe(1);
  });

  it("polls at a bounded rate without notifications", async () => {
    const client = await linked();
    const before = h.scans;
    await ok(client, { wait: 40 });
    expect(h.sleeps).toEqual(Array.from({ length: 10 }, () => 4));
    expect(h.scans - before).toBeLessThanOrEqual(22);
  });

  it("backs off while the node answers 429, and refuses when it never answers", async () => {
    const refusing = vi.spyOn(transport, "intents").mockRejectedValue(new Error("429 Too Many Requests"));
    const client = await linked();
    const refused = await call(client, { wait: 40 });
    expect(refused.error).toBe(true);
    expect(h.sleeps).toEqual([8, 16, 16]);
    expect(refusing.mock.calls.length).toBe(4);
    refusing.mockRestore();
  });
});
