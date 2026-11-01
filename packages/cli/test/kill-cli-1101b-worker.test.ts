import { type Address, getBase58Decoder, getBase64Encoder, getU64Encoder } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, NATIVE_MINT } from "@intent-engine/core";
import type { Transport } from "@intent-engine/client";
import { svmTransport } from "@intent-engine/client/svm";
import { DOMAIN, h, world } from "./harness.js";
import { hireWith, ok, preset, server } from "./local-worker-kit.js";

const simulated: Uint8Array[] = [];

const counting = (base: Transport): Transport =>
  new Proxy(base, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (key === "simulate") {
        return (...args: Parameters<Transport["simulate"]>) => {
          simulated.push(Uint8Array.from(getBase64Encoder().encode(args[0])));
          return target.simulate(...args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

const transferData = (lamports: bigint) => [12, 2, 0, 0, 0, ...getU64Encoder().encode(lamports)];

const holds = (wire: Uint8Array, part: number[]) => wire.some((_, at) => part.every((byte, i) => wire[at + i] === byte));

const lamportsOf = (sol: string) => {
  const [whole = "0", fraction = ""] = sol.replace(" SOL", "").split(".");
  return BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, "0"));
};

describe("previewing a local worker", () => {
  it("simulates the zero probe only to budget it, and the funding transfer to budget and to check it", async () => {
    await world();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    h.through = counting(svmTransport(h.svm, { genesisHash: getBase58Decoder().decode(DOMAIN) }));
    const hirer = await server();
    const wallet = (await ok(hirer, "wallet_setup"))["address"] as Address;
    const { intent } = await hireWith(hirer, wallet, false);
    simulated.length = 0;
    const preview = await ok(hirer, "wallet_worker", { intent });
    expect(preview).toMatchObject({ intent, sent: false });
    const funding = lamportsOf(preview["funding"] as string);
    expect(funding).toBeGreaterThan(0n);
    const count = (lamports: bigint) => simulated.filter((wire) => holds(wire, transferData(lamports))).length;
    expect([count(0n), count(funding)]).toEqual([1, 2]);
  }, 60_000);
});
