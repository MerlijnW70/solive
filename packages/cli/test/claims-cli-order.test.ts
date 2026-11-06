import { createHash } from "node:crypto";
import { type Address, generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Kind } from "@intent-engine/core";
import { claimBoardAddress } from "@intent-engine/core/internal";
import { createClient } from "@intent-engine/client/node";
import { advanceStep, settleStep, standbyStep } from "../src/agent/claim-line.js";
import { dropStep, takeStep } from "../src/agent/work-claims.js";
import { heldBy, lineWaiting } from "../src/claim-commands.js";
import { notListed } from "../src/claim-lists.js";
import { EXIT_FAILED, EXIT_OK } from "../src/main.js";
import { cli, funded, h, NOW, setNow, transport, world } from "./harness.js";
import { laterThanTheView } from "./stale-clock.js";

const SPEC = new Uint8Array(createHash("sha256").update("the job the cli and the tools claim alike").digest());
const MAX = 3_600;

async function job(workers?: Address[]) {
  const w = await world();
  h.watched.push(w.owner.address);
  const [holder, first, other, stranger] = await Promise.all([funded(), funded(), funded(), funded()]);
  const judge = (await generateKeyPairSigner()).address;
  const client = createClient({ url: "http://cluster", transport });
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge, specHash: SPEC, judgeFee: 0n } as const;
  const { intent } = await client.createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  const keys: Record<string, KeyPairSigner> = { "owner.json": w.owner, "holder.json": holder, "first.json": first, "other.json": other, "stranger.json": stranger, "a.json": w.authority };
  const escrow = { owner: w.owner.address, nonce: 0n, intent };
  const ref = ["--owner", w.owner.address, "--nonce", "0"];
  const run = (args: string[]) => cli(args, keys);
  const ok = async (args: string[]) => {
    const result = await run(args);
    expect([result.code, result.err]).toEqual([EXIT_OK, ""]);
    return result.json();
  };
  const listed = workers === undefined ? [] : ["--workers", workers.join(",")];
  await ok(["claims", "open", "--review-secs", "0", "--keypair", "owner.json", "--nonce", "0", "--max-secs", String(MAX), "--stake", "0.05", ...listed, "--yes"]);
  const refusedVerb = async (name: string, who: string, secs: number) => {
    const result = await run(["claims", name, "--keypair", who, ...ref, ...(name === "advance" || name === "settle" ? [] : ["--secs", String(secs)])]);
    expect(result.code).toBe(EXIT_FAILED);
    return result.err;
  };
  const view = () => client.claims({ owner: w.owner.address, nonce: 0n }).then((v) => v!);
  const tools = {
    take: async (who: KeyPairSigner, secs: number) => takeStep(client, escrow, await view(), who as never, secs),
    standby: async (who: KeyPairSigner, secs: number) => standbyStep(client, transport, escrow, await view(), who as never, secs),
    advance: async (who: KeyPairSigner) => advanceStep(client, transport, escrow, await view(), who.address),
  };
  return { w, client, escrow, intent, ref, run, ok, refusedVerb, tools, view, holder, first, other, stranger };
}

type Job = Awaited<ReturnType<typeof job>>;

