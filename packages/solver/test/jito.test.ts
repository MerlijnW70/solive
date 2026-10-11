import type { Base64EncodedWireTransaction } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { type Fetch, JITO_TIP_ACCOUNTS, jitoBundles, MAX_BUNDLE, tipAccount } from "../src/index.js";

const wire = (n: number) => `AQ${n}` as Base64EncodedWireTransaction;

function engine(status: number, body: unknown) {
  const calls: { url: string; body: string }[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, body: init?.body ?? "" });
    return { ok: status === 200, status, json: async () => body };
  };
  return { fetch, calls };
}

describe("jito bundles", () => {
  it("sends a bundle as base64 json-rpc and returns its id", async () => {
    const e = engine(200, { jsonrpc: "2.0", id: 1, result: "bundle-id" });
    const send = jitoBundles({ url: "https://engine.example", fetch: e.fetch });
    await expect(send([wire(1), wire(2)])).resolves.toBe("bundle-id");
    expect(e.calls[0]?.url).toBe("https://engine.example/api/v1/bundles");
    expect(JSON.parse(e.calls[0]?.body ?? "{}")).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "sendBundle",
      params: [[wire(1), wire(2)], { encoding: "base64" }],
    });
  });

  it("reports rejections and refuses bundles outside one to five transactions", async () => {
    const run = (status: number, body: unknown) => jitoBundles({ url: "u", fetch: engine(status, body).fetch })([wire(1)]);
    await expect(run(429, {})).rejects.toThrow("jito rejected the bundle with status 429");
    await expect(run(200, { error: { message: "bundle too large" } })).rejects.toThrow(
      "jito rejected the bundle: bundle too large",
    );
    await expect(run(200, { error: { code: 1 } })).rejects.toThrow("jito rejected the bundle: no bundle id returned");
    await expect(run(200, { result: 7 })).rejects.toThrow("jito rejected the bundle: no bundle id returned");
    const send = jitoBundles({ url: "u", fetch: engine(200, { result: "id" }).fetch });
    expect(MAX_BUNDLE).toBe(5);
    await expect(send([])).rejects.toThrow("a bundle holds 1 to 5 transactions, got 0");
    await expect(send(Array.from({ length: 6 }, (_, i) => wire(i)))).rejects.toThrow(RangeError);
    await expect(send(Array.from({ length: 5 }, (_, i) => wire(i)))).resolves.toBe("id");
  });

  it("spreads tips over the eight tip accounts", () => {
    expect(JITO_TIP_ACCOUNTS).toHaveLength(8);
    expect(new Set(JITO_TIP_ACCOUNTS).size).toBe(8);
    expect(tipAccount(0)).toBe(JITO_TIP_ACCOUNTS[0]);
    expect(tipAccount(9)).toBe(JITO_TIP_ACCOUNTS[1]);
    expect(tipAccount(7)).toBe(JITO_TIP_ACCOUNTS[7]);
    for (const bad of [-1, 1.5]) {
      expect(() => tipAccount(bad)).toThrow(`tip entropy must be a non-negative integer, got ${bad}`);
    }
  });
});
