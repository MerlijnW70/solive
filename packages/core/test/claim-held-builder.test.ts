import { type Address, createNoopSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  buildClaimHeld,
  findIntentPda,
  findMintCapAddress,
  findVaultPda,
  getClaimHeldInstructionDataDecoder,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  validateIxAgainstIdl,
} from "../src/internal.js";
import { InvalidInput } from "../src/errors.js";
import { announced, feeRecipient, idl, inputMint, meta, owner, TOKEN } from "./builder-fixtures.js";

const accountAt = (name: string): number => idl.instructions.find((i) => i.name === "claim_held")?.accounts.findIndex((a) => a.name === name) ?? -1;

async function terms(capped?: bigint) {
  const [intent] = await findIntentPda({ owner, nonce: 5n });
  const to = "SysvarRent111111111111111111111111111111111" as Address;
  return {
    wallet: createNoopSigner(feeRecipient),
    intent,
    announcement: announced.announcement,
    to,
    inputMint,
    inputTokenProgram: TOKEN,
    index: 1,
    recipients: [owner, feeRecipient],
    weights: [6_000, 4_000],
    ...(capped === undefined ? {} : { capped }),
  };
}

describe("the claim_held builder", () => {
  it("names the escrow, its vault, the paid announcement, the receiving account and the split the release named", async () => {
    const input = await terms();
    const ix = await buildClaimHeld(input);
    expect(validateIxAgainstIdl(ix, idl)).toEqual([]);
    expect(meta(ix, accountAt("wallet")).address).toBe(feeRecipient);
    expect(meta(ix, accountAt("intent")).address).toBe(input.intent);
    expect(meta(ix, accountAt("vault")).address).toBe((await findVaultPda({ intent: input.intent }))[0]);
    expect(meta(ix, accountAt("announcement")).address).toBe(input.announcement);
    expect(meta(ix, accountAt("to")).address).toBe(input.to);
    expect(meta(ix, accountAt("mint_cap")).address).toBe(INTENT_ENGINE_PROGRAM_ADDRESS);
    expect(getClaimHeldInstructionDataDecoder().decode(ix.data ?? new Uint8Array())).toMatchObject({ index: 1, claim: { recipients: input.recipients, weights: input.weights } });
  });

  it("passes the mint cap when the escrow is capped", async () => {
    const ix = await buildClaimHeld(await terms(9n));
    expect(validateIxAgainstIdl(ix, idl)).toEqual([]);
    expect(meta(ix, accountAt("mint_cap")).address).toBe(await findMintCapAddress(inputMint));
  });

  it("refuses an index outside the split or held for another wallet", async () => {
    const input = await terms();
    await expect(buildClaimHeld({ ...input, index: 2 })).rejects.toBeInstanceOf(InvalidInput);
    await expect(buildClaimHeld({ ...input, index: 0 })).rejects.toBeInstanceOf(InvalidInput);
    await expect(buildClaimHeld({ ...input, weights: [10_000] })).rejects.toBeInstanceOf(InvalidInput);
  });
});
