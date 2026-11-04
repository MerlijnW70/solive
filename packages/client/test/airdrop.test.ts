import { generateKeyPairSigner, lamports } from "@solana/kit";
import { LiteSVM } from "litesvm";
import { expect, it } from "vitest";
import { airdropped } from "./airdrop.js";

it("the airdrop helper throws when the airdrop fails and funds the address when it lands", async () => {
  const svm = new LiteSVM();
  const { address } = await generateKeyPairSigner();
  expect(() => airdropped(svm, address, lamports(2n ** 64n - 1n))).toThrow(/airdrop of .* failed/);
  expect(svm.getBalance(address)).toBeNull();
  airdropped(svm, address, lamports(1_000_000_000n));
  expect(svm.getBalance(address)).toBe(1_000_000_000n);
});
