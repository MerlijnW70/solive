import type { Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { asked, type Floats, OWN_INTENT, ownIntent } from "../src/index.js";

const OWNER = "11111111111111111111111111111112" as Address;
const OWNER_OUTPUT = "So11111111111111111111111111111111111111112" as Address;
const PAYER = "SysvarC1ock11111111111111111111111111111111" as Address;
const RECEIVER = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" as Address;
const ACCOUNT = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;

describe("inventory owner rules", () => {
  it("refuses an intent the inventory owner placed even when it pays another receiver", () => {
    expect(ownIntent(OWNER, { owner: OWNER, receiver: RECEIVER }, OWNER_OUTPUT)).toBe(OWN_INTENT);
  });

  it("refuses an intent that pays the inventory owner's output even when another key placed it", () => {
    expect(ownIntent(OWNER, { owner: PAYER, receiver: OWNER_OUTPUT }, OWNER_OUTPUT)).toBe(OWN_INTENT);
    expect(ownIntent(OWNER, { owner: OWNER, receiver: OWNER_OUTPUT }, OWNER_OUTPUT)).toBe(OWN_INTENT);
  });

  it("takes an intent that neither comes from nor pays the inventory owner, and any intent without one", () => {
    expect(ownIntent(OWNER, { owner: PAYER, receiver: RECEIVER }, OWNER_OUTPUT)).toBeNull();
    expect(ownIntent(undefined, { owner: OWNER, receiver: OWNER_OUTPUT }, OWNER_OUTPUT)).toBeNull();
  });

  it("keeps the largest fill each float was asked to cover and its latest live amount", () => {
    const floats: Floats = new Map();
    asked(floats, ACCOUNT, 100n, 50n);
    expect(floats.get(ACCOUNT)).toEqual({ live: 100n, needed: 50n });
    asked(floats, ACCOUNT, 90n, 30n);
    expect(floats.get(ACCOUNT)).toEqual({ live: 90n, needed: 50n });
    asked(floats, ACCOUNT, 80n, 50n);
    expect(floats.get(ACCOUNT)).toEqual({ live: 80n, needed: 50n });
    asked(floats, ACCOUNT, 70n, 51n);
    expect(floats.get(ACCOUNT)).toEqual({ live: 70n, needed: 51n });
    expect([...floats.keys()]).toEqual([ACCOUNT]);
    asked(undefined, ACCOUNT, 1n, 1n);
  });
});
