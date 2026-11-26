import { createHash } from "node:crypto";
import type { Address, KeyPairSigner } from "@solana/kit";
import { generateKeyPairSigner } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import { Kind } from "@intent-engine/core";
import { MaybeSent } from "@intent-engine/client";
import { ANNOUNCED_UNSEEN, boundMembers } from "@intent-engine/client/internal";
import { createClient } from "@intent-engine/client/node";
import { DEFAULT_URL } from "../src/clusters.js";
import { deliveredLine } from "../src/announce-commands.js";
import { deliveryBookPath, ownDeliveries } from "../src/delivery-record.js";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "../src/main.js";
import { SERVER_PROBLEMS, unfundedSend } from "../src/agent/problems.js";
import { unfundedRefused } from "../src/wallet.js";
import { keyed } from "./announce.js";
import { cli, h, HOME, NOW, transport, world, type World } from "./harness.js";

type Job = { w: World; judge: KeyPairSigner; worker: KeyPairSigner; intent: Address; sha256: string };

async function job(): Promise<Job> {
  const w = await world();
  const judge = await generateKeyPairSigner();
  const worker = await keyed("w.json");
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: new Uint8Array(32).fill(7), judgeFee: 0n } as const;
  const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 5n, expiresAt: NOW + 3_600n });
  return { w, judge, worker, intent, sha256: createHash("sha256").update("work\n").digest("hex") };
}

const delivering = (j: Job, ...more: string[]) => ["deliver", "--keypair", "w.json", "--intent", j.intent, "--sha256", j.sha256, "--work-url", "https://example.org/w", ...more];

const oneLine = (text: string) => text.length > 0 && !text.includes("\n");

