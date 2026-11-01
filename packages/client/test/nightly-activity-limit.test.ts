import { describe, expect, it } from "vitest";
import { createClient, type Transport } from "../src/index.js";

const DEVNET = "https://api.devnet.solana.com";

const empty = { signaturesOf: async () => [], transactionsOf: async () => [] } as unknown as Transport;

describe("activity limit lower bound", () => {
  it("accepts a limit of one and refuses zero and below with the range rule", async () => {
    const client = createClient({ url: DEVNET, transport: empty });
    expect((await client.activity({ limit: 1 })).events).toEqual([]);
    for (const limit of [0, -1]) {
      await expect(client.activity({ limit }), String(limit)).rejects.toMatchObject({ code: "invalid-input", field: "limit", rule: "range" });
    }
  });
});
