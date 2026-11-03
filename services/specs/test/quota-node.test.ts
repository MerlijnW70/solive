import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LIST_PAGE_SIZE, MAX_LIST_PAGES } from "../src/limits.js";
import { blobStoreWith } from "../src/store.js";

type Page = { blobs: { size: number }[]; cursor?: string; hasMore: boolean };

let server: Server;
let urls: URL[];

const blob = (size: number) => ({ url: "https://store.invalid/b", downloadUrl: "https://store.invalid/b?download=1", pathname: `sha256/${size}`, size, uploadedAt: "2026-11-03T00:00:00.000Z", etag: "e" });

async function serve(answer: (url: URL) => Page, delayMs = 0): Promise<void> {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    urls.push(url);
    const page = answer(url);
    setTimeout(() => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ ...page, blobs: page.blobs.map(({ size }) => blob(size)) }));
    }, delayMs);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  vi.stubEnv("VERCEL_BLOB_API_URL", `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_teststore_secret");
}

beforeEach(() => {
  urls = [];
});

afterEach(async () => {
  vi.unstubAllEnvs();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("the count with the real blob client", () => {
  it("sums sizes across pages, listing the sha256 prefix and following the cursor", async () => {
    await serve((url) => {
      const cursor = url.searchParams.get("cursor");
      if (cursor === null) return { blobs: [{ size: 100 }, { size: 20 }], cursor: "c1", hasMore: true };
      if (cursor === "c1") return { blobs: [{ size: 3 }], cursor: "c2", hasMore: true };
      return { blobs: [{ size: 4000 }], hasMore: false };
    });
    expect(await blobStoreWith(2_000).total()).toBe(4123);
    expect(urls).toHaveLength(3);
    expect(urls.map((url) => url.searchParams.get("prefix"))).toStrictEqual(["sha256/", "sha256/", "sha256/"]);
    expect(urls.map((url) => url.searchParams.get("cursor"))).toStrictEqual([null, "c1", "c2"]);
    expect(urls[0]?.searchParams.get("limit")).toBe(String(LIST_PAGE_SIZE));
  });

  it("counts an empty store as zero", async () => {
    await serve(() => ({ blobs: [], hasMore: false }));
    expect(await blobStoreWith(2_000).total()).toBe(0);
  });

  it("fails closed on a store with more pages than a count may read", async () => {
    await serve(() => ({ blobs: [{ size: 1 }], cursor: `c${urls.length}`, hasMore: true }));
    await expect(blobStoreWith(20_000).total()).rejects.toThrow("more pages");
    expect(urls).toHaveLength(MAX_LIST_PAGES);
  }, 30_000);

  it("fails closed when a page claims more but gives no new cursor", async () => {
    await serve(() => ({ blobs: [{ size: 1 }], hasMore: true }));
    await expect(blobStoreWith(2_000).total()).rejects.toThrow("did not move on");
    expect(urls).toHaveLength(1);
  });

  it("fails closed when pages come too slowly for one time bound, and stops asking", async () => {
    await serve(() => ({ blobs: [{ size: 1 }], cursor: `c${urls.length}`, hasMore: true }), 80);
    const started = Date.now();
    await expect(blobStoreWith(300).total()).rejects.toThrow("no answer within 300 ms");
    expect(Date.now() - started).toBeLessThan(2_000);
    const asked = urls.length;
    expect(asked).toBeLessThan(MAX_LIST_PAGES);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(urls.length).toBeLessThanOrEqual(asked + 1);
  });

  it("fails closed on a blob without a usable size", async () => {
    await serve(() => ({ blobs: [{ size: -1 }], hasMore: false }));
    await expect(blobStoreWith(2_000).total()).rejects.toThrow("usable size");
  });
});
