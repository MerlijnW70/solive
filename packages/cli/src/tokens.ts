import type { Address } from "@solana/kit";
import { DEVNET_TEST_MINT, NATIVE_MINT } from "@intent-engine/core";

export const DEVNET_URL = "https://api.devnet.solana.com";

export const testTokenElsewhere = (url: string) => `TEST names the devnet test token; on ${url} pass the token's mint address`;

export function tokenNamed(text: string, url: string): string | Error {
  const name = text.toUpperCase();
  if (name === "SOL") {
    return NATIVE_MINT;
  }
  if (name === "TEST") {
    return url === DEVNET_URL ? DEVNET_TEST_MINT : new Error(testTokenElsewhere(url));
  }
  return text;
}

export const TOKEN_NAMES: Readonly<Record<string, string>> = { [NATIVE_MINT]: "SOL", [DEVNET_TEST_MINT]: "TEST" };

export function tokenNames(inputMint: Address, outputMint: Address): { inputName?: string; outputName?: string } {
  const [inputName, outputName] = [TOKEN_NAMES[inputMint], TOKEN_NAMES[outputMint]];
  return { ...(inputName === undefined ? {} : { inputName }), ...(outputName === undefined ? {} : { outputName }) };
}
