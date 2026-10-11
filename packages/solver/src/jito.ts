import type { Address, Base64EncodedWireTransaction } from "@solana/kit";
import type { Fetch } from "./market.js";

export const JITO_TIP_ACCOUNTS = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
  "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
  "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
  "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
  "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
  "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
  "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
] as Address[];

export const MAX_BUNDLE = 5;

export function tipAccount(entropy: number): Address {
  if (!Number.isInteger(entropy) || entropy < 0) {
    throw new RangeError(`tip entropy must be a non-negative integer, got ${entropy}`);
  }
  const account = JITO_TIP_ACCOUNTS[entropy % JITO_TIP_ACCOUNTS.length];
  if (account === undefined) {
    throw new RangeError("no tip account");
  }
  return account;
}

export function jitoBundles(options: { url: string; fetch: Fetch }) {
  return async (wires: readonly Base64EncodedWireTransaction[]): Promise<string> => {
    if (wires.length < 1 || wires.length > MAX_BUNDLE) {
      throw new RangeError(`a bundle holds 1 to ${MAX_BUNDLE} transactions, got ${wires.length}`);
    }
    const response = await options.fetch(`${options.url}/api/v1/bundles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "sendBundle", params: [wires, { encoding: "base64" }] }),
    });
    if (!response.ok) {
      throw new Error(`jito rejected the bundle with status ${response.status}`);
    }
    const reply = (await response.json()) as { result?: unknown; error?: { message?: unknown } };
    if (typeof reply.result === "string") {
      return reply.result;
    }
    const message = typeof reply.error?.message === "string" ? reply.error.message : "no bundle id returned";
    throw new Error(`jito rejected the bundle: ${message}`);
  };
}
