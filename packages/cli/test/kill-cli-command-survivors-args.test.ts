import { getAddressDecoder } from "@solana/kit";
import { formatAmount } from "@intent-engine/core";
import { MAX_CLAIM_STAKE, MAX_CLAIMANTS, MIN_CLAIM_STAKE, U64_MAX } from "@intent-engine/core/internal";
import { describe, expect, it } from "vitest";
import { parse } from "../src/args.js";
import { HELD_NEEDS_ANNOUNCEMENT } from "../src/arg-announce.js";
import { SOL_AMOUNT, solLamports, SPLIT_SHAPE, splitOf } from "../src/arg-values.js";
import { STAKE_FORMAT, WORKERS_LIMIT } from "../src/trust-args.js";
import { usage } from "./args-kit.js";

const wallet = (seed: number) => getAddressDecoder().decode(new Uint8Array(32).fill(seed));

const split = (recipients: string | undefined, weights: string | undefined) => splitOf({ recipients, weights } as never);

const open = (extra: string[]) => ["claims", "open", "--keypair", "k.json", "--nonce", "1", "--max-secs", "60", ...extra];

describe("claim-held arguments", () => {
  it("refuses --yes without an announcement, and parses without it", () => {
    expect(usage(["claim-held", "--keypair", "k.json", "--yes"])).toBe(HELD_NEEDS_ANNOUNCEMENT);
    expect(parse(["claim-held", "--keypair", "k.json"])).toMatchObject({ name: "claim-held", yes: false });
  });
});

describe("split arguments", () => {
  const two = wallet(1) + "," + wallet(2);

  it("needs recipients and weights together", () => {
    expect(split(undefined, undefined)).toStrictEqual({});
    expect(() => split(two, undefined)).toThrow(SPLIT_SHAPE);
    expect(() => split(undefined, "5000,5000")).toThrow(SPLIT_SHAPE);
  });

  it("needs one weight per recipient and weights that add up to the whole", () => {
    expect(split(two, "6000,4000")).toStrictEqual({ split: { recipients: [wallet(1), wallet(2)], weights: [6000, 4000] } });
    expect(split(wallet(1), "10000")).toStrictEqual({ split: { recipients: [wallet(1)], weights: [10000] } });
    expect(() => split(two, "10000")).toThrow(SPLIT_SHAPE);
    expect(() => split(wallet(1), "5000,5000")).toThrow(SPLIT_SHAPE);
    expect(() => split(two, "5000,4999")).toThrow(SPLIT_SHAPE);
    expect(() => split(two, "5000,5001")).toThrow(SPLIT_SHAPE);
  });
});

describe("sol amounts", () => {
  const amount = (text: string) => solLamports({ amount: text } as never, "amount");

  it("refuses zero and accepts the smallest unit", () => {
    expect(() => amount("0")).toThrow(SOL_AMOUNT);
    expect(() => amount("0.000000000")).toThrow(SOL_AMOUNT);
    expect(amount("0.000000001")).toBe(1n);
    expect(amount(formatAmount(U64_MAX, 9))).toBe(U64_MAX);
    expect(() => amount(formatAmount(U64_MAX + 1n, 9))).toThrow(SOL_AMOUNT);
  });
});

describe("claim stake and worker limits", () => {
  const stake = (text: string) => parse(open(["--stake", text]));

  it("accepts zero, the minimum and the maximum stake, and refuses just outside them", () => {
    expect(stake("0")).toMatchObject({ stake: 0n });
    expect(stake(formatAmount(MIN_CLAIM_STAKE, 9))).toMatchObject({ stake: MIN_CLAIM_STAKE });
    expect(stake(formatAmount(MAX_CLAIM_STAKE, 9))).toMatchObject({ stake: MAX_CLAIM_STAKE });
    for (const bad of [formatAmount(MIN_CLAIM_STAKE - 1n, 9), formatAmount(MAX_CLAIM_STAKE + 1n, 9), "0.0000000001"]) {
      expect(usage(open(["--stake", bad]))).toBe(STAKE_FORMAT);
    }
  });

  it("states the largest stake in whole SOL", () => {
    expect(STAKE_FORMAT).toBe("--stake is SOL, 0 or from 0.00089088 (the rent-exempt minimum of a wallet) to 100, with at most 9 decimals, such as 0.01");
  });

  it("accepts the most listed workers the program takes and refuses one more", () => {
    const list = (count: number) => Array.from({ length: count }, (_, i) => wallet(i + 1)).join(",");
    expect(parse(open(["--stake", "0", "--workers", list(MAX_CLAIMANTS)]))).toMatchObject({ name: "claims-open" });
    expect(usage(open(["--stake", "0", "--workers", list(MAX_CLAIMANTS + 1)]))).toBe(WORKERS_LIMIT);
  });
});
