import { INTENT_ENGINE_PROGRAM_ADDRESS, getFillAttestedSplitInstructionDataEncoder, FILL_ATTESTED_SPLIT_DISCRIMINATOR } from "@intent-engine/core/internal";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { beforeAll, describe, expect, it } from "vitest";
import { heldMint, outlives, releasedMint, releaseLookup, splitRecipients } from "../src/agent/wallet/releases.js";
import { created, type Escrow, escrow, filledAt, FLOOR, intentOf, newcomer, node, plain, released } from "./release-node.js";

let e: Escrow;

beforeAll(async () => {
  e = await escrow();
});

const summary = (found: Awaited<ReturnType<typeof releaseLookup>>) => ({
  release: found.release?.tx.signature ?? null,
  transactions: found.transactions.map((tx) => tx.signature),
  complete: found.complete,
  bound: found.bound,
});

describe("finding the release of an escrow in its history", () => {
  it("scans the escrow's history down to its creation and finds the release in it", async () => {
    const held = filledAt(e.view, FLOOR);
    const history = [plain("newer", { blockTime: FLOOR + 1n }), released(e.intent, { blockTime: FLOOR }), created(e.intent, "creation", { blockTime: FLOOR })];
    const { transport } = node(e.intent, history, { page: 1, held });
    expect(summary(await releaseLookup(transport, e.intent))).toEqual({ release: history[1]?.signature, transactions: ["newer", history[1]?.signature, "creation"], complete: true, bound: true });
  });

  it("stops at an entry older than the escrow and says it found no release, with a history that is bound", async () => {
    const held = filledAt(e.view, FLOOR);
    const history = [plain("newer", { blockTime: FLOOR + 1n }), plain("older", { blockTime: FLOOR - 1n }), released(e.intent, { blockTime: FLOOR }), created(e.intent, "creation", { blockTime: FLOOR })];
    const { transport } = node(e.intent, history, { page: 2, held });
    expect(summary(await releaseLookup(transport, e.intent))).toEqual({ release: null, transactions: ["newer"], complete: true, bound: true });
  });

  it("marks a release incomplete when a newer transaction could not be read", async () => {
    const held = filledAt(e.view, FLOOR);
    const history = [plain("unread", { blockTime: FLOOR + 1n, unread: true }), released(e.intent, { blockTime: FLOOR }), created(e.intent, "creation", { blockTime: FLOOR })];
    const { transport } = node(e.intent, history, { held });
    expect(summary(await releaseLookup(transport, e.intent))).toMatchObject({ release: history[1]?.signature, complete: false, bound: true });
  });
});

describe("whether a release outlives the escrow held now", () => {
  it("compares the creation it read against the escrow's creation time", () => {
    const held = intentOf(filledAt(e.view, FLOOR));
    const release = plain("release");
    expect([FLOOR - 1n, FLOOR, FLOOR + 1n].map((blockTime) => outlives(held, release, plain("creation", { blockTime })))).toEqual([true, false, false]);
  });
});

describe("the mint a release paid", () => {
  it("takes the payee's token account when no token account is held by the escrow", async () => {
    const [other, payee, first, second] = await Promise.all([newcomer(), newcomer(), newcomer(), newcomer()]);
    const tx = { ...plain("release"), tokens: [{ account: other, mint: first }, { account: payee, mint: second }] };
    expect([releasedMint(tx, e.intent, payee), releasedMint(tx, e.intent)]).toEqual([second, undefined]);
  });

  it("reads the mint only from an engine account of the escrow's size", async () => {
    const pair = intentOf(e.view);
    const at = (view: typeof e.view | null) => heldMint(node(e.intent, [], { held: view }).transport, e.intent);
    expect(await at(e.view)).toBe(pair.inputMint);
    expect(await at(null)).toBeUndefined();
    expect(await at({ ...e.view, owner: SYSTEM_PROGRAM_ADDRESS })).toBeUndefined();
    expect(await at({ ...e.view, owner: INTENT_ENGINE_PROGRAM_ADDRESS, data: e.view.data.slice(1) })).toBeUndefined();
  });
});

describe("the recipients of a split release", () => {
  it("reads the outer split call even when it is only its discriminator, and never takes another call for one", async () => {
    const [a, b] = await Promise.all([newcomer(), newcomer()]);
    const split = Uint8Array.from(getFillAttestedSplitInstructionDataEncoder().encode({ fill: { amountIn: 1n, result: 1n, maxFeeBps: 0 }, claim: { recipients: [a, b], weights: [1, 1] }, opening: { delivered: new Uint8Array(32), salt: new Uint8Array(16) }, ext: new Uint8Array() }));
    const bare = { ...plain("release"), called: [Uint8Array.from(FILL_ATTESTED_SPLIT_DISCRIMINATOR)], emitted: [split] };
    const other = { ...plain("release"), called: [new Uint8Array(split.length)], emitted: [split] };
    expect([splitRecipients(bare), splitRecipients(other)]).toEqual([null, [a, b]]);
  });
});
