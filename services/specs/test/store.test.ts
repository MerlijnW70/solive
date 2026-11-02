import { beforeEach, describe, expect, it, vi } from "vitest";

const blob = vi.hoisted(() => ({ BlobNotFoundError: class extends Error {}, get: vi.fn(), head: vi.fn(), put: vi.fn() }));
vi.mock("@vercel/blob", () => blob);

const { blobStore, blobStoreWith } = await import("../src/store.js");
const HEX = "a".repeat(64);
const PATH = `sha256/${HEX}`;

beforeEach(() => {
  blob.get.mockReset();
  blob.head.mockReset();
  blob.put.mockReset();
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
});
