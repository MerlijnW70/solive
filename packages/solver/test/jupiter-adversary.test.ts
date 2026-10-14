import type { Address } from "@solana/kit";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Fetch, JUPITER_PROGRAM, jupiterPricer, RateLimited, SETUP_PROGRAMS } from "../src/index.js";

const IN = "So11111111111111111111111111111111111111112" as Address;
const OUT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;
const TAKER = "11111111111111111111111111111112" as Address;
const ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" as Address;
const SYSTEM = "11111111111111111111111111111111" as Address;
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
const STRANGER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" as Address;
const RUNS = Number(process.env["ADVERSARY_RUNS"] ?? 200);
const AMOUNT = 1_000n;

const key = fc.constantFrom(TAKER, STRANGER, ATA, SYSTEM, TOKEN, JUPITER_PROGRAM, IN, OUT);
const meta = fc.record({ pubkey: fc.oneof(key, fc.jsonValue()), isSigner: fc.oneof(fc.boolean(), fc.jsonValue()), isWritable: fc.oneof(fc.boolean(), fc.jsonValue()) });
const data = fc.oneof(fc.constantFrom("", "AA==", "AQ==", "Ag==", "Aw==", "AQA="), fc.base64String({ maxLength: 12 }), fc.jsonValue());
const instruction = fc.record(
  { programId: fc.oneof(key, fc.jsonValue()), accounts: fc.oneof(fc.array(meta, { maxLength: 7 }), fc.jsonValue()), data },
  { requiredKeys: [] },
);
const digits = fc.bigInt({ min: 0n, max: 2n ** 70n }).map(String);
const amountText = fc.oneof(digits, fc.constantFrom(AMOUNT.toString(), "-1", "1e9", " 5", "0x10", "1.5", ""), fc.jsonValue());
const quote = fc.record(
  {
    inputMint: fc.oneof(fc.constant(IN), key, fc.jsonValue()),
    outputMint: fc.oneof(fc.constant(OUT), key, fc.jsonValue()),
    swapMode: fc.oneof(fc.constant("ExactIn"), fc.constantFrom("ExactOut", "exactin", ""), fc.jsonValue()),
    inAmount: fc.oneof(fc.constant(AMOUNT.toString()), amountText),
    otherAmountThreshold: amountText,
    outAmount: amountText,
  },
  { requiredKeys: [] },
);
const built = fc.record(
  {
    setupInstructions: fc.oneof(fc.array(instruction, { maxLength: 3 }), instruction, fc.constant(null), fc.jsonValue()),
    swapInstruction: fc.oneof(instruction, fc.jsonValue()),
    cleanupInstruction: fc.oneof(instruction, fc.constant(null), fc.jsonValue()),
    addressLookupTableAddresses: fc.oneof(fc.array(fc.oneof(key, fc.jsonValue()), { maxLength: 3 }), fc.jsonValue()),
  },
  { requiredKeys: [] },
);
const status = fc.oneof(fc.constant(200), fc.constantFrom(201, 204, 400, 404, 429, 500, 502), fc.integer({ min: 100, max: 599 }));

const serve = (replies: { status: number; body: unknown }[]): Fetch => async () => {
  const reply = replies.shift() ?? { status: 500, body: {} };
  return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body };
};

