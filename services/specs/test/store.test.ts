import { beforeEach, describe, expect, it, vi } from "vitest";

const blob = vi.hoisted(() => ({ BlobNotFoundError: class extends Error {}, del: vi.fn(), get: vi.fn(), head: vi.fn(), list: vi.fn(), put: vi.fn() }));
vi.mock("@vercel/blob", () => blob);

const { blobStore, blobStoreWith } = await import("../src/store.js");
const HEX = "a".repeat(64);
const PATH = `sha256/${HEX}`;

beforeEach(() => {
  blob.get.mockReset();
  blob.head.mockReset();
  blob.put.mockReset();
  blob.del.mockReset();
  blob.list.mockReset();
});

describe("the blob store", () => {
  it("gives up on a store that does not answer, on every call", async () => {
    const hang = () => new Promise(() => undefined);
    blob.get.mockImplementation(hang);
    blob.head.mockImplementation(hang);
    blob.put.mockImplementation(hang);
    const store = blobStoreWith(10);
    await expect(store.read(HEX)).rejects.toThrow("no answer within 10 ms");
    await expect(store.has(HEX)).rejects.toThrow("no answer within 10 ms");
    await expect(store.write(HEX, Uint8Array.of(1))).rejects.toThrow("no answer within 10 ms");
    expect((blob.head.mock.calls[0] as [string, { abortSignal: AbortSignal }])[1].abortSignal.aborted).toBe(true);
  });

  it("reads the exact bytes from the public path, and null when there is no blob", async () => {
    blob.get.mockResolvedValueOnce({ statusCode: 200, stream: new Response(Uint8Array.of(0, 255, 7)).body });
    expect(await blobStore.read(HEX)).toStrictEqual(Uint8Array.of(0, 255, 7));
    expect(blob.get).toHaveBeenCalledWith(PATH, { access: "public", abortSignal: expect.any(AbortSignal) });
    blob.get.mockResolvedValueOnce(null);
    expect(await blobStore.read(HEX)).toBeNull();
  });

  it("writes under the hash, public, unsuffixed and never over an existing blob", async () => {
    blob.put.mockResolvedValueOnce({});
    expect(await blobStore.write(HEX, Uint8Array.of(1, 2))).toBe(true);
    const [path, body, options] = blob.put.mock.calls[0] as [string, Buffer, Record<string, unknown>];
    expect(path).toBe(PATH);
    expect(Uint8Array.from(body)).toStrictEqual(Uint8Array.of(1, 2));
    expect(options).toMatchObject({ access: "public", addRandomSuffix: false, allowOverwrite: false, contentType: "application/octet-stream", cacheControlMaxAge: 31_536_000, abortSignal: expect.any(AbortSignal) });
  });

  it("answers false when a refused write finds the blob there, and throws when it does not", async () => {
    const failure = new Error("refused");
    blob.put.mockRejectedValue(failure);
    blob.head.mockResolvedValueOnce({});
    expect(await blobStore.write(HEX, Uint8Array.of(1))).toBe(false);
    blob.head.mockRejectedValueOnce(new blob.BlobNotFoundError());
    await expect(blobStore.write(HEX, Uint8Array.of(1))).rejects.toBe(failure);
  });

  it("knows a blob by its head, says no only when the store says not found, and throws on another failure", async () => {
    blob.head.mockResolvedValueOnce({});
    expect(await blobStore.has(HEX)).toBe(true);
    expect(blob.head).toHaveBeenCalledWith(PATH, { abortSignal: expect.any(AbortSignal) });
    blob.head.mockRejectedValueOnce(new blob.BlobNotFoundError());
    expect(await blobStore.has(HEX)).toBe(false);
    const down = new Error("down");
    blob.head.mockRejectedValueOnce(down);
    await expect(blobStore.has(HEX)).rejects.toBe(down);
  });

  it("marks a path once, never over an existing blob, and throws when a refused mark finds nothing there", async () => {
    blob.put.mockResolvedValueOnce({});
    await blobStore.mark("idle/x");
    const [path, body, options] = blob.put.mock.calls[0] as [string, string, Record<string, unknown>];
    expect([path, body]).toStrictEqual(["idle/x", "1"]);
    expect(options).toMatchObject({ access: "public", addRandomSuffix: false, allowOverwrite: false });
    const failure = new Error("refused");
    blob.put.mockRejectedValue(failure);
    blob.head.mockResolvedValueOnce({});
    await expect(blobStore.mark("idle/x")).resolves.toBeUndefined();
    blob.head.mockRejectedValueOnce(new blob.BlobNotFoundError());
    await expect(blobStore.mark("idle/x")).rejects.toBe(failure);
  });

  it("removes paths in batches of at most 100", async () => {
    blob.del.mockResolvedValue(undefined);
    const paths = Array.from({ length: 205 }, (_, i) => `idle/${i}`);
    await blobStore.remove(paths);
    expect(blob.del.mock.calls.map(([batch]) => (batch as string[]).length)).toStrictEqual([100, 100, 5]);
    expect(blob.del.mock.calls.flatMap(([batch]) => batch as string[])).toStrictEqual(paths);
    await blobStore.remove([]);
    expect(blob.del).toHaveBeenCalledTimes(3);
  });

  it("lists the path, size and upload time under a prefix, and fails closed on a blob without a usable time", async () => {
    blob.list.mockResolvedValueOnce({ blobs: [{ pathname: "idle/a", size: 1, uploadedAt: new Date(5_000) }], hasMore: false });
    expect(await blobStore.list("idle/")).toStrictEqual([{ pathname: "idle/a", size: 1, uploadedAt: 5_000 }]);
    expect(blob.list.mock.calls[0]?.[0]).toMatchObject({ prefix: "idle/" });
    blob.list.mockResolvedValueOnce({ blobs: [{ pathname: "idle/a", size: 1, uploadedAt: new Date(Number.NaN) }], hasMore: false });
    await expect(blobStore.list("idle/")).rejects.toThrow("usable time");
  });
});
