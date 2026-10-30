import { isAddress, type Address } from "@solana/kit";

export type Headers = Readonly<Record<string, string | readonly string[] | undefined>>;

export type ParsedBody = { readonly ok: true; readonly address: Address } | { readonly ok: false; readonly error: string };

export const NOT_JSON = 'Send a JSON body of the form {"address": "<your base58 address>"}.';
export const BAD_ADDRESS = "The address is not a valid base58 Solana address, so copy it again from your wallet.";

export function parseBody(body: string | undefined): ParsedBody {
  if (body === undefined || body.trim() === "") return { ok: false, error: NOT_JSON };
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return { ok: false, error: NOT_JSON };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { ok: false, error: NOT_JSON };
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "address")) return { ok: false, error: NOT_JSON };
  const address: unknown = (value as { address?: unknown }).address;
  if (typeof address !== "string" || !isAddress(address)) return { ok: false, error: BAD_ADDRESS };
  return { ok: true, address };
}

function first(value: string | readonly string[] | undefined): string | undefined {
  const raw = typeof value === "string" ? value : value?.[0];
  const entry = raw?.split(",")[0]?.trim();
  return entry === undefined || entry === "" ? undefined : entry;
}

export function callerOf(headers: Headers, fallback?: string): string {
  return first(headers["x-forwarded-for"]) ?? first(headers["x-real-ip"]) ?? fallback ?? "unknown";
}
