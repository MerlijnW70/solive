import { AccountRole, type Address } from "@solana/kit";
import { getMintToInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { findAssociatedTokenAddress } from "@intent-engine/core";
import { issueInstruction, issuePricer } from "../src/index.js";

const TAKER = "11111111111111111111111111111112" as Address;
const INPUT = "So11111111111111111111111111111111111111112" as Address;
const OUTPUT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;
const OTHER = "SysvarC1ock11111111111111111111111111111111" as Address;
const route = { inputMint: INPUT, outputMint: OUTPUT, outputTokenProgram: TOKEN_PROGRAM_ADDRESS, out: 200n, in: 3n };

describe("the issue pricer", () => {
  it("mints the output at the configured rate into the taker's own account, signed by the taker", async () => {
    const quote = await issuePricer([route]).quote({ inputMint: INPUT, outputMint: OUTPUT, amountIn: 10n, taker: TAKER });
    const token = await findAssociatedTokenAddress({ owner: TAKER, mint: OUTPUT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(quote).toEqual({
      amountIn: 10n,
      amountOut: 666n,
      instructions: [issueInstruction(OUTPUT, token, TAKER, TOKEN_PROGRAM_ADDRESS, 666n)],
      lookupTables: [],
    });
    const reference = getMintToInstruction({ mint: OUTPUT, token, mintAuthority: TAKER, amount: 666n });
    const [ix] = quote?.instructions ?? [];
    expect(ix?.programAddress).toBe(reference.programAddress);
    expect(ix?.data).toEqual(reference.data);
    expect(ix?.accounts?.map((a) => a.address)).toEqual(reference.accounts.map((a) => a.address));
    expect(ix?.accounts?.map((a) => a.role)).toEqual([AccountRole.WRITABLE, AccountRole.WRITABLE, AccountRole.READONLY_SIGNER]);
  });

  it("quotes no route for any other pair, either direction", async () => {
    const pricer = issuePricer([route]);
    expect(await pricer.quote({ inputMint: OUTPUT, outputMint: INPUT, amountIn: 10n, taker: TAKER })).toBeNull();
    expect(await pricer.quote({ inputMint: INPUT, outputMint: OTHER, amountIn: 10n, taker: TAKER })).toBeNull();
    expect(await pricer.quote({ inputMint: OTHER, outputMint: OUTPUT, amountIn: 10n, taker: TAKER })).toBeNull();
  });

  it("refuses a rate that is not positive on both sides", () => {
    expect(() => issuePricer([{ ...route, out: 0n }])).toThrow(RangeError);
    expect(() => issuePricer([{ ...route, in: 0n }])).toThrow(RangeError);
    expect(() => issuePricer([route, { ...route, outputMint: OTHER, in: -1n }])).toThrow(RangeError);
  });
});
