import { readFileSync } from "node:fs";
import { cidOfSpecHash } from "@intent-engine/client";
import { describe, expect, it } from "vitest";
import { IMMUTABLE_SECS, REQUEST_DEADLINE_MS, STORE_TIMEOUT_MS } from "../src/limits.js";
import { REASONS } from "../src/mirror.js";
import { errorOf, harness, send, sha } from "./harness.js";

const BYTES = Uint8Array.from([0, 255, 13, 10, 200, 65]);
const HEX = sha(BYTES);

function holding() {
  const h = harness();
  h.store.blobs.set(HEX, BYTES);
  return h;
}

describe("GET /sha256/{hex}", () => {
  it("answers the exact bytes with the binary, nosniff and immutable headers", async () => {
    const reply = await send(holding().deps, "GET", `/sha256/${HEX}`);
    expect(reply.status).toBe(200);
    expect(reply.body).toStrictEqual(BYTES);
    expect(reply.headers).toStrictEqual({
      "content-type": "application/octet-stream",
      "content-length": String(BYTES.length),
      "x-content-type-options": "nosniff",
      "cache-control": `public, max-age=${IMMUTABLE_SECS}, immutable`,
      "access-control-allow-origin": "*",
    });
    expect(IMMUTABLE_SECS).toBeGreaterThanOrEqual(31_536_000);
  });

  it("answers 404 for an unknown hash, and tells caches not to keep that", async () => {
    const reply = await send(holding().deps, "GET", `/sha256/${"a".repeat(64)}`);
    expect(reply.status).toBe(404);
    expect(errorOf(reply)).toBe(REASONS.unknown);
    expect(reply.headers["cache-control"]).toBe("no-store");
  });

  it.each([
    ["uppercase", HEX.toUpperCase()],
    ["short", HEX.slice(1)],
    ["long", `${HEX}0`],
    ["not hex", "g".repeat(64)],
    ["empty", ""],
    ["a newline after it", `${HEX}%0a`],
  ])("answers 400 for %s", async (_, bad) => {
    const reply = await send(holding().deps, "GET", `/sha256/${bad}`);
    expect(reply.status).toBe(400);
    expect(errorOf(reply)).toBe(REASONS.badHash);
  });

  it("answers 405 for a method it does not take, and 404 off its routes", async () => {
    const h = holding();
    const deleted = await send(h.deps, "DELETE", `/sha256/${HEX}`);
    expect(deleted.status).toBe(405);
    expect(deleted.headers["allow"]).toBe("GET, HEAD, PUT");
    expect(h.store.blobs.get(HEX)).toStrictEqual(BYTES);
    expect((await send(h.deps, "GET", "/elsewhere")).status).toBe(404);
  });

  it("answers 503 no-store, and not the bytes, when the store holds bytes of another hash", async () => {
    const h = holding();
    h.store.blobs.set(HEX, Uint8Array.of(1, 2, 3));
    for (const url of [`/sha256/${HEX}`, `/ipfs/${cidOfSpecHash(HEX)}?format=raw`]) {
      const reply = await send(h.deps, "GET", url);
      expect(reply.status).toBe(503);
      expect(errorOf(reply)).toBe(REASONS.corrupt);
      expect(reply.headers["cache-control"]).toBe("no-store");
      expect(reply.headers["content-type"]).toBe("application/json; charset=utf-8");
    }
  });

  it.each(["//", "//evil.example/sha256/abc", "/%", "*"])("answers 404 off its routes for %s", async (url) => {
    const reply = await send(holding().deps, "GET", url);
    expect(reply.status).toBe(404);
    expect(errorOf(reply)).toBe(REASONS.route);
  });

  it("answers the JSON 503 when the answer runs past the deadline", async () => {
    const h = holding();
    h.store.read = () => new Promise(() => undefined);
    const reply = await send({ ...h.deps, deadlineMs: 20 }, "GET", `/sha256/${HEX}`);
    expect(reply.status).toBe(503);
    expect(errorOf(reply)).toBe(REASONS.down);
    expect(reply.headers["content-type"]).toBe("application/json; charset=utf-8");
  });

  it("answers the JSON 503 when the store fails", async () => {
    const h = holding();
    h.store.read = async () => {
      throw new Error("store down");
    };
    const reply = await send(h.deps, "GET", `/sha256/${HEX}`);
    expect(reply.status).toBe(503);
    expect(errorOf(reply)).toBe(REASONS.down);
  });
});

