import { type Address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { ASSOCIATED_TOKEN_PROGRAM, type Fetch, JUPITER_PROGRAM, jupiterPricer, TOKEN_2022_PROGRAM } from "../../src/index.js";

const IN = "So11111111111111111111111111111111111111112" as Address;
const OUT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;
const TAKER = "11111111111111111111111111111112" as Address;
const SYSTEM = "11111111111111111111111111111111" as Address;
const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
const ROGUE = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" as Address;
const AMOUNT = 1_000n;

const serve = (replies: { status: number; body: unknown }[]): Fetch => async () => {
  const reply = replies.shift() ?? { status: 500, body: {} };
  return { ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body };
};

async function opener(tokenProgram: Address) {
  const encode = getAddressEncoder();
  const [account] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM,
    seeds: [encode.encode(TAKER), encode.encode(tokenProgram), encode.encode(OUT)],
  });
  return {
    programId: ASSOCIATED_TOKEN_PROGRAM,
    accounts: [TAKER, account, TAKER, OUT, SYSTEM, tokenProgram].map((pubkey, i) => ({ pubkey, isSigner: i === 0, isWritable: i < 2 })),
    data: "AQ==",
  };
}

describe("aggregator setup that opens an account under a program it names", () => {
  it("T-47: an aggregator's setup opens the solver's account for the output mint under its own program instead of a token program", async () => {
    const pricer = jupiterPricer({
      baseUrl: "https://" + "quote.example",
      fetch: serve([
        { status: 200, body: { inputMint: IN, outputMint: OUT, swapMode: "ExactIn", inAmount: AMOUNT.toString(), otherAmountThreshold: "985", outAmount: "990" } },
        {
          status: 200,
          body: {
            setupInstructions: [await opener(ROGUE)],
            swapInstruction: { programId: JUPITER_PROGRAM, accounts: [{ pubkey: TAKER, isSigner: true, isWritable: true }], data: "Ag==" },
            cleanupInstruction: null,
            addressLookupTableAddresses: [],
          },
        },
      ]),
      slippageBps: 30,
      maxAccounts: 40,
    });
    const signed = await pricer.quote({ inputMint: IN, outputMint: OUT, amountIn: AMOUNT, taker: TAKER }).catch(() => null);
    const setup = (signed?.instructions ?? []).filter((ix) => ix.programAddress === ASSOCIATED_TOKEN_PROGRAM);
    const owners = setup.map((ix) => ix.accounts?.[5]?.address);
    expect(owners.every((program) => program === TOKEN || program === TOKEN_2022_PROGRAM)).toBe(true);
  });
});
