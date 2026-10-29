import { describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, NATIVE_MINT } from "@intent-engine/core";
import { SIGNATURE_FEE } from "../src/agent/budget.js";
import { costLines, escrowCosts, networkFee, TOTAL } from "../src/agent/wallet/costs.js";
import { preset } from "./agent-wallet-kit.js";
import { transport, world } from "./harness.js";

const sample = { sell: NATIVE_MINT, decimals: 9, fees: [{ what: "fee", lamports: 1_000n }], rent: [{ what: "the escrow account", lamports: 2_000n }], setup: [] };

describe("the cost sums of a send", () => {
  it("charges the signature fee for every signer and adds the priority fee", () => {
    expect(networkFee({ signers: [1, 2, 3], priority_fee_lamports: 7n })).toBe(SIGNATURE_FEE * 3n + 7n);
    expect(networkFee({ signers: [], priority_fee_lamports: 7n })).toBe(7n);
  });

  it("names a single send and a plan by the number of pieces", () => {
    const total = (pieces: number) => costLines(sample, 5n, 10_000n, pieces).find((line) => line.startsWith(TOTAL));
    expect(total(1)).toContain(`${TOTAL}this send takes `);
    expect(total(2)).toContain(`${TOTAL}this plan takes `);
    expect(total(3)).toContain(`${TOTAL}this plan takes `);
  });
});

describe("the setup an escrow needs", () => {
  it("asks for a wrapped SOL account only when the escrow sells SOL", async () => {
    const w = await world();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    const selling = await escrowCosts(transport, { owner: w.owner.address, sell: DEVNET_TEST_MINT, buy: NATIVE_MINT, claims: false });
    expect(selling.setup.map(({ what }) => what)).toStrictEqual(["your engine registration", `your token account for ${NATIVE_MINT}`]);
    const wrapping = await escrowCosts(transport, { owner: w.owner.address, sell: NATIVE_MINT, buy: DEVNET_TEST_MINT, claims: false });
    expect(wrapping.setup.map(({ what }) => what)).toStrictEqual(["your engine registration", `your token account for ${DEVNET_TEST_MINT}`, "your wrapped SOL account"]);
  });
});
