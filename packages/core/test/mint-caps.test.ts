import { createHash } from "node:crypto";
import { AccountRole, type Address, createNoopSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  buildCreateIntent,
  capWindow,
  checkMintCapLimits,
  decodeMintCapData,
  findMintCapAddress,
  getMintCapEncoder,
  getMintCapSize,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  isMintCapData,
  Kind,
  MINT_CAP_DISCRIMINATOR,
  TOKEN_PROGRAM_ADDRESS,
} from "../src/index.js";

const MINT = "So11111111111111111111111111111111111111112" as Address;
const OUT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB" as Address;

describe("mint cap accounts", () => {
  it("decode the program's mint cap layout and roll its window like the program", () => {
    expect([...MINT_CAP_DISCRIMINATOR]).toEqual([...createHash("sha256").update("account:MintCap").digest().subarray(0, 8)]);
    expect(getMintCapSize()).toBe(136);
    const data = Uint8Array.from(
      getMintCapEncoder().encode({
        mint: MINT,
        maxPerOrder: 300n,
        windowCap: 500n,
        windowStart: 1_000n,
        windowUsed: 200n,
        windowSecs: 60,
        version: 1,
        bump: 254,
        padding: new Uint8Array(2),
        reserved: new Uint8Array(56),
      }),
    );
    expect(isMintCapData(data)).toBe(true);
    const cap = decodeMintCapData(data);
    expect(cap).toMatchObject({ mint: MINT, maxPerOrder: 300n, windowCap: 500n, windowStart: 1_000n, windowUsed: 200n, windowSecs: 60, version: 1, bump: 254 });
    expect(capWindow(cap, 1_059n)).toEqual({ start: 1_000n, ends: 1_060n, used: 200n, left: 300n });
    expect(capWindow(cap, 1_060n)).toEqual({ start: 1_060n, ends: 1_120n, used: 0n, left: 500n });
    expect(isMintCapData(data.subarray(0, getMintCapSize() - 1))).toBe(false);
    expect(() => decodeMintCapData(new Uint8Array(getMintCapSize()))).toThrow(RangeError);
    expect(() => checkMintCapLimits({ maxPerOrder: 0n, windowCap: 1n, windowSecs: 60 })).toThrow(RangeError);
    expect(() => checkMintCapLimits({ maxPerOrder: 2n, windowCap: 1n, windowSecs: 60 })).toThrow(RangeError);
    expect(() => checkMintCapLimits({ maxPerOrder: 1n, windowCap: 1n, windowSecs: 59 })).toThrow(RangeError);
    expect(checkMintCapLimits({ maxPerOrder: 1n, windowCap: 1n, windowSecs: 60 })).toEqual({ maxPerOrder: 1n, windowCap: 1n, windowSecs: 60 });
  });

  it("a create names the mint cap when given and the program id in its place when not", async () => {
    const owner = createNoopSigner("11111111111111111111111111111112" as Address);
    const spec = {
      owner,
      treasury: owner.address,
      maxCreateFee: 0,
      maxBounty: 0,
      nonce: 0n,
      params: { kind: Kind.SwapExactIn, amountIn: 10n, minOut: 1n },
      expiresAt: 2_000_000_000n,
      inputMint: MINT,
      outputMint: OUT,
      inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
    } as const;
    const cap = await findMintCapAddress(MINT);
    const without = await buildCreateIntent(spec);
    const withCap = await buildCreateIntent({ ...spec, mintCap: cap });
    expect(without.accounts.length).toBe(withCap.accounts.length);
    expect(without.accounts.at(-3)).toEqual({ address: INTENT_ENGINE_PROGRAM_ADDRESS, role: AccountRole.READONLY });
    expect(withCap.accounts.at(-3)).toEqual({ address: cap, role: AccountRole.WRITABLE });
    expect(without.accounts.slice(0, -3)).toEqual(withCap.accounts.slice(0, -3));
  });
});
