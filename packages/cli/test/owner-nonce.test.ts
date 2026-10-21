import { type Address, generateKeyPairSigner, none, some } from "@solana/kit";
import { AccountState, getTokenEncoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { findDelegatePda, U64_MAX } from "@intent-engine/core";
import type { Transport } from "@intent-engine/client";
import { lowerAllowance, pickNonce, raiseAllowance } from "../src/agent/owner.js";

const FULL = (1n << 64n) - 1n;

const window = (nonceBase: bigint, nonceBitmap: bigint[]) => ({ nonceBase, nonceBitmap, epoch: 0n });

async function approved(delegatedAmount: bigint) {
  const owner = (await generateKeyPairSigner()).address;
  const account = (await generateKeyPairSigner()).address;
  const [engine] = await findDelegatePda({ owner });
  const data = Uint8Array.from(
    getTokenEncoder().encode({
      mint: account,
      owner,
      amount: 0n,
      delegate: some(engine),
      state: AccountState.Initialized,
      isNative: none(),
      delegatedAmount,
      closeAuthority: none(),
    }),
  );
  const transport = {
    getAccount: async (address: Address) => (address === account ? { owner: TOKEN_PROGRAM_ADDRESS, data, lamports: 1n } : null),
  } as unknown as Transport;
  return { transport, owner, account };
}

describe("the owner's nonce window", () => {
  it("never offers a nonce past the window of 256", () => {
    expect(() => pickNonce(window(0n, [FULL, FULL, FULL, FULL]), undefined)).toThrow(/every nonce in the owner's window is used/);
    expect(pickNonce(window(0n, [FULL, FULL, FULL, FULL >> 1n]), undefined)).toBe(255n);
  });

  it("offers the last u64 nonce but never one past it", () => {
    expect(pickNonce(window(U64_MAX, [0n, 0n, 0n, 0n]), undefined)).toBe(U64_MAX);
    expect(pickNonce(window(U64_MAX - 1n, [1n, 0n, 0n, 0n]), undefined)).toBe(U64_MAX);
    expect(() => pickNonce(window(U64_MAX, [1n, 0n, 0n, 0n]), undefined)).toThrow(/every nonce in the owner's window is used/);
    expect(() => pickNonce(window(U64_MAX - 1n, [3n, 0n, 0n, 0n]), undefined)).toThrow(/every nonce in the owner's window is used/);
  });
});

describe("the engine's spending allowance", () => {
  it("rises by the amount asked and stops at the u64 limit", async () => {
    const { transport, owner, account } = await approved(U64_MAX - 5n);
    for (const [by, after] of [
      [3n, U64_MAX - 2n],
      [5n, U64_MAX],
      [6n, U64_MAX],
      [U64_MAX, U64_MAX],
    ] as const) {
      expect(await raiseAllowance(transport, owner, account, by)).toEqual({ account, before: U64_MAX - 5n, after, replaces: null });
    }
  });

  it("falls by the amount asked and stops at zero", async () => {
    const { transport, owner, account } = await approved(10n);
    for (const [by, after] of [
      [0n, 10n],
      [3n, 7n],
      [10n, 0n],
      [11n, 0n],
      [U64_MAX, 0n],
    ] as const) {
      expect(await lowerAllowance(transport, owner, account, by)).toEqual({ account, before: 10n, after, replaces: null });
    }
  });
});