const toolRefusal = (run: Promise<unknown>) => run.then(() => null, (error: unknown) => (error as { problem: { code: string; hint: string } }).problem);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the claims commands and the tools refuse alike", () => {
  it("a held job with a waiter is a waiting line, not a held claim", async () => {
    const j = await job();
    await j.ok(["claims", "take", "--keypair", "holder.json", ...j.ref, "--secs", "600", "--yes"]);
    await j.ok(["claims", "standby", "--keypair", "first.json", ...j.ref, "--secs", "600", "--yes"]);
    expect(await j.refusedVerb("take", "other.json", 60)).toBe(lineWaiting(j.intent, 1));
    expect(await toolRefusal(j.tools.take(j.other, 60))).toMatchObject({ code: "LineWaiting", hint: expect.stringContaining("1 worker stands by for escrow") });
  });

  it("a closed escrow is named before the terms, for a take, a stand-by and an advance", async () => {
    const j = await job();
    await j.ok(["claims", "take", "--keypair", "holder.json", ...j.ref, "--secs", "600", "--yes"]);
    await j.client.cancel(j.w.owner, { owner: j.w.owner.address, nonce: 0n });
    const take = await toolRefusal(j.tools.take(j.other, MAX + 1));
    expect(take).toMatchObject({ code: "InvalidTransition" });
    expect(await j.refusedVerb("take", "other.json", MAX + 1)).toBe(take?.hint);
    const standby = await toolRefusal(j.tools.standby(j.other, MAX + 1));
    expect(standby).toMatchObject({ code: "InvalidTransition" });
    expect(await j.refusedVerb("standby", "other.json", MAX + 1)).toBe(standby?.hint);
    const advance = await toolRefusal(j.tools.advance(j.other));
    expect(advance).toMatchObject({ code: "InvalidTransition" });
    const stem = `escrow ${j.intent} is no longer open, so its line is not advanced; each waiter gets its stake back with `;
    expect(advance?.hint.startsWith(stem)).toBe(true);
    expect((await j.refusedVerb("advance", "other.json", 0)).startsWith(stem)).toBe(true);
  });

  it("out-of-range secs are one refusal on a free job and on a held one", async () => {
    const j = await job();
    const free = await toolRefusal(j.tools.take(j.other, MAX + 1));
    expect(free).toMatchObject({ code: "ClaimTerms", hint: expect.stringContaining(`at most ${MAX} seconds`) });
    expect(await j.refusedVerb("take", "other.json", MAX + 1)).toContain(`at most ${MAX} seconds`);
    await j.ok(["claims", "take", "--keypair", "holder.json", ...j.ref, "--secs", "600", "--yes"]);
    const held = await toolRefusal(j.tools.standby(j.other, MAX + 1));
    expect(held).toMatchObject({ code: "ClaimTerms", hint: expect.stringContaining(`at most ${MAX} seconds`) });
    expect(await j.refusedVerb("standby", "other.json", MAX + 1)).toContain(`at most ${MAX} seconds`);
    expect(await j.refusedVerb("standby", "holder.json", MAX + 1)).toContain(`at most ${MAX} seconds`);
  });

  it("secs equal to the longest claim is accepted by both", async () => {
    const j = await job();
    const taking = await j.ok(["claims", "take", "--keypair", "holder.json", ...j.ref, "--secs", String(MAX)]);
    expect(taking["sent"]).toBe(false);
    expect((await j.tools.take(j.holder, MAX)).key).toBe(`${MAX}:50000000:0:0`);
    await j.ok(["claims", "take", "--keypair", "holder.json", ...j.ref, "--secs", "600", "--yes"]);
    const waiting = await j.ok(["claims", "standby", "--keypair", "other.json", ...j.ref, "--secs", String(MAX)]);
    expect(waiting["sent"]).toBe(false);
    expect((await j.tools.standby(j.other, MAX)).key).toContain(`standby:${MAX}:`);
    expect(await j.refusedVerb("standby", "other.json", MAX + 1)).toContain(`at most ${MAX} seconds`);
  });

  it("a lapsed own claim behind a line may stand by, on the clock read when deciding", async () => {
    const j = await job();
    await j.ok(["claims", "take", "--keypair", "holder.json", ...j.ref, "--secs", "60", "--yes"]);
    await j.ok(["claims", "standby", "--keypair", "first.json", ...j.ref, "--secs", "600", "--yes"]);
    setNow(NOW + 59n);
    expect(await j.refusedVerb("standby", "holder.json", 60)).toContain("the holder cannot stand by for its own job");
    expect(await toolRefusal(j.tools.standby(j.holder, 60))).toMatchObject({ code: "HolderStandsBy" });
    laterThanTheView(await claimBoardAddress(j.intent), NOW + 60n);
    expect(await j.ok(["claims", "standby", "--keypair", "holder.json", ...j.ref, "--secs", "60"])).toMatchObject({ seq: 1, sent: false });
  });

  it("an advance names a held claim by the clock read when deciding", async () => {
    const j = await job();
    await j.ok(["claims", "take", "--keypair", "holder.json", ...j.ref, "--secs", "60", "--yes"]);
    await j.ok(["claims", "standby", "--keypair", "first.json", ...j.ref, "--secs", "600", "--yes"]);
    setNow(NOW + 10n);
    expect(await j.refusedVerb("advance", "other.json", 0)).toBe(heldBy(j.intent, j.holder.address, 50n));
    expect(await toolRefusal(j.tools.advance(j.other))).toMatchObject({ code: "ClaimHeld" });
    laterThanTheView(await claimBoardAddress(j.intent), NOW + 60n);
    expect(await j.ok(["claims", "advance", "--keypair", "other.json", ...j.ref])).toMatchObject({ sent: false });
  });
});

describe("an advance of a lapsed claim nobody waits behind", () => {
  it("names an empty line in the commands and in the tools", async () => {
    const j = await job();
    await j.ok(["claims", "take", "--keypair", "holder.json", ...j.ref, "--secs", "60", "--yes"]);
    setNow(NOW + 60n);
    expect(await j.refusedVerb("advance", "other.json", 0)).toBe(`nobody stands by for escrow ${j.intent}; nothing was sent`);
    expect(await toolRefusal(j.tools.advance(j.other))).toMatchObject({ code: "LineEmpty" });
  });
});

