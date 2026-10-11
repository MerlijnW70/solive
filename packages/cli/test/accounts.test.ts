import type { Address } from "@solana/kit";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { createdAccount, rentExemptMinimum, tokenAmountOf } from "../src/accounts.js";
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

const rentSysvar = (perByteYear: bigint, threshold: number) => {
  const data = new Uint8Array(17);
  const view = new DataView(data.buffer);
  view.setBigUint64(0, perByteYear, true);
  view.setFloat64(8, threshold, true);
  return holding({ owner: "Sysvar1111111111111111111111111111111111111" as Address, data, lamports: 1n });
};

describe("rent exemption", () => {
  it("prices an account's storage from the cluster's rent sysvar", async () => {
    expect(await rentExemptMinimum(rentSysvar(3_480n, 2), 0)).toBe(890_880n);
    expect(await rentExemptMinimum(rentSysvar(3_480n, 2), 165)).toBe(2_039_280n);
    expect(await rentExemptMinimum(rentSysvar(6_960n, 0.5), 165)).toBe(1_019_640n);
    await expect(rentExemptMinimum(holding(null), 0)).rejects.toThrow("the rent sysvar is missing");
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
