import { type Address, generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { Kind } from "@intent-engine/core";
import { encodeParams, getIntentDecoder, getIntentSize, INTENT_VERSION } from "@intent-engine/core/internal";
import { intentView } from "../src/agent/shapes.js";

async function attested(specHash: Uint8Array, judgeFee: bigint) {
  const attestor = (await generateKeyPairSigner()).address as Address;
  const intent = {
    ...getIntentDecoder().decode(new Uint8Array(getIntentSize())),
    version: INTENT_VERSION,
    kind: Kind.AttestedResult,
    params: encodeParams({ kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor, specHash, judgeFee }),
  };
  return { attestor, order: intentView(attestor, intent).order };
}

describe("an attested intent's order", () => {
  it("shows a spec hash and judge fee only when a spec is pinned", async () => {
    const plain = await attested(new Uint8Array(32), 0n);
    expect(plain.order).toEqual({ kind: "attested", amount_in: 100n, min_result: 1n, max_result: 1n, attestor: plain.attestor });
    const pinned = await attested(new Uint8Array(32).fill(0xab), 3n);
    expect(pinned.order).toEqual({
      kind: "attested",
      amount_in: 100n,
      min_result: 1n,
      max_result: 1n,
      attestor: pinned.attestor,
      spec_hash: "ab".repeat(32),
      judge_fee: 3n,
    });
  });
});