describe("the list gate comes after the escrow and the fills in the claims commands", () => {
  const pause = (j: Job, verb: string) => j.run([verb, "--keypair", "a.json", "--yes", "--flags", "fill"]);

  it("names a closed escrow before an unlisted wallet", async () => {
    const j = await job([(await generateKeyPairSigner()).address]);
    await j.client.cancel(j.w.owner, { owner: j.w.owner.address, nonce: 0n });
    for (const name of ["take", "standby"]) {
      const err = await j.refusedVerb(name, "stranger.json", 60);
      expect(err).toContain("is no longer open");
      expect(err).not.toBe(notListed(j.stranger.address, j.intent));
    }
  });

  it("names paused fills before an unlisted wallet, and the list before the terms", async () => {
    const j = await job([(await generateKeyPairSigner()).address]);
    expect((await pause(j, "raise-pause")).code).toBe(EXIT_OK);
    for (const name of ["take", "standby"]) {
      expect(await j.refusedVerb(name, "stranger.json", 60)).toContain("fills are paused");
    }
    expect((await pause(j, "lower-pause")).code).toBe(EXIT_OK);
    for (const name of ["take", "standby"]) {
      expect(await j.refusedVerb(name, "stranger.json", MAX + 1)).toBe(notListed(j.stranger.address, j.intent));
    }
  });
});

describe("previews and checks decide on the clock read when deciding", () => {
  const ends = (worker: Address) => expect.stringContaining(`Ends: the lapsed claim of ${worker}`);
  const lapsing = async (secs: string, line: boolean) => {
    const j = await job();
    await j.ok(["claims", "take", "--keypair", "holder.json", ...j.ref, "--secs", secs, "--yes"]);
    if (line) await j.ok(["claims", "standby", "--keypair", "first.json", ...j.ref, "--secs", "600", "--yes"]);
    return j;
  };

  it("claims take previews the lapsed stake when the claim lapses after the view", async () => {
    const j = await lapsing("60", false);
    laterThanTheView(await claimBoardAddress(j.intent), NOW + 60n);
    expect((await j.ok(["claims", "take", "--keypair", "other.json", ...j.ref, "--secs", "60"]))["summary"]).toEqual(expect.arrayContaining([ends(j.holder.address)]));
  });

  it("claims advance previews the lapsed stake when the claim lapses after the view", async () => {
    const j = await lapsing("60", true);
    laterThanTheView(await claimBoardAddress(j.intent), NOW + 60n);
    expect((await j.ok(["claims", "advance", "--keypair", "other.json", ...j.ref]))["summary"]).toEqual(expect.arrayContaining([ends(j.holder.address)]));
  });

  it("the take and advance tools preview the lapsed stake from a view older than the clock", async () => {
    const j = await lapsing("60", false);
    const stale = await j.view();
    setNow(NOW + 60n);
    expect((await takeStep(j.client, j.escrow, stale, j.other as never, 60)).summary).toEqual(expect.arrayContaining([ends(j.holder.address)]));
    const k = await lapsing("60", true);
    const old = await k.view();
    setNow(NOW + 60n);
    const step = await advanceStep(k.client, transport, k.escrow, old, k.other.address);
    expect(step.summary).toEqual(expect.arrayContaining([ends(k.holder.address)]));
    expect(step.key.startsWith("advance:lapsed:")).toBe(true);
  });

  it("a held claim is named with the seconds left on the clock read when deciding", async () => {
    const j = await lapsing("60", true);
    const stale = await j.view();
    setNow(NOW + 10n);
    expect(await toolRefusal(advanceStep(j.client, transport, j.escrow, stale, j.other.address))).toMatchObject({ code: "ClaimHeld", hint: expect.stringContaining("for 50 more seconds") });
    expect(await toolRefusal(settleStep(j.client, transport, j.escrow, stale, j.other.address))).toMatchObject({ code: "ClaimHeld", hint: expect.stringContaining("for 50 more seconds") });
    laterThanTheView(await claimBoardAddress(j.intent), NOW + 20n);
    expect(await j.refusedVerb("settle", "other.json", 0)).toContain("for 40 more seconds");
  });

  it("claims drop refuses a claim that lapsed after the view", async () => {
    const j = await lapsing("60", false);
    laterThanTheView(await claimBoardAddress(j.intent), NOW + 60n);
    const result = await j.run(["claims", "drop", "--keypair", "holder.json", ...j.ref]);
    expect([result.code, result.err]).toEqual([EXIT_FAILED, expect.stringContaining("holds no claim")]);
  });

  it("the drop tool refuses a claim that lapsed after its view", async () => {
    const j = await lapsing("60", false);
    const stale = await j.view();
    setNow(NOW + 60n);
    const ctx = { transport } as never;
    expect(await toolRefusal(dropStep(ctx, j.client, j.escrow, stale, j.holder as never))).toMatchObject({ code: "NotClaimant" });
  });

  it("claims list names a claim held by the clock read when deciding, not by the view", async () => {
    const j = await lapsing("60", false);
    const workers = ["--workers", j.other.address];
    laterThanTheView(await claimBoardAddress(j.intent), NOW + 60n);
    expect(await j.ok(["claims", "list", "--keypair", "owner.json", "--nonce", "0", ...workers])).toMatchObject({ sent: false });
  });
});
