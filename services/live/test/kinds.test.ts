import { getBase64Decoder } from "@solana/kit";
import { DEVNET_TEST_MINT, NATIVE_MINT } from "@intent-engine/core";
import { INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core/internal";
import { describe, expect, it } from "vitest";
import {
  addressOf,
  announced,
  attested,
  cancelled,
  claimed,
  committeeAttested,
  createCall,
  created,
  CUSTOM_HASH,
  expired,
  filled,
  FIZZBUZZ_HASH,
  held,
  JUDGE,
  OWNER,
  profileSet,
  released,
  signatureOf,
  SOLVER,
  split,
  type Tx,
  WORKER,
} from "./chain.js";
import { nowSecs, rig } from "./harness.js";

const JOB = addressOf(1);
const CANCELLED = addressOf(2);
const EXPIRED = addressOf(3);
const SWAP = addressOf(4);
const VOTED = addressOf(5);
const SPLIT = addressOf(6);
const MARKERS = ["MEMO-MARKER", "SPEC-MARKER", "DELIVERY-MARKER", "PROFILE-MARKER"];

const at = (n: number, events: Uint8Array[], extra: Partial<Tx> = {}): Tx => ({ signature: signatureOf(100 + n), slot: 1000 + n, blockTime: nowSecs(-3600 + n * 60), events, ...extra });

function story(): Tx[] {
  return [
    at(1, [created(JOB, OWNER, 100_000_000n)], {
      calls: [{ data: createCall(JUDGE, FIZZBUZZ_HASH, 100_000_000n), accounts: [OWNER, JOB] }],
      memo: "spec https://example.invalid/SPEC-MARKER MEMO-MARKER",
      logs: ["Program log: SPEC-MARKER"],
    }),
    at(2, [claimed(JOB, WORKER, 10_000_000n)]),
    at(3, [announced(JOB, WORKER, JUDGE)], { memo: "DELIVERY-MARKER https://example.invalid/work" }),
    at(4, [created(CANCELLED, OWNER, 2_500_000n, DEVNET_TEST_MINT)], { calls: [{ data: createCall(JUDGE, CUSTOM_HASH, 2_500_000n), accounts: [OWNER, CANCELLED] }] }),
    at(5, [cancelled(CANCELLED, OWNER, 2_500_000n)]),
    at(6, [expired(EXPIRED, OWNER, 3_000_000n)], { mints: [DEVNET_TEST_MINT] }),
    at(7, [filled(SWAP, OWNER, SOLVER, 5_000_000_000n)], { mints: [NATIVE_MINT] }),
    at(8, [attested(VOTED, OWNER, WORKER, JUDGE, 1_000_000n), committeeAttested(VOTED, [JUDGE, SOLVER])], { mints: [NATIVE_MINT] }),
    at(9, [split(SPLIT, OWNER, WORKER, JUDGE, 4_000_000n), held(SPLIT, SOLVER, 1n), released(SPLIT, WORKER, JUDGE)], { mints: [NATIVE_MINT] }),
    at(10, [profileSet(WORKER, "PROFILE-MARKER")]),
    at(11, [released(JOB, WORKER, JUDGE), attested(JOB, OWNER, WORKER, JUDGE, 95_000_000n)]),
  ];
}

const BASE_KEYS = ["amount", "at", "detail", "house", "intent", "kind", "signature", "slot", "spec_hash", "spec_name", "token", "who"].sort();
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]+$/;

