import { type Address, generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, findAssociatedTokenAddress, IntentStatus, NATIVE_MINT, splitFees, swapExactIn, TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import { MAX_PARTNER_BPS } from "@intent-engine/core/internal";
import { createClient, InvalidInput, PayToNotWallet, type HistoryEvent, type HistoryPage, type Transport } from "../src/index.js";
import { BPS_NEEDS_PARTNER, PARTNER_BPS_RANGE, PARTNER_NEEDS_BPS, PAY_TO_NOT_ATTESTED, tokenAmount } from "../src/internal.js";
import { createTestWorld, type TestWorld } from "../src/testing.js";
import { delivered, escrow, proofParams, sha } from "./plan-driver.js";

const SELL = 100_000_000n;
const MIN_OUT = 1_000n;

async function filled(world: TestWorld, terms: { partner?: Address; partnerBps?: number; payTo?: Address }) {
  const output = await world.mint(6);
  const [owner, solver] = [await world.wallet(), await world.wallet()];
  await world.tokens(solver.address, output, MIN_OUT);
  const made = await world.client.createIntent({ signer: owner, inputMint: NATIVE_MINT, outputMint: output, params: swapExactIn({ amountIn: SELL, minOut: MIN_OUT }), ...terms });
  const stored = (await world.client.intent(made.intent))?.intent;
  await world.client.fill({ solver, intent: made.intent });
  return { owner, solver, output, made, stored };
}

describe("createIntent with a partner and a payee", () => {
  it("records the partner fee and pays the partner its share at the fill", async () => {
    const world = await createTestWorld();
    const partner = (await generateKeyPairSigner()).address;
    const { solver, stored, made } = await filled(world, { partner, partnerBps: 40 });
    expect(stored).toMatchObject({ partner, partnerBps: 40, partnerCutBps: world.fees.partnerCutBps });
    const shares = splitFees(SELL, stored?.feeBps ?? 0, 40, world.fees.partnerCutBps);
    expect(shares.partner).toBeGreaterThan(0n);
    expect(await world.tokenBalance(partner, NATIVE_MINT)).toBe(shares.partner);
    expect(await world.tokenBalance(solver.address, NATIVE_MINT)).toBe(shares.net);
    expect(await world.client.fillOf(made.intent)).toMatchObject({ net: shares.net, fee: shares.protocol });
  });

  it("pays what a swap buys to payTo instead of the owner", async () => {
    const world = await createTestWorld();
    const friend = (await generateKeyPairSigner()).address;
    const { owner, output, stored } = await filled(world, { payTo: friend });
    expect(stored?.receiver).toBe(await findAssociatedTokenAddress({ owner: friend, mint: output, tokenProgram: TOKEN_PROGRAM_ADDRESS }));
    expect(await world.tokenBalance(friend, output)).toBe(MIN_OUT);
    expect(await world.tokenBalance(owner.address, output)).toBe(0n);
  });

  it("refuses an incomplete or out-of-range partner fee, a payTo that is no wallet, and a payTo on a proof escrow, before sending", async () => {
    const world = await createTestWorld();
    const owner = await world.wallet();
    const partner = (await generateKeyPairSigner()).address;
    const order = { signer: owner, inputMint: NATIVE_MINT, outputMint: DEVNET_TEST_MINT, params: swapExactIn({ amountIn: SELL, minOut: 5n }) };
    const refused = (terms: object) => world.client.plan.createIntent({ ...order, ...terms }).catch((error: unknown) => error);
    expect(await refused({ partner })).toMatchObject({ field: "partnerBps", rule: "missing", message: PARTNER_NEEDS_BPS });
    expect(await refused({ partnerBps: 10 })).toMatchObject({ field: "partner", rule: "missing", message: BPS_NEEDS_PARTNER });
    for (const partnerBps of [0, MAX_PARTNER_BPS + 1, 1.5]) {
      expect(await refused({ partner, partnerBps })).toMatchObject({ field: "partnerBps", rule: "range", message: PARTNER_BPS_RANGE });
    }
    expect(await refused({ partner: "nope", partnerBps: 10 })).toMatchObject({ field: "partner", rule: "format" });
    const wrapped = await world.tokens(owner.address, NATIVE_MINT, 1n);
    expect(await refused({ payTo: wrapped })).toBeInstanceOf(PayToNotWallet);
    const judge = (await generateKeyPairSigner()).address;
    expect(await refused({ payTo: partner, params: proofParams(judge) })).toMatchObject({ field: "payTo", rule: "unsupported", message: PAY_TO_NOT_ATTESTED });
    const never = await refused({ partner, partnerBps: MAX_PARTNER_BPS, params: proofParams(judge, 1n) });
    expect(never).toBeInstanceOf(InvalidInput);
    expect(never).toMatchObject({ field: "partnerBps", rule: "range" });
    expect((never as Error).message).toContain("no release of this escrow could settle");
    expect(await world.client.intents({ owner: owner.address })).toEqual([]);
    expect((await world.client.plan.createIntent({ ...order, partner, partnerBps: MAX_PARTNER_BPS, payTo: owner.address })).payTo).toBe(owner.address);
  });
});

describe("amount and format", () => {
  it("turn decimal text into base units at the mint's decimals and back, refusing what the simple layer refuses", async () => {
    const world = await createTestWorld();
    const six = await world.mint(6);
    expect(await world.client.amount(NATIVE_MINT, "0.5")).toBe(500_000_000n);
    expect(await world.client.amount(six, " 1.25 ")).toBe(1_250_000n);
    expect(await world.client.amount(six, "0")).toBe(0n);
    expect(await world.client.format(six, 1_250_000n)).toBe("1.25");
    expect(await world.client.format(NATIVE_MINT, 500_000_000n)).toBe("0.5");
    for (const text of ["1.0000001", "-1", "abc", "", "1e3", "0x10"]) {
      const refused = await world.client.amount(six, text).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(InvalidInput);
      expect(refused).toMatchObject({ field: "amount", rule: "format" });
      expect(() => tokenAmount(text, 6)).toThrow((refused as Error).message);
    }
    for (const text of ["1", "0.000001", "12.5", "18446744073709.551615"]) {
      expect(await world.client.amount(six, text)).toBe(tokenAmount(text, 6));
    }
    await expect(world.client.format(six, -1n)).rejects.toMatchObject({ field: "amount", rule: "range" });
  });

  it("read each mint's decimals once", async () => {
    const world = await createTestWorld();
    const six = await world.mint(6);
    const reads: Address[] = [];
    const transport: Transport = {
      ...world.transport,
      getAccount: async (address) => {
        reads.push(address);
        return world.transport.getAccount(address);
      },
    };
    const client = createClient({ url: world.client.url, transport });
    await client.amount(six, "1");
    await client.format(six, 5n);
    await client.amount(six, "2.5");
    expect(reads.filter((address) => address === six)).toHaveLength(1);
  });
});

describe("an intent named by its address or by owner and nonce", () => {
  it("reads, lists claims and history, and cancels the same intent either way", async () => {
    const world = await createTestWorld();
    const job = await escrow(world);
    const ref = { owner: job.owner.address, nonce: job.nonce };
    expect(await world.client.intent(ref)).toEqual(await world.client.intent(job.intent));
    expect(await world.client.history(ref)).toEqual(await world.client.history(job.intent));
    expect(await world.client.claims(ref)).toEqual(await world.client.claims(job.intent));
    expect(await world.client.announcements(ref)).toEqual(await world.client.announcements(job.intent));
    expect(await world.client.plan.cancel(job.owner, ref)).toEqual(await world.client.plan.cancel(job.owner, job.intent));
    await world.client.cancel(job.owner, ref);
    expect((await world.client.intent(job.intent))?.intent.status).toBe(IntentStatus.Cancelled);
    await expect(world.client.intent("nope" as Address)).rejects.toMatchObject({ field: "intent", rule: "format" });
    await expect(world.client.intent({ owner: job.owner.address, nonce: -1n })).rejects.toMatchObject({ field: "intent", rule: "format" });
    expect(await world.client.intent({ owner: job.owner.address, nonce: 99n })).toBeNull();
  });
});

describe("history pages", () => {
  it("walks every page of a busy escrow with before and next, giving each event once and newest first", async () => {
    const world = await createTestWorld();
    const job = await escrow(world);
    for (let i = 0; i < 4; i++) {
      await delivered(world, job.intent, await world.wallet(), sha(`work ${i}`));
    }
    const whole = (await world.client.history(job.intent, { limit: 50 })).events;
    expect(whole.map(({ name }) => name).filter((name) => name === "DeliveryAnnounced")).toHaveLength(4);
    const pages: HistoryEvent[][] = [];
    let before: string | undefined;
    do {
      const page: HistoryPage = await world.client.history(job.intent, { limit: 2, ...(before === undefined ? {} : { before }) });
      pages.push(page.events);
      before = page.next ?? undefined;
    } while (before !== undefined);
    expect(pages.length).toBeGreaterThan(2);
    expect(pages.flat()).toEqual(whole);
    expect(new Set(pages.flat().map(({ signature, name }) => `${signature} ${name}`)).size).toBe(whole.length);
    const slots = pages.flat().map(({ slot }) => slot);
    expect(slots).toEqual([...slots].sort((a, b) => (a > b ? -1 : a < b ? 1 : 0)));
  });
});
