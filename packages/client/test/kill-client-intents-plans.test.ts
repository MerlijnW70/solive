import { type Address, generateKeyPairSigner, getAddressDecoder } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { IntentStatus, InvalidInput, Kind, NATIVE_MINT, swapExactIn, TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import { encodeParams, getIntentDecoder, getIntentDiscriminatorBytes, getIntentEncoder, getIntentSize, INTENT_ENGINE_PROGRAM_ADDRESS, INTENT_VERSION } from "@intent-engine/core/internal";
import { intentPlans } from "../src/client-intents.js";
import { clientReads } from "../src/client-reads.js";
import { type ClientContext, HISTORY_LIMIT_MAX, MAX_EXPIRES_IN } from "../src/client-types.js";
import { TransportLacks } from "../src/client-errors.js";
import { loadIntentRef, neverSettles, partnerOf } from "../src/internal.js";
import type { Transport } from "../src/transport.js";
import { createTestWorld } from "../src/testing.js";

const key = (byte: number) => getAddressDecoder().decode(new Uint8Array(32).fill(byte));

describe("an escrow no release could settle", () => {
  const config = { feeBps: 5, kindFeeMask: 0, kindFeeBps: [], partnerCutBps: 0 };
  const attested = (amountIn: bigint, judgeFee: bigint) => ({
    kind: Kind.AttestedResult as const,
    amountIn,
    minResult: 1n,
    maxResult: 1n,
    attestor: key(7),
    specHash: new Uint8Array(32).fill(1),
    judgeFee,
  });

  it("names what the judge fee leaves, floored at zero, and the fixes that would settle", () => {
    const three = neverSettles(attested(3n, 2n), config, 5, 0) ?? "";
    expect(three).toContain("3 less the 2 judge fee leaves 1, too little for the rounded-up 5 bps protocol fee and 5 bps partner fee; escrow at least ");
    expect(three).toContain(", or lower the judge fee to at most ");
    expect(neverSettles(attested(2n, 2n), config, 5, 0)).toContain("2 less the 2 judge fee leaves 0, too little");
    expect(neverSettles(attested(1n, 2n), config, 5, 0)).toContain("1 less the 2 judge fee leaves 0, too little");
    expect(neverSettles(attested(100_000n, 2n), config, 5, 0)).toBeUndefined();
  });

  it("offers no lower-judge-fee fix when the judge fee is zero, and says so when nothing settles", () => {
    const none = neverSettles(attested(1n, 0n), config, 5, 0) ?? "";
    expect(none).toContain("1 less the 0 judge fee leaves 1, too little");
    expect(none).not.toContain("lower the judge fee");
    expect(none).toContain("escrow at least ");
    const hopeless = neverSettles(attested(1_000n, 0n), { ...config, feeBps: 6_000 }, 5_000, 0) ?? "";
    expect(hopeless.endsWith("; no amount settles under today's config")).toBe(true);
    expect(hopeless).not.toContain("escrow at least");
  });
});

describe("the partner fee range", () => {
  it("takes one basis point, refuses zero, and refuses a fraction", () => {
    const partner = key(8);
    expect(partnerOf({ partner, partnerBps: 1 })).toStrictEqual({ key: partner, bps: 1 });
    expect(() => partnerOf({ partner, partnerBps: 0 })).toThrow(InvalidInput);
    expect(() => partnerOf({ partner, partnerBps: 0.5 })).toThrow(InvalidInput);
  });
});

describe("an intent reference", () => {
  const owner = key(9);
  const refused = async (ref: unknown) => {
    const transport = {} as Transport;
    const error = await loadIntentRef(transport, ref as never).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(InvalidInput);
    expect(error).toMatchObject({ field: "intent", rule: "format" });
  };

  it("refuses null, a function, a bad owner, a number nonce and a negative nonce, each as an invalid input", async () => {
    await refused(null);
    const callable = Object.assign(() => undefined, { owner, nonce: 1n });
    await refused(callable);
    await refused({ owner: "nope", nonce: 1n });
    await refused({ owner, nonce: 5 });
    await refused({ owner, nonce: -1n });
    await refused(undefined);
    await refused(42);
  });
});

describe("history limits and transports", () => {
  const history = (transport: object, options: object) =>
    clientReads({ transport: transport as Transport, mint: async () => ({ decimals: 6, tokenProgram: TOKEN_PROGRAM_ADDRESS }) } as unknown as ClientContext).history(key(3), options);

  it("accepts the largest limit and refuses one more", async () => {
    const transport = { engineTransactions: async () => [] };
    expect(await history(transport, { limit: HISTORY_LIMIT_MAX })).toStrictEqual({ events: [], next: null });
    await expect(history(transport, { limit: HISTORY_LIMIT_MAX + 1 })).rejects.toMatchObject({ field: "limit", rule: "range" });
  });

  it("names the missing method when a cursor needs it", async () => {
    const lacksFirst = { engineTransactions: async () => [], transactionsOf: async () => [] };
    const lacksSecond = { engineTransactions: async () => [], signaturesOf: async () => [] };
    const lacksBoth = { engineTransactions: async () => [] };
    for (const [transport, method] of [
      [lacksFirst, "signaturesOf"],
      [lacksSecond, "transactionsOf"],
      [lacksBoth, "signaturesOf"],
    ] as const) {
      const error = await history(transport, { before: "somewhere" }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(TransportLacks);
      expect((error as TransportLacks).method).toBe(method);
    }
  });
});

describe("a plan to create an escrow", () => {
  it("takes one basis point of partner fee and the longest expiry, and refuses past it", async () => {
    const world = await createTestWorld();
    const owner = await world.wallet();
    const partner = (await generateKeyPairSigner()).address;
    const order = { signer: owner, inputMint: NATIVE_MINT, outputMint: await world.mint(6), params: swapExactIn({ amountIn: 100_000_000n, minOut: 5n }) };
    const plan = await world.client.plan.createIntent({ ...order, partner, partnerBps: 1, expiresIn: MAX_EXPIRES_IN });
    expect(plan.expiresAt).toBe(world.now() + MAX_EXPIRES_IN);
    await expect(world.client.plan.createIntent({ ...order, expiresIn: MAX_EXPIRES_IN + 1n })).rejects.toMatchObject({ field: "expiresIn", rule: "range" });
  });

  it("says whether it registers the owner and whether it creates the payee's token account", async () => {
    const world = await createTestWorld();
    const owner = await world.wallet();
    const output = await world.mint(6);
    await world.tokens(owner.address, output, 0n);
    const order = { signer: owner, inputMint: NATIVE_MINT, outputMint: output, params: swapExactIn({ amountIn: 100_000_000n, minOut: 5n }) };
    const first = await world.client.plan.createIntent(order);
    expect(first.registers).toBe(true);
    expect(first.createsPayTo).toBe(false);
    await world.client.createIntent(order);
    const second = await world.client.plan.createIntent(order);
    expect(second.registers).toBe(false);
    expect(second.createsPayTo).toBe(false);
    const stranger = await world.wallet();
    const third = await world.client.plan.createIntent({ ...order, signer: stranger });
    expect(third.registers).toBe(true);
    expect(third.createsPayTo).toBe(true);
  });
});

describe("a plan to fill an escrow", () => {
  const SOLVER_MINT_IN = key(20);
  const SOLVER_MINT_OUT = key(21);
  const OWNER = key(30);
  const TREASURY = key(31);
  const PARTNER = key(32);
  const AGENT = key(33);
  const INTENT = key(34);

  const blank = new Uint8Array(getIntentSize());
  blank.set(getIntentDiscriminatorBytes());
  const BASE = { ...getIntentDecoder().decode(blank), owner: OWNER, version: INTENT_VERSION, status: IntentStatus.Open, kind: Kind.SwapExactIn, nonce: 1n };
  const params = encodeParams({ kind: Kind.SwapExactIn, amountIn: 1_000_000n, minOut: 1n });

  const ownersOf = async (held: Partial<typeof BASE>) => {
    const data = Uint8Array.from(getIntentEncoder().encode({ ...BASE, inputMint: SOLVER_MINT_IN, outputMint: SOLVER_MINT_OUT, params, ...held }));
    const transport = {
      getAccount: async (address: Address) => (address === INTENT ? { owner: INTENT_ENGINE_PROGRAM_ADDRESS, data, lamports: 1n } : null),
    } as unknown as Transport;
    const context = {
      transport,
      mint: async () => ({ decimals: 6, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
      config: async () => ({ feeRecipient: TREASURY }),
    } as unknown as ClientContext;
    const solver = await generateKeyPairSigner();
    const plan = await intentPlans(context).fill({ solver, intent: INTENT, amountIn: 1_000_000n, amountOut: 1n, route: [] });
    return { solver: solver.address, creates: plan.instructions.slice(0, -1).map((instruction) => instruction.accounts?.[2]?.address) };
  };

  it("pays no treasury, partner or agent that is owed nothing", async () => {
    const { solver, creates } = await ownersOf({ feeBps: 0, partnerBps: 0, partnerCutBps: 0, partner: PARTNER, agentFee: 0n, rentPayer: AGENT });
    expect(creates).toStrictEqual([solver, solver]);
  });

  it("creates a token account for the treasury, the partner and the agent, in that order, when each is owed", async () => {
    const { solver, creates } = await ownersOf({ feeBps: 50, partnerBps: 100, partnerCutBps: 2_000, partner: PARTNER, agentFee: 3n, rentPayer: AGENT });
    expect(creates).toStrictEqual([solver, solver, TREASURY, PARTNER, AGENT]);
  });

  it("pays the agent alone when only its fee is owed", async () => {
    const { solver, creates } = await ownersOf({ feeBps: 0, partnerBps: 0, partnerCutBps: 0, partner: PARTNER, agentFee: 1n, rentPayer: AGENT });
    expect(creates).toStrictEqual([solver, solver, AGENT]);
  });
});