describe("deliver tells the truth", () => {
  let j: Job;

  beforeEach(async () => {
    j = await job();
  });

  it("exits 0 with a stable delivered line only once the announcement is on chain, and keeps a record a judge on this machine reads", async () => {
    const sent = await cli(delivering(j, "--yes"), {});
    expect([sent.code, sent.err]).toEqual([EXIT_OK, ""]);
    const out = sent.json();
    expect(out).toMatchObject({ sent: true, seq: "1", sha256: j.sha256 });
    expect(out["delivered"]).toBe(deliveredLine(1n, j.sha256, out["signature"] as string, out["announcement"] as Address));
    expect(out["delivered"]).toMatch(/^seq=1 sha256=[0-9a-f]{64} signature=[1-9A-HJ-NP-Za-km-z]{64,90} announcement=[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    const runtime = { home: HOME, readText: async (path: string) => h.files.get(path) ?? Promise.reject(new Error("none")) };
    expect(await ownDeliveries(runtime, j.intent)).toEqual([
      { intent: j.intent, sha256: j.sha256, announcement: out["announcement"], seq: "1", signature: out["signature"], slot: expect.stringMatching(/^[1-9][0-9]*$/), worker: j.worker.address },
    ]);
    const again = await cli(delivering(j, "--yes"), {});
    expect([again.code, again.err]).toEqual([EXIT_OK, ""]);
    expect(again.json()).toMatchObject({ sent: false, seq: "1", delivered: expect.stringMatching(new RegExp(`^seq=1 sha256=${j.sha256} signature=\\S+ announcement=${String(out["announcement"])}$`)) });
    expect(JSON.parse(h.files.get(deliveryBookPath(HOME, j.intent)) ?? "[]")).toHaveLength(1);
  });

  it("previews without a delivered line and sends nothing without --yes", async () => {
    const sent = h.wires.length;
    const preview = await cli(delivering(j), {});
    expect(preview.code).toBe(EXIT_OK);
    expect(preview.json()).toMatchObject({ sent: false });
    expect(preview.json()["delivered"]).toBeUndefined();
    expect(h.wires).toHaveLength(sent);
    expect(h.files.has(deliveryBookPath(HOME, j.intent))).toBe(false);
  });

  it("exits non-zero with one plain line when the confirmed send's announcement cannot be read back", async () => {
    const plan = await createClient({ url: "http://cluster", transport }).plan.announce({ worker: j.worker, intent: j.intent, sha256: j.sha256, url: "https://example.org/w" });
    const inner = boundMembers(transport);
    h.through = { ...inner, getAccount: async (address) => (address === plan.announcement ? null : inner.getAccount(address)), getAccounts: async (addresses) => Promise.all(addresses.map((a) => (a === plan.announcement ? null : inner.getAccount(a)))) };
    const unseen = await cli(delivering(j, "--yes"), {});
    expect(unseen.code).toBe(EXIT_FAILED);
    expect(unseen.out).toBe("");
    expect(oneLine(unseen.err)).toBe(true);
    expect(unseen.err).toContain(ANNOUNCED_UNSEEN);
    expect(h.files.has(deliveryBookPath(HOME, j.intent))).toBe(false);
  });

  it("refuses an unfunded payer before sending, in one plain line", async () => {
    const empty = await generateKeyPairSigner();
    const sent = h.wires.length;
    const refused = await cli(["deliver", "--keypair", "e.json", "--intent", j.intent, "--sha256", j.sha256, "--work-url", "https://example.org/w", "--yes"], { "e.json": empty });
    expect([refused.code, refused.out, refused.err]).toEqual([EXIT_FAILED, "", unfundedRefused(empty.address, DEFAULT_URL)]);
    expect(h.wires).toHaveLength(sent);
  });

  it("names the cause of a refused simulation and of a send that may have landed, each in one plain line", async () => {
    const inner = boundMembers(transport);
    const cause = Object.assign(new Error("This account may not be used to pay transaction fees"), { context: { __code: 7_050_006 } });
    const preflight = Object.assign(new Error("Transaction simulation failed"), { context: { __code: -32_002 }, cause });
    h.through = { ...inner, send: async () => Promise.reject(preflight) };
    const failed = await cli(delivering(j, "--yes"), {});
    expect([failed.code, failed.out, failed.err]).toEqual([EXIT_FAILED, "", SERVER_PROBLEMS.Unfunded.hint]);
    const other = Object.assign(new Error("Transaction simulation failed"), { context: { __code: -32_002 }, cause: new Error("custom program error: 0x1771") });
    h.through = { ...inner, send: async () => Promise.reject(other) };
    const named = await cli(delivering(j, "--yes"), {});
    expect([named.code, named.out, named.err]).toEqual([EXIT_FAILED, "", "Transaction simulation failed: custom program error: 0x1771"]);
    h.through = { ...inner, send: async () => Promise.reject(new MaybeSent("1".repeat(64) as never, 10n, "transaction may have reached the node")) };
    const maybe = await cli(delivering(j, "--yes"), {});
    expect(maybe.code).toBe(EXIT_FAILED);
    expect(oneLine(maybe.err)).toBe(true);
    expect(maybe.err).toContain("transaction may have reached the node");
    expect(h.files.has(deliveryBookPath(HOME, j.intent))).toBe(false);
  });

  it("refuses usage and escrow problems with one plain line and nothing on stdout", async () => {
    const usage = await cli(["deliver", "--keypair", "w.json", "--intent", j.intent, "--sha256", "xyz", "--work-url", "https://example.org/w", "--yes"], {});
    expect([usage.code, usage.out, oneLine(usage.err)]).toEqual([EXIT_USAGE, "", true]);
    const notEscrow = await cli(["deliver", "--keypair", "w.json", "--intent", j.w.owner.address, "--sha256", j.sha256, "--work-url", "https://example.org/w", "--yes"], {});
    expect([notEscrow.code, notEscrow.out, oneLine(notEscrow.err)]).toEqual([EXIT_FAILED, "", true]);
  });

  it("counts a payer the node calls invalid for fees as unfunded", () => {
    expect(unfundedSend({ context: { __code: -32_002 }, cause: { context: { __code: 7_050_006 } } })).toBe(true);
    expect(unfundedSend({ context: { __code: 7_050_003 } })).toBe(true);
    expect(unfundedSend({ context: { __code: 7_050_005 } })).toBe(false);
  });
});
