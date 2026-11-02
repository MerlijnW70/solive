import { MAX_SPEC_BYTES } from "./spec-guard.js";

export const SPEC_CACHE_ENTRIES = 64;
export const SPEC_CACHE_BYTES = 8 * MAX_SPEC_BYTES;

export type CachedSpec = { url: string; bytes: Uint8Array };

export class SpecCache {
  readonly #entries = new Map<string, CachedSpec>();
  readonly #maxEntries: number;
  readonly #maxBytes: number;
  #bytes = 0;

  constructor(maxEntries = SPEC_CACHE_ENTRIES, maxBytes = SPEC_CACHE_BYTES) {
    this.#maxEntries = maxEntries;
    this.#maxBytes = maxBytes;
  }

  get size(): number {
    return this.#entries.size;
  }

  get bytes(): number {
    return this.#bytes;
  }

  get(hash: string): CachedSpec | undefined {
    const found = this.#entries.get(hash);
    if (found === undefined) {
      return undefined;
    }
    this.#entries.delete(hash);
    this.#entries.set(hash, found);
    return { url: found.url, bytes: found.bytes.slice() };
  }

  put(hash: string, url: string, bytes: Uint8Array): void {
    if (bytes.length > this.#maxBytes || this.#maxEntries < 1) {
      return;
    }
    const known = this.#entries.get(hash);
    if (known !== undefined) {
      this.#entries.delete(hash);
      this.#bytes -= known.bytes.length;
    }
    this.#entries.set(hash, { url, bytes: bytes.slice() });
    this.#bytes += bytes.length;
    for (const [oldest, entry] of this.#entries) {
      if (this.#entries.size <= this.#maxEntries && this.#bytes <= this.#maxBytes) {
        break;
      }
      this.#entries.delete(oldest);
      this.#bytes -= entry.bytes.length;
    }
  }
}
