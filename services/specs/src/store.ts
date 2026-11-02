import { BlobNotFoundError, get, head, put } from "@vercel/blob";
import { IMMUTABLE_SECS, STORE_TIMEOUT_MS } from "./limits.js";
import { within } from "./within.js";

export type SpecStore = {
  readonly read: (hex: string) => Promise<Uint8Array | null>;
  readonly has: (hex: string) => Promise<boolean>;
  readonly write: (hex: string, bytes: Uint8Array) => Promise<boolean>;
};

const pathOf = (hex: string): string => `sha256/${hex}`;

export function blobStoreWith(timeoutMs: number): SpecStore {
  const bounded = <T>(call: (abortSignal: AbortSignal) => Promise<T>): Promise<T> => {
    const controller = new AbortController();
    return within(call(controller.signal), timeoutMs).finally(() => controller.abort());
  };
  const held = (hex: string): Promise<boolean> =>
    bounded(async (abortSignal) => {
      try {
        await head(pathOf(hex), { abortSignal });
        return true;
      } catch (failure) {
        if (failure instanceof BlobNotFoundError) return false;
        throw failure;
      }
    });
  return {
    read: (hex) =>
      bounded(async (abortSignal) => {
        const found = await get(pathOf(hex), { access: "public", abortSignal });
        if (found === null || found.statusCode !== 200) return null;
        return new Uint8Array(await new Response(found.stream).arrayBuffer());
      }),
    has: held,
    write: async (hex, bytes) => {
      try {
        await bounded((abortSignal) =>
          put(pathOf(hex), Buffer.from(bytes), {
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
        if (await held(hex)) return false;
        throw failure;
      }
    },
  };
}

export const blobStore = blobStoreWith(STORE_TIMEOUT_MS);