describe("event kinds", () => {
  it("reads every kind from inner instructions and shapes it as the contract says", async () => {
    const { node, feed } = rig();
    node.add(...story());
    const body = await feed.read();
    expect(body.events.map(({ kind }) => kind)).toEqual(["release", "release", "release", "swap", "refund", "refund", "escrow", "delivery", "claim", "escrow"]);
    for (const event of body.events) {
      const keys = Object.keys(event).sort();
      expect(keys).toEqual(event.kind === "release" ? [...BASE_KEYS, "attestor", "payee"].sort() : BASE_KEYS);
      expect(new Date(event.at).toISOString()).toBe(event.at);
      expect(Number.isInteger(event.slot)).toBe(true);
      expect(event.signature).toMatch(BASE58);
      expect(event.intent).toMatch(BASE58);
      expect(event.who).toMatch(BASE58);
      expect(event.spec_hash === null || event.kind === "escrow").toBe(true);
    }
    const slots = body.events.map(({ slot }) => slot);
    expect(slots).toEqual([...slots].sort((a, b) => b - a));
    const [paid, divided, voted, swap, gone, back, custom, delivery, claim, escrow] = body.events;
    expect(escrow).toMatchObject({ who: OWNER, amount: "0.1", token: "SOL", spec_hash: FIZZBUZZ_HASH, spec_name: "fizzbuzz", house: false });
    expect(claim).toMatchObject({ who: WORKER, amount: "0.01", token: "SOL", spec_hash: null, spec_name: null });
    expect(delivery).toMatchObject({ who: WORKER, amount: null, token: null });
    expect(custom).toMatchObject({ amount: "2.5", token: "TEST", spec_hash: CUSTOM_HASH, spec_name: null });
    expect(back).toMatchObject({ kind: "refund", who: OWNER, amount: "2.5", token: "TEST" });
    expect(gone).toMatchObject({ kind: "refund", who: OWNER, amount: "3", token: "TEST" });
    expect(swap).toMatchObject({ who: SOLVER, amount: "5", token: "SOL" });
    expect(voted).toMatchObject({ who: addressOf(15), attestor: addressOf(15), payee: WORKER, amount: "0.001", token: "SOL" });
    expect(divided).toMatchObject({ who: JUDGE, attestor: JUDGE, payee: WORKER, amount: "0.004", token: "SOL" });
    expect(paid).toMatchObject({ who: JUDGE, attestor: JUDGE, payee: WORKER, amount: "0.095", token: "SOL" });
    expect(body.latest_paid_job).toEqual({
      intent: JOB,
      spec_hash: FIZZBUZZ_HASH,
      spec_name: "fizzbuzz",
      escrow: { signature: signatureOf(101), at: escrow?.at, who: OWNER, amount: "0.1", token: "SOL" },
      delivery: { signature: signatureOf(103), at: delivery?.at, who: WORKER, amount: null, token: null },
      release: { signature: signatureOf(111), at: paid?.at, who: JUDGE, amount: "0.095", token: "SOL" },
    });
    expect(body.last_event_at).toBe(paid?.at);
    expect(body.program).toBe(INTENT_ENGINE_PROGRAM_ADDRESS);
    expect(body.cluster).toBe("devnet");
  });

  it("writes every detail itself and never copies spec, memo, delivery or profile text", async () => {
    const { node, feed } = rig();
    node.add(...story());
    const body = await feed.read();
    const text = JSON.stringify(body);
    for (const marker of MARKERS) {
      expect(text).not.toContain(marker);
    }
    expect(text).not.toContain("example.invalid");
    for (const { detail } of body.events) {
      expect(detail).toMatch(/^[A-Za-z0-9 .…]+$/);
    }
    expect(body.events.at(-1)?.detail).toBe(`${OWNER.slice(0, 4)}…${OWNER.slice(-4)} locked 0.1 SOL in escrow for the fizzbuzz demo job.`);
    expect(body.events[0]?.detail).toBe(`Judge ${JUDGE.slice(0, 4)}…${JUDGE.slice(-4)} approved the work and paid ${WORKER.slice(0, 4)}…${WORKER.slice(-4)} 0.095 SOL.`);
  });

  it("decodes events from inner instructions only, never from program logs", async () => {
    const { node, feed } = rig();
    const event = created(addressOf(9), OWNER, 1n);
    node.add(at(1, [], { logs: [`Program data: ${getBase64Decoder().decode(event)}`, `Program data: ${getBase64Decoder().decode(event.subarray(8))}`] }));
    const quiet = await feed.read();
    expect(node.count("getTransaction")).toBe(1);
    expect(quiet.events).toEqual([]);
    expect(quiet.last_event_at).toBeNull();
  });

  it("skips failed transactions without reading them", async () => {
    const { node, feed } = rig();
    node.addFailed(signatureOf(250), 900, nowSecs(-60));
    node.add(at(1, [claimed(JOB, WORKER, 0n)]));
    const body = await feed.read();
    expect(node.count("getTransaction")).toBe(1);
    expect(body.events.map(({ kind, detail }) => [kind, detail])).toEqual([["claim", `${WORKER.slice(0, 4)}…${WORKER.slice(-4)} claimed the job.`]]);
  });
});
