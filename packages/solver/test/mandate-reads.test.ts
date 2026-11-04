import { type Address, getAddressDecoder, type ReadonlyUint8Array } from "@solana/kit";
import { describe, expect, it } from "vitest";
import type { Intent } from "@intent-engine/core";
import {
  findUserStatePda,
  getMandateDecoder,
  getMandateEncoder,
  getMandateSize,
  getUserStateDecoder,
  getUserStateEncoder,
  getUserStateSize,
  MANDATE_DISCRIMINATOR,
  MANDATE_VERSION,
  NO_MANDATE,
  USER_STATE_DISCRIMINATOR,
  USER_VERSION,
} from "@intent-engine/core/internal";
import { deadMandate, MANDATE_GONE, mandateEpochPassed, mandateReplaced, mandateUnreadable, OWNER_STATE_GONE } from "../src/index.js";

const OWNER = getAddressDecoder().decode(new Uint8Array(32).fill(3));
const MANDATE = getAddressDecoder().decode(new Uint8Array(32).fill(4));

function raw(discriminator: ReadonlyUint8Array, size: number, versionAt: number, version: number): Uint8Array {
  const data = new Uint8Array(size);
  data.set(discriminator, 0);
  data[8 + versionAt] = version;
  return data;
}

const mandateData = (serial: bigint, epoch: bigint) => {
  const zero = getMandateDecoder().decode(raw(MANDATE_DISCRIMINATOR, getMandateSize(), 307, MANDATE_VERSION));
  return new Uint8Array(getMandateEncoder().encode({ ...zero, serial, epoch }));
};

const stateData = (epoch: bigint) => {
  const zero = getUserStateDecoder().decode(raw(USER_STATE_DISCRIMINATOR, getUserStateSize(), 72, USER_VERSION));
  return new Uint8Array(getUserStateEncoder().encode({ ...zero, epoch }));
};

const intent = (mandate: Address, mandateSerial: bigint) => ({ owner: OWNER, mandate, mandateSerial }) as unknown as Intent;

async function reader(mandate: Uint8Array | null, state: Uint8Array | null) {
  const [ownerState] = await findUserStatePda({ owner: OWNER });
  const reads: Address[] = [];
  const read = async (address: Address) => {
    reads.push(address);
    return address === MANDATE ? mandate : address === ownerState ? state : null;
  };
  return { read, reads, ownerState };
}

describe("deadMandate mirrors the program's mandate liveness check", () => {
  it("reads nothing for an intent without a mandate", async () => {
    const { read, reads } = await reader(null, null);
    expect(await deadMandate(intent(NO_MANDATE, 0n), read)).toBeNull();
    expect(reads).toEqual([]);
  });

  it("passes a mandate whose serial and epoch match, reading the mandate and the owner's user state", async () => {
    const { read, reads, ownerState } = await reader(mandateData(9n, 2n), stateData(2n));
    expect(await deadMandate(intent(MANDATE, 9n), read)).toBeNull();
    expect(new Set(reads)).toEqual(new Set([MANDATE, ownerState]));
  });

  it("names a closed mandate and a missing owner state apart", async () => {
    expect(await deadMandate(intent(MANDATE, 9n), (await reader(null, stateData(2n))).read)).toBe(MANDATE_GONE);
    expect(await deadMandate(intent(MANDATE, 9n), (await reader(mandateData(9n, 2n), null)).read)).toBe(OWNER_STATE_GONE);
  });

  it("says which account it could not read", async () => {
    const junk = new Uint8Array(40);
    const badMandate = await deadMandate(intent(MANDATE, 9n), (await reader(junk, stateData(2n))).read);
    expect(badMandate?.startsWith(mandateUnreadable("mandate account", new Error("x")).split("(")[0] ?? "")).toBe(true);
    const badState = await deadMandate(intent(MANDATE, 9n), (await reader(mandateData(9n, 2n), junk)).read);
    expect(badState?.startsWith(mandateUnreadable("owner's user state", new Error("x")).split("(")[0] ?? "")).toBe(true);
  });

  it("names a replaced serial before a passed epoch", async () => {
    expect(await deadMandate(intent(MANDATE, 9n), (await reader(mandateData(10n, 2n), stateData(3n))).read)).toBe(mandateReplaced(10n, 9n));
    expect(await deadMandate(intent(MANDATE, 9n), (await reader(mandateData(9n, 2n), stateData(3n))).read)).toBe(mandateEpochPassed(3n, 2n));
  });
});
