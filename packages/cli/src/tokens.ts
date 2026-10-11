import type { Address } from "@solana/kit";

export const NATIVE_MINT = "So11111111111111111111111111111111111111112" as Address;
export const TEST_TOKEN = "ETU8trkkfE8gNVPDGbCaJUoH88wy6yYV6ttJdc9NKB88" as Address;
export const DEVNET_URL = "https://api.devnet.solana.com";

export const testTokenElsewhere = (url: string) => `TEST names the devnet test token; on ${url} pass the token's mint address`;

export function tokenNamed(text: string, url: string): string | Error {
  const name = text.toUpperCase();
  if (name === "SOL") {
    return NATIVE_MINT;
  }
  if (name === "TEST") {
    return url === DEVNET_URL ? TEST_TOKEN : new Error(testTokenElsewhere(url));
  }
  return text;
}
