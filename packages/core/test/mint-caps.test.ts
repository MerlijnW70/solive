import { createHash } from "node:crypto";
import { AccountRole, type Address, createNoopSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  buildCancelIntent,
  buildCloseIntent,
  buildCreateIntent,
  buildExpireIntent,
  buildFillAttested,
  buildFillAttestedSplit,
  buildFillIntent,
  buildFlashFill,
  buildSetMintCap,
  getSetMintCapInstructionDataDecoder,
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
  MINT_CAP_VERSION,
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
        version: MINT_CAP_VERSION,
        bump: 254,
        padding: new Uint8Array(2),
        totalLimit: 900n,
        outstanding: 400n,
        createdAt: 1_000n,
        reserved: new Uint8Array(32),
      }),
    );
    expect(isMintCapData(data)).toBe(true);
    const cap = decodeMintCapData(data);
    expect(cap).toMatchObject({ mint: MINT, maxPerOrder: 300n, windowCap: 500n, windowStart: 1_000n, windowUsed: 200n, windowSecs: 60, version: MINT_CAP_VERSION, bump: 254, totalLimit: 900n, outstanding: 400n });
    expect(capWindow(cap, 1_059n)).toEqual({ start: 1_000n, ends: 1_060n, used: 200n, left: 300n });
    expect(capWindow(cap, 1_060n)).toEqual({ start: 1_060n, ends: 1_120n, used: 0n, left: 500n });
    expect(isMintCapData(data.subarray(0, getMintCapSize() - 1))).toBe(false);
    expect(() => decodeMintCapData(new Uint8Array(getMintCapSize()))).toThrow(RangeError);
    expect(() => checkMintCapLimits({ maxPerOrder: 0n, windowCap: 1n, windowSecs: 60 })).toThrow(RangeError);
    expect(() => checkMintCapLimits({ maxPerOrder: 2n, windowCap: 1n, windowSecs: 60 })).toThrow(RangeError);
    expect(() => checkMintCapLimits({ maxPerOrder: 1n, windowCap: 1n, windowSecs: 59 })).toThrow(RangeError);
    expect(checkMintCapLimits({ maxPerOrder: 1n, windowCap: 1n, windowSecs: 60 })).toEqual({ maxPerOrder: 1n, windowCap: 1n, windowSecs: 60 });
    expect(() => checkMintCapLimits({ maxPerOrder: 1n, windowCap: 1n, windowSecs: 60, totalLimit: -1n })).toThrow(RangeError);
    expect(() => checkMintCapLimits({ maxPerOrder: 1n, windowCap: 1n, windowSecs: 60, totalLimit: 1n << 64n })).toThrow(RangeError);
    expect(checkMintCapLimits({ maxPerOrder: 1n, windowCap: 1n, windowSecs: 60, totalLimit: 0n }).totalLimit).toBe(0n);
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

  it("set mint cap carries the total limit the caller names", async () => {
    const admin = createNoopSigner("11111111111111111111111111111112" as Address);
    const limits = { admin, mint: MINT, maxPerOrder: 10n, windowCap: 20n, windowSecs: 60 };
    const decoder = getSetMintCapInstructionDataDecoder();
    const none = await buildSetMintCap({ ...limits, totalLimit: 0n });
    const some = await buildSetMintCap({ ...limits, totalLimit: 70n });
    const unnamed = limits as unknown as Parameters<typeof buildSetMintCap>[0];
    await expect(buildSetMintCap(unnamed)).rejects.toThrow(RangeError);
    expect(decoder.decode(none.data ?? new Uint8Array()).totalLimit).toBe(0n);
    expect(decoder.decode(some.data ?? new Uint8Array()).totalLimit).toBe(70n);
  });

  it("every exit names the mint cap only when its intent counts escrow", async () => {
    const signer = createNoopSigner("11111111111111111111111111111112" as Address);
    const owner = "11111111111111111111111111111113" as Address;
    const cap = await findMintCapAddress(MINT);
    const ref = { owner, nonce: 0n, inputMint: MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS };
    const fill = {
      solver: signer,
      owner,
      nonce: 0n,
      inputMint: MINT,
      outputMint: OUT,
      inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      receiver: owner,
      solverOutput: owner,
      solverInput: owner,
      amountIn: 10n,
      amountOut: 1n,
      maxFeeBps: 0,
    };
    const attested = { solver: signer, owner, nonce: 0n, inputMint: MINT, inputTokenProgram: TOKEN_PROGRAM_ADDRESS, amountIn: 10n, result: 1n, maxFeeBps: 0 };
    const exits = [
      (capped?: bigint) => buildCancelIntent({ ...ref, owner: signer, ...(capped === undefined ? {} : { capped }) }),
      (capped?: bigint) => buildExpireIntent({ ...ref, cranker: signer, ...(capped === undefined ? {} : { capped }) }),
      (capped?: bigint) => buildCloseIntent({ ...ref, cranker: signer, ...(capped === undefined ? {} : { capped }) }),
      (capped?: bigint) => buildFillIntent({ ...fill, ...(capped === undefined ? {} : { capped }) }),
      async (capped?: bigint) => (await buildFlashFill({ ...fill, ...(capped === undefined ? {} : { capped }) }))[0],
      (capped?: bigint) => buildFillAttested({ ...attested, payee: owner, ...(capped === undefined ? {} : { capped }) }),
      (capped?: bigint) => buildFillAttestedSplit({ ...attested, recipients: [owner], weights: [10_000], ...(capped === undefined ? {} : { capped }) }),
    ];
    for (const exit of exits) {
      const counted = await exit(5n);
      const uncounted = await exit(0n);
      const unknown = await exit();
      expect(counted?.accounts?.at(-3)).toEqual({ address: cap, role: AccountRole.WRITABLE });
      expect(uncounted?.accounts?.at(-3)).toEqual({ address: INTENT_ENGINE_PROGRAM_ADDRESS, role: AccountRole.READONLY });
      expect(unknown?.accounts).toEqual(uncounted?.accounts);
      expect(counted?.accounts?.length).toBe(uncounted?.accounts?.length);
    }
  });
});
