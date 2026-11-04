import { type Address, generateKeyPairSigner, type KeyPairSigner, lamports } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ANNOUNCEMENT_DISCRIMINATOR,
  DELIVERY_BOOK_DISCRIMINATOR,
  getAnnouncementSize,
  getDeliveryBookSize,
  getRefutationSize,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  isDeliveryRecord,
  REFUTATION_DISCRIMINATOR,
} from "@intent-engine/core/internal";
import { EXIT_FAILED } from "../src/main.js";
import { cli, funded, h, world } from "./harness.js";

const RECORDS = [
  { name: "delivery book", discriminator: DELIVERY_BOOK_DISCRIMINATOR, size: getDeliveryBookSize() },
  { name: "announcement", discriminator: ANNOUNCEMENT_DISCRIMINATOR, size: getAnnouncementSize() },
  { name: "refutation", discriminator: REFUTATION_DISCRIMINATOR, size: getRefutationSize() },
] as const;

describe("close-legacy refuses a delivery record, as the program does", () => {
  let keys: Record<string, KeyPairSigner>;

  beforeEach(async () => {
    await world();
    keys = { "payer.json": await funded() };
  });

  async function planted(discriminator: ArrayLike<number>, size: number): Promise<Address> {
    const address = (await generateKeyPairSigner()).address;
    const data = new Uint8Array(size);
    data.set(Array.from(discriminator));
    h.svm.setAccount({ address, data, executable: false, lamports: lamports(h.svm.minimumBalanceForRentExemption(BigInt(size))), programAddress: INTENT_ENGINE_PROGRAM_ADDRESS, space: BigInt(size) });
    return address;
  }

  it.each(RECORDS)("refuses an outdated $name before simulating or sending anything", async ({ name, discriminator, size }) => {
    const address = await planted(discriminator, size);
    const simulated = h.simulated.length;
    const submitted = h.submitted.length;
    const refused = await cli(["close-legacy", "--keypair", "payer.json", "--address", address, "--yes"], keys);
    expect(refused.code).toBe(EXIT_FAILED);
    expect(refused.err).toContain(`${address} is a ${name} account, which is a delivery record, and close-legacy never closes those`);
    expect(h.simulated).toHaveLength(simulated);
    expect(h.submitted).toHaveLength(submitted);
    expect(h.svm.getAccount(address).exists).toBe(true);
  });

  it("names a delivery record by its discriminator and nothing else", () => {
    expect(isDeliveryRecord(new Uint8Array(64))).toBe(false);
    for (const { discriminator } of RECORDS) {
      expect(isDeliveryRecord(new Uint8Array([...discriminator, 0, 0]))).toBe(true);
    }
  });
});
