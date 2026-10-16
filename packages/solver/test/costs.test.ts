import { describe, expect, it } from "vitest";
import { backingOff, mintExtensions, TOKEN_2022_ACCOUNT_SPACE, TOKEN_2022_PROGRAM, TOKEN_ACCOUNT_SPACE, tokenAccountSpace } from "../src/index.js";

function mint(types: number[]): Uint8Array {
  const data = new Uint8Array(TOKEN_ACCOUNT_SPACE + 1 + types.length * 4);
  const view = new DataView(data.buffer);
  data[TOKEN_ACCOUNT_SPACE] = 1;
  types.forEach((type, i) => view.setUint16(TOKEN_ACCOUNT_SPACE + 1 + i * 4, type, true));
  return data;
}

describe("token account space", () => {
  it("adds two bytes when the account would be exactly as long as a multisig, as token-2022 does", () => {
    expect(tokenAccountSpace(TOKEN_2022_PROGRAM, mint([16, 16, 1, 1, 1, 14, 9, 9]))).toBe(357);
    expect(tokenAccountSpace(TOKEN_2022_PROGRAM, mint([16, 16, 1, 1, 1, 14, 9]))).toBe(351);
    expect(tokenAccountSpace(TOKEN_2022_PROGRAM, mint([16, 16, 1, 1, 1, 14, 9, 9, 9]))).toBe(359);
  });

  it("finds no extensions in a mint too short to hold one", () => {
    for (const length of [0, 82, TOKEN_ACCOUNT_SPACE, TOKEN_ACCOUNT_SPACE + 1, TOKEN_ACCOUNT_SPACE + 4]) {
      expect(mintExtensions(new Uint8Array(length).fill(1))).toEqual([]);
    }
    expect(mintExtensions(mint([14]))).toEqual([14]);
    expect(tokenAccountSpace(TOKEN_2022_PROGRAM, new Uint8Array(TOKEN_ACCOUNT_SPACE + 4).fill(1))).toBe(TOKEN_2022_ACCOUNT_SPACE);
  });
});

describe("backing off", () => {
  it("counts fills and seconds in the singular only when there is one", () => {
    expect(backingOff(1, 1)).toBe("1 fill of this intent failed in a row; it is tried again in 1 second");
    expect(backingOff(2, 1)).toBe("2 fills of this intent failed in a row; it is tried again in 1 second");
    expect(backingOff(1, 30)).toBe("1 fill of this intent failed in a row; it is tried again in 30 seconds");
    expect(backingOff(0, 0)).toBe("0 fills of this intent failed in a row; it is tried again in 0 seconds");
  });
});
