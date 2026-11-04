import { NATIVE_MINT } from "@intent-engine/core";
import { describe, expect, it } from "vitest";
import { FailedOnChain } from "../src/index.js";
import { createTestWorld } from "../src/testing.js";

describe("test world funding", () => {
  it("funds a wallet and a native token account", async () => {
    const world = await createTestWorld();
    const funded = await world.wallet(2);
    expect(world.svm.getBalance(funded.address)).toBe(2_000_000_000n);
    const account = await world.tokens(funded.address, NATIVE_MINT, 3_000n);
    expect(await world.tokenBalance(funded.address, NATIVE_MINT)).toBe(3_000n);
    await world.tokens(funded.address, NATIVE_MINT, 3_000n);
    expect(await world.tokenBalance(funded.address, NATIVE_MINT)).toBe(6_000n);
    expect(account).toBeTruthy();
  });

  it("throws a typed error when the airdrop for a wallet fails", async () => {
    const world = await createTestWorld();
    await expect(world.wallet("18000000000")).rejects.toBeInstanceOf(FailedOnChain);
  });

  it("throws a typed error when the airdrop for native tokens fails", async () => {
    const world = await createTestWorld();
    const owner = await world.wallet(1);
    await expect(world.tokens(owner.address, NATIVE_MINT, 18_000_000_000_000_000_000n)).rejects.toBeInstanceOf(FailedOnChain);
  });
});
