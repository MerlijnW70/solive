import { InvalidInput } from "./errors.js";
export type ManifestEntry = { path: string; bytes: Uint8Array };

const LENGTH_BYTES = 8;

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }
  return a.length - b.length;
}

function lengthOf(size: number): Uint8Array {
  const out = new Uint8Array(LENGTH_BYTES);
  new DataView(out.buffer).setBigUint64(0, BigInt(size), true);
  return out;
}

export async function manifestSha256(entries: readonly ManifestEntry[]): Promise<string> {
  const encoder = new TextEncoder();
  const named = entries.map((entry) => {
    if (entry.path === "") {
      throw new InvalidInput("path", "length", "a manifest entry needs a non-empty path");
    }
    return { name: encoder.encode(entry.path), bytes: entry.bytes };
  });
  named.sort((a, b) => compareBytes(a.name, b.name));
  const parts: Uint8Array[] = [];
  for (const [i, entry] of named.entries()) {
    const previous = named[i - 1];
    if (previous !== undefined && compareBytes(previous.name, entry.name) === 0) {
      throw new InvalidInput("entries", "duplicate", `the manifest names ${new TextDecoder().decode(entry.name)} more than once`);
    }
    parts.push(lengthOf(entry.name.length), entry.name, lengthOf(entry.bytes.length), entry.bytes);
  }
  const whole = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let at = 0;
  for (const part of parts) {
    whole.set(part, at);
    at += part.length;
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", whole));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}
