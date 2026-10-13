import type { Address } from "@solana/kit";

export { TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";

export const TOKEN_2022_PROGRAM_ADDRESS = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;
export const NATIVE_MINT = "So11111111111111111111111111111111111111112" as Address;
export const DEVNET_TEST_MINT = "ETU8trkkfE8gNVPDGbCaJUoH88wy6yYV6ttJdc9NKB88" as Address;

export function tokenName(mint: Address): "SOL" | "TEST" | undefined {
  return mint === NATIVE_MINT ? "SOL" : mint === DEVNET_TEST_MINT ? "TEST" : undefined;
}
