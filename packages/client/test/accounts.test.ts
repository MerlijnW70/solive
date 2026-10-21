import { type Address, getAddressEncoder } from "@solana/kit";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { createdAccount, freezeAuthorityOf, mintOf, NotAMint, rentExemptFor, rentExemptMinimum, rentSysvar, tokenAmountOf } from "../src/accounts.js";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@intent-engine/core";
import type { AccountView, Transport } from "../src/transport.js";

const AT = "11111111111111111111111111111112" as Address;

const holding = (view: AccountView | null) => ({ getAccount: async () => view }) as unknown as Transport;

describe("created accounts", () => {
  it("counts lamports a stranger sent to an address as no account until a program claims it", async () => {
    const empty = new Uint8Array();
    const data = new Uint8Array([1]);
    expect(await createdAccount(holding(null), AT)).toBeNull();
    expect(await createdAccount(holding({ owner: SYSTEM_PROGRAM_ADDRESS, data: empty, lamports: 890_880n }), AT)).toBeNull();
    for (const view of [
      { owner: SYSTEM_PROGRAM_ADDRESS, data, lamports: 1n },
      { owner: TOKEN_PROGRAM_ADDRESS, data: empty, lamports: 1n },
      { owner: TOKEN_PROGRAM_ADDRESS, data, lamports: 1n },
    ]) {
      expect(await createdAccount(holding(view), AT)).toBe(view);
    }
  });
});

const rentServed = (perByteYear: bigint, threshold: number) => {
  const data = new Uint8Array(17);
  const view = new DataView(data.buffer);
  view.setBigUint64(0, perByteYear, true);
  view.setFloat64(8, threshold, true);
  return holding({ owner: "Sysvar1111111111111111111111111111111111111" as Address, data, lamports: 1n });
};

describe("rent exemption", () => {
  it("prices an account's storage from the cluster's rent sysvar", async () => {
    expect(await rentExemptMinimum(rentServed(3_480n, 2), 0)).toBe(890_880n);
    expect(await rentExemptMinimum(rentServed(3_480n, 2), 165)).toBe(2_039_280n);
    expect(await rentExemptMinimum(rentServed(6_960n, 0.5), 165)).toBe(1_019_640n);
    await expect(rentExemptMinimum(holding(null), 0)).rejects.toThrow("the rent sysvar is missing");
  });

  it("reads the yearly rate and threshold and prices any size with the runtime's rounding", async () => {
    expect(await rentSysvar(rentServed(3_387n, 1.5))).toEqual({ perByteYear: 3_387n, threshold: 1.5 });
    expect(rentExemptFor({ perByteYear: 3_387n, threshold: 1.5 }, 165)).toBe(1_488_586n);
    expect(rentExemptFor({ perByteYear: 3_387n, threshold: 1.5 }, 170)).toBe(1_513_989n);
    expect(await rentExemptMinimum(rentServed(3_387n, 1.5), 165)).toBe(1_488_586n);
    expect(rentExemptFor({ perByteYear: 5_080n, threshold: 1 }, 165)).toBe(1_488_440n);
    await expect(rentSysvar(holding(null))).rejects.toThrow("the rent sysvar is missing");
  });
});

describe("token amounts", () => {
  it("reads the amount at its offset and refuses data too short to hold one", () => {
    const data = new Uint8Array(165);
    new DataView(data.buffer).setBigUint64(64, 1_234_567_890_123n, true);
    expect(tokenAmountOf(data)).toBe(1_234_567_890_123n);
    expect(tokenAmountOf(data.slice(0, 72))).toBe(1_234_567_890_123n);
    expect(tokenAmountOf(data.slice(0, 71))).toBeNull();
    expect(tokenAmountOf(null)).toBeNull();
  });
});

const FREEZER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" as Address;

function mintData(freezer: Address | null, size = 82): Uint8Array {
  const data = new Uint8Array(size);
  const view = new DataView(data.buffer);
  view.setUint32(0, 1, true);
  data[44] = 6;
  data[45] = 1;
  if (freezer !== null) {
    view.setUint32(46, 1, true);
    data.set(getAddressEncoder().encode(freezer), 50);
  }
  if (size > 82) {
    data[165] = 1;
  }
  return data;
}

describe("mint freeze authority", () => {
  it("reads the option tag at 46 and the authority at 50, or null when the tag is not set", () => {
    expect(freezeAuthorityOf(mintData(null))).toBeNull();
    expect(freezeAuthorityOf(mintData(FREEZER))).toBe(FREEZER);
    expect(freezeAuthorityOf(mintData(FREEZER, 170))).toBe(FREEZER);
    expect(freezeAuthorityOf(mintData(FREEZER).subarray(0, 81))).toBeNull();
    const untagged = mintData(FREEZER);
    untagged[46] = 0;
    expect(freezeAuthorityOf(untagged)).toBeNull();
  });

  it("returns the freeze authority beside the decimals for a Token and a Token-2022 mint", async () => {
    const at = (data: Uint8Array, owner: Address) => holding({ owner, data, lamports: 1n });
    expect(await mintOf(at(mintData(null), TOKEN_PROGRAM_ADDRESS), AT)).toEqual({
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
      decimals: 6,
      scaled: false,
      freezeAuthority: null,
    });
    expect(await mintOf(at(mintData(FREEZER), TOKEN_PROGRAM_ADDRESS), AT)).toMatchObject({ decimals: 6, freezeAuthority: FREEZER });
    expect(await mintOf(at(mintData(FREEZER, 170), TOKEN_2022_PROGRAM_ADDRESS), AT)).toEqual({
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      decimals: 6,
      scaled: false,
      freezeAuthority: FREEZER,
    });
    await expect(mintOf(at(mintData(FREEZER), SYSTEM_PROGRAM_ADDRESS), AT)).rejects.toThrow(NotAMint);
  });
});
