import { TOKEN_PROGRAM_ADDRESS as TOKEN_PROGRAM } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, IntentStatus, NATIVE_MINT, statusName, TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS, tokenName } from "../src/index.js";

describe("well-known addresses and status names", () => {
  it("names the wrapped SOL mint, the devnet test token and both token programs", () => {
    expect(NATIVE_MINT).toBe("So11111111111111111111111111111111111111112");
    expect(DEVNET_TEST_MINT).toBe("ETU8trkkfE8gNVPDGbCaJUoH88wy6yYV6ttJdc9NKB88");
    expect(TOKEN_PROGRAM_ADDRESS).toBe(TOKEN_PROGRAM);
    expect(TOKEN_2022_PROGRAM_ADDRESS).toBe("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
  });

  it("gives every status its name and nothing for an unknown one", () => {
    for (const [name, status] of Object.entries(IntentStatus)) {
      expect(statusName(status)).toBe(name);
    }
    expect(statusName(IntentStatus.Filled)).toBe("Filled");
    expect(statusName(250)).toBeUndefined();
    expect(statusName(-1)).toBeUndefined();
  });

  it("names SOL and the devnet test token and no other mint", () => {
    expect(tokenName(NATIVE_MINT)).toBe("SOL");
    expect(tokenName(DEVNET_TEST_MINT)).toBe("TEST");
    expect(tokenName(TOKEN_PROGRAM_ADDRESS)).toBeUndefined();
    expect(tokenName(TOKEN_2022_PROGRAM_ADDRESS)).toBeUndefined();
  });
});