describe("jupiter pricer against a hostile or broken aggregator", () => {
  it("only ever returns a quote for the requested amount that signs nothing but the swap and the solver's own token accounts", async () => {
    await fc.assert(
      fc.asyncProperty(status, fc.oneof(quote, fc.jsonValue()), status, fc.oneof(built, fc.jsonValue()), async (s1, q, s2, b) => {
        const pricer = jupiterPricer({
          baseUrl: "https://quote.example",
          fetch: serve([
            { status: s1, body: q },
            { status: s2, body: b },
          ]),
          slippageBps: 30,
          maxAccounts: 40,
        });
        let result: Awaited<ReturnType<typeof pricer.quote>>;
        try {
          result = await pricer.quote({ inputMint: IN, outputMint: OUT, amountIn: AMOUNT, taker: TAKER });
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
          if (error instanceof RateLimited) {
            expect([s1, s2]).toContain(429);
          }
          return;
        }
        if (result === null) {
          expect([400, 404]).toContain(s1);
          return;
        }
        expect(s1 >= 200 && s1 < 300 && s2 >= 200 && s2 < 300).toBe(true);
        expect(result.amountIn).toBe(AMOUNT);
        expect((q as { inAmount?: unknown }).inAmount).toBe(AMOUNT.toString());
        expect([(q as { inputMint?: unknown }).inputMint, (q as { outputMint?: unknown }).outputMint]).toEqual([IN, OUT]);
        expect((q as { swapMode?: unknown }).swapMode).toBe("ExactIn");
        expect(result.amountOut.toString()).toBe((q as { otherAmountThreshold?: unknown }).otherAmountThreshold);
        const swaps = result.instructions.filter((ix) => ix.programAddress === JUPITER_PROGRAM);
        expect(swaps).toHaveLength(1);
        for (const ix of result.instructions) {
          if (ix.programAddress === JUPITER_PROGRAM) {
            continue;
          }
          expect(SETUP_PROGRAMS.has(ix.programAddress)).toBe(true);
          expect([ix.accounts?.[0]?.address, ix.accounts?.[2]?.address]).toEqual([TAKER, TAKER]);
          expect([IN, OUT]).toContain(ix.accounts?.[3]?.address);
          expect((ix.data?.length ?? 0) <= 1 && (ix.data?.[0] ?? 0) <= 1).toBe(true);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("opens token accounts only for the solver, paid by the solver, whatever setup a near-valid reply carries", async () => {
    const opener = fc.record({
      payer: key,
      wallet: key,
      mint: fc.constantFrom(IN, OUT, STRANGER),
      program: fc.constantFrom(ATA, ATA, SYSTEM, TOKEN),
      data: fc.constantFrom("", "AA==", "AQ==", "Ag==", "Aw==", "AQA="),
    });
    type Opener = { payer: Address; wallet: Address; mint: Address; program: Address; data: string };
    const asIx = (o: Opener) => ({
      programId: o.program,
      accounts: [o.payer, STRANGER, o.wallet, o.mint, SYSTEM, TOKEN].map((pubkey, i) => ({ pubkey, isSigner: i === 0, isWritable: i < 2 })),
      data: o.data,
    });
    const swap = { programId: JUPITER_PROGRAM, accounts: [{ pubkey: TAKER, isSigner: true, isWritable: true }], data: "Ag==" };
    await fc.assert(
      fc.asyncProperty(fc.array(opener, { maxLength: 3 }), fc.option(opener, { nil: null }), async (setup, cleanup) => {
        const pricer = jupiterPricer({
          baseUrl: "https://quote.example",
          fetch: serve([
            { status: 200, body: { inputMint: IN, outputMint: OUT, swapMode: "ExactIn", inAmount: AMOUNT.toString(), otherAmountThreshold: "985", outAmount: "990" } },
            {
              status: 200,
              body: {
                setupInstructions: setup.map(asIx),
                swapInstruction: swap,
                cleanupInstruction: cleanup === null ? null : asIx(cleanup),
                addressLookupTableAddresses: [],
              },
            },
          ]),
          slippageBps: 30,
          maxAccounts: 40,
        });
        const fair = (o: Opener) =>
          o.program === ATA && o.payer === TAKER && o.wallet === TAKER && (o.mint === IN || o.mint === OUT) && ["", "AA==", "AQ=="].includes(o.data);
        const all = [...setup, ...(cleanup === null ? [] : [cleanup])];
        const distinct = new Set(setup.map((o) => o.mint)).size === setup.length;
        const outcome = pricer.quote({ inputMint: IN, outputMint: OUT, amountIn: AMOUNT, taker: TAKER });
        if (all.every(fair) && distinct) {
          expect((await outcome)?.instructions).toHaveLength(all.length + 1);
        } else {
          await expect(outcome).rejects.toThrow(/^jupiter (setup|cleanup) /);
        }
      }),
      { numRuns: RUNS },
    );
  });
});
