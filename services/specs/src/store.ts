import { BlobNotFoundError, del, get, head, list, put } from "@vercel/blob";
import { IMMUTABLE_SECS, LIST_PAGE_SIZE, MAX_LIST_PAGES, STORE_TIMEOUT_MS } from "./limits.js";
import { within } from "./within.js";

export type Listed = { readonly pathname: string; readonly size: number; readonly uploadedAt: number };

export type SpecStore = {
  readonly read: (hex: string) => Promise<Uint8Array | null>;
  readonly has: (hex: string) => Promise<boolean>;
  readonly write: (hex: string, bytes: Uint8Array) => Promise<boolean>;
  readonly total: () => Promise<number>;
  readonly list: (prefix: string) => Promise<Listed[]>;
  readonly mark: (pathname: string) => Promise<void>;
  readonly remove: (pathnames: readonly string[]) => Promise<void>;
};

export const SPEC_PREFIX = "sha256/";
export const specPath = (hex: string): string => `${SPEC_PREFIX}${hex}`;

const MARK_BODY = "1";
const REMOVE_BATCH = 100;

export function blobStoreWith(timeoutMs: number): SpecStore {
  const bounded = <T>(call: (abortSignal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    return within(call(controller.signal), timeoutMs).finally(() => controller.abort());
  };
  const exists = (pathname: string): Promise<boolean> =>
    bounded(async (abortSignal) => {
      try {
        await head(pathname, { abortSignal });
        return true;
      } catch (failure) {
        if (failure instanceof BlobNotFoundError) return false;
        throw failure;
      }
    });
  const listed = (prefix: string): Promise<Listed[]> =>
    bounded(async (abortSignal) => {
      const found: Listed[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
        const answer = await list({ prefix, limit: LIST_PAGE_SIZE, ...(cursor === undefined ? {} : { cursor }), abortSignal });
        for (const blob of answer.blobs) {
          if (!Number.isSafeInteger(blob.size) || blob.size < 0) throw new Error("the store listed a blob without a usable size");
          const uploadedAt = new Date(blob.uploadedAt).getTime();
          if (!Number.isFinite(uploadedAt)) throw new Error("the store listed a blob without a usable time");
          found.push({ pathname: blob.pathname, size: blob.size, uploadedAt });
        }
        if (!answer.hasMore) return found;
        if (typeof answer.cursor !== "string" || answer.cursor === "" || answer.cursor === cursor) throw new Error("the store listing did not move on");
        cursor = answer.cursor;
      }
      throw new Error("the store holds more pages than a count may read");
    });
  return {
    read: (hex) =>
      bounded(async (abortSignal) => {
        const found = await get(specPath(hex), { access: "public", abortSignal });
        if (found === null || found.statusCode !== 200) return null;
        return new Uint8Array(await new Response(found.stream).arrayBuffer());
      }),
    has: (hex) => exists(specPath(hex)),
    total: async () => (await listed(SPEC_PREFIX)).reduce((sum, blob) => sum + blob.size, 0),
    list: listed,
    write: async (hex, bytes) => {
      try {
        await bounded((abortSignal) =>
          put(specPath(hex), Buffer.from(bytes), {
            access: "public",
            addRandomSuffix: false,
            allowOverwrite: false,
            contentType: "application/octet-stream",
            cacheControlMaxAge: IMMUTABLE_SECS,
            abortSignal,
          }),
        );
        return true;
      } catch (failure) {
        if (await exists(specPath(hex))) return false;
        throw failure;
      }
    },
    mark: async (pathname) => {
      try {
        await bounded((abortSignal) => put(pathname, MARK_BODY, { access: "public", addRandomSuffix: false, allowOverwrite: false, contentType: "text/plain", abortSignal }));
      } catch (failure) {
        if (!(await exists(pathname))) throw failure;
      }
    },
    remove: async (pathnames) => {
      for (let at = 0; at < pathnames.length; at += REMOVE_BATCH) {
        const batch = pathnames.slice(at, at + REMOVE_BATCH);
        await bounded((abortSignal) => del(batch, { abortSignal }));
      }
    },
  };
}

export const blobStore = blobStoreWith(STORE_TIMEOUT_MS);
