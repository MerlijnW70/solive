import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REASONS } from "../src/mirror.js";
import { blobStoreWith } from "../src/store.js";
import { errorOf, harness, proofIntent, send, sha } from "./harness.js";

afterEach(() => vi.unstubAllEnvs());

describe("the real blob client against a store answering 503", () => {
  it("gives the uploader the JSON 503 within the time bound, despite the client's retries", async () => {
    let hits = 0;
    const server = createServer((_, response) => {
      hits += 1;
      response.statusCode = 503;
      response.end("{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    vi.stubEnv("VERCEL_BLOB_API_URL", `http://127.0.0.1:${port}`);
    vi.stubEnv("BLOB_READ_WRITE_TOKEN", "vercel_blob_rw_teststore_secret");
    const h = harness();
    h.node.holds(proofIntent(sha("spec")));
    const started = Date.now();
    try {
      const reply = await send({ ...h.deps, store: blobStoreWith(300) }, "PUT", `/sha256/${sha("spec")}`, "spec");
      expect(hits).toBeGreaterThan(0);
      expect(reply.status).toBe(503);
      expect(errorOf(reply)).toBe(REASONS.down);
      expect(reply.headers["content-type"]).toBe("application/json; charset=utf-8");
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10_000);
});
