import type { Address } from "@solana/kit";
import { sealDeliveryV4 } from "@intent-engine/core/internal";
import { describe, expect, it } from "vitest";

const WORKER = "GXxxgZLrxQFoXzw8kmk8TwGiKXSyaqnc9qvUh665fFjr" as Address;
const INTENT = "11111111111111111111111111111111" as Address;
const URL = "https://raw.githubusercontent.com/MerlijnW70/solive/main/examples/demo/fizzbuzz/solution.mjs";

describe("attestors no delivery can be sealed to", () => {
  for (const [name, attestor] of [
    ["y = 1, the identity", "4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM"],
    ["y at or above the field prime", "JEKNVnkbo3jma5nREBBJCDoXFVeKkD56V3xKrvRmWxD4"],
    ["the point of order 2", "Gx9dDNxzpALCowVuZb7pBceBLJugLA8sPa6TJDXrpfeW"],
  ] as const) {
    it(`make the seal that deliver and its preview run throw for ${name}, so the demo worker's check before claiming refuses the escrow`, async () => {
      await expect(sealDeliveryV4({ source: new Uint8Array(32).fill(7), url: URL, recipients: [attestor as Address] }, INTENT, WORKER)).rejects.toThrow(/has no encryption key|no shared secret can be made/);
    });
  }
});