describe("HEAD and CORS on reads", () => {
  it("answers HEAD with the headers of GET and no body, on both routes", async () => {
    const { deps } = holding();
    for (const url of [`/sha256/${HEX}`, `/ipfs/${cidOfSpecHash(HEX)}?format=raw`]) {
      const got = await send(deps, "GET", url);
      const headed = await send(deps, "HEAD", url);
      expect(headed.status).toBe(200);
      expect(headed.headers).toStrictEqual(got.headers);
      expect(headed.body).toHaveLength(0);
    }
    expect((await send(deps, "HEAD", `/sha256/${"a".repeat(64)}`)).status).toBe(404);
    expect((await send(deps, "HEAD", "/sha256/nope")).status).toBe(400);
  });

  it("lets a browser read every answer to a read, and not the answer to a PUT", async () => {
    const { deps } = holding();
    for (const url of [`/sha256/${HEX}`, `/sha256/${"a".repeat(64)}`, "/sha256/nope", `/ipfs/${cidOfSpecHash(HEX)}?format=raw`]) {
      expect((await send(deps, "GET", url)).headers["access-control-allow-origin"]).toBe("*");
    }
    expect((await send(deps, "PUT", `/sha256/${HEX}`, BYTES)).headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("GET /ipfs/{cid}?format=raw", () => {
  it("serves the same bytes and headers as the hex", async () => {
    const { deps } = holding();
    const byHash = await send(deps, "GET", `/sha256/${HEX}`);
    const byCid = await send(deps, "GET", `/ipfs/${cidOfSpecHash(HEX)}?format=raw`);
    expect(byCid).toStrictEqual(byHash);
    expect(byCid.body).toStrictEqual(BYTES);
  });

  it("answers 404 for a good CID of an unknown hash", async () => {
    expect((await send(holding().deps, "GET", `/ipfs/${cidOfSpecHash("a".repeat(64))}?format=raw`)).status).toBe(404);
  });

  it.each([
    ["a CID of another shape", "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG"],
    ["a truncated CID", cidOfSpecHash(HEX).slice(0, -1)],
    ["a hex hash", HEX],
    ["nothing", ""],
  ])("answers 400 for %s", async (_, bad) => {
    const reply = await send(holding().deps, "GET", `/ipfs/${bad}?format=raw`);
    expect(reply.status).toBe(400);
    expect(errorOf(reply)).toBe(REASONS.badCid);
  });

  it("answers 400 without format=raw, and refuses a PUT", async () => {
    const { deps } = holding();
    expect((await send(deps, "GET", `/ipfs/${cidOfSpecHash(HEX)}`)).status).toBe(400);
    const put = await send(deps, "PUT", `/ipfs/${cidOfSpecHash(HEX)}?format=raw`, BYTES);
    expect(put.status).toBe(405);
    expect(put.headers["allow"]).toBe("GET, HEAD");
  });
});

describe("the deployment settings", () => {
  const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as { functions: Record<string, { maxDuration: number }>; headers: { source: string; headers: { key: string; value: string }[] }[] };

  it("sets the content security policy and nosniff on every path", () => {
    const every = config.headers.find((entry) => entry.source === "/(.*)")?.headers ?? [];
    expect(every.find((header) => header.key === "Content-Security-Policy")?.value).toBe("default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    expect(every.find((header) => header.key === "X-Content-Type-Options")?.value).toBe("nosniff");
  });

  it("answers before the platform stops the function, with each store call well inside that", () => {
    const maxMs = (config.functions["api/specs.ts"]?.maxDuration ?? 0) * 1000;
    expect(REQUEST_DEADLINE_MS).toBeLessThan(maxMs);
    expect(STORE_TIMEOUT_MS).toBeLessThan(REQUEST_DEADLINE_MS);
  });
});

describe("the rewrites in vercel.json", () => {
  const { rewrites } = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as { rewrites: { source: string; destination: string }[] };
  const destination = (source: string, value: string): string => {
    const found = rewrites.find((rewrite) => rewrite.source === source)?.destination;
    return String(found).replace(/:(hex|cid)/, value);
  };

  it("reach the same answers as the public paths", async () => {
    const { deps } = holding();
    const hash = await send(deps, "GET", destination("/sha256/:hex", HEX));
    expect(hash.status).toBe(200);
    expect(hash.body).toStrictEqual(BYTES);
    const cid = await send(deps, "GET", `${destination("/ipfs/:cid", cidOfSpecHash(HEX))}&format=raw`);
    expect(cid.status).toBe(200);
    expect(cid.body).toStrictEqual(BYTES);
    expect((await send(deps, "GET", destination("/sha256/:hex", "nope"))).status).toBe(400);
    expect((await send(deps, "GET", "/api/specs")).status).toBe(404);
  });
});
