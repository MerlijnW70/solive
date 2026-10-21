import { type Address, generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { Kind } from "@intent-engine/core";
import { askedOf } from "../src/agent/actions.js";
import { neverSettles } from "../src/agent/create.js";
import { servedValue } from "../src/agent/mcp.js";
import { certificateCode, unfundedSend } from "../src/agent/problems.js";
import { InvalidInput } from "../src/agent/schema.js";
import { marketFloor, NO_MARKET } from "../src/agent/wallet/trade.js";
import { poll } from "../src/agent/wallet/wait.js";

const nested = (depth: number, leaf: object): object => (depth === 0 ? leaf : { cause: nested(depth - 1, leaf) });

const looped = (): object => {
  const loop: { cause?: unknown } = {};
  loop.cause = loop;
  return loop;
};

describe("the cause chain readers", () => {
  it("read a certificate code down to the eighth cause and no further, and stop on a loop or a null cause", () => {
    const leaf = { code: "CERT_UNTRUSTED" };
    expect(certificateCode(nested(8, leaf))).toBe("CERT_UNTRUSTED");
    expect(certificateCode(nested(9, leaf))).toBeNull();
    expect(certificateCode(looped())).toBeNull();
    expect(certificateCode({ cause: null })).toBeNull();
    expect(certificateCode(new Error("refused"))).toBeNull();
  });

  it("find an unfunded send down to the eighth cause and no further, and stop on a loop or a null cause", () => {
    const leaf = { context: { __code: 7_050_003 } };
    expect(unfundedSend(nested(8, leaf))).toBe(true);
    expect(unfundedSend(nested(9, leaf))).toBe(false);
    expect(unfundedSend(looped())).toBe(false);
    expect(unfundedSend({ cause: null })).toBe(false);
    expect(unfundedSend(new Error("refused"))).toBe(false);
  });
});

describe("a call's asked key", () => {
  it("sorts keys at every depth and drops undefined fields, send and approval", () => {
    const asked = askedOf("tool", { b: 1, a: { d: 2, c: [{ z: 1, y: undefined, x: 2 }] }, gone: undefined, send: true, approval: "abc" });
    expect(asked).toBe(JSON.stringify(["tool", { a: { c: [{ x: 2, z: 1 }], d: 2 }, b: 1 }]));
    expect(askedOf("tool", { B: 1, a: 2, _: 3 })).toBe('["tool",{"B":1,"_":3,"a":2}]');
  });
});

describe("an escrow no release could settle", () => {
  const config = { feeBps: 5, kindFeeMask: 0, kindFeeBps: [], partnerCutBps: 0 };
  const attested = async (amountIn: bigint, judgeFee: bigint) => ({
    kind: Kind.AttestedResult as const,
    amountIn,
    minResult: 1n,
    maxResult: 1n,
    attestor: (await generateKeyPairSigner()).address as Address,
    specHash: new Uint8Array(32).fill(1),
    judgeFee,
  });

  it("names what the judge fee leaves, and nothing below zero", async () => {
    expect(neverSettles(await attested(3n, 2n), config, 5, 0)).toContain("3 less the 2 judge fee leaves 1, too little for the rounded-up 5 bps protocol fee and 5 bps partner fee");
    expect(neverSettles(await attested(1n, 2n), config, 5, 0)).toContain("1 less the 2 judge fee leaves 0, too little");
    expect(neverSettles(await attested(2n, 2n), config, 5, 0)).toContain("2 less the 2 judge fee leaves 0, too little");
    expect(neverSettles(await attested(4n, 2n), config, 5, 0)).toBeUndefined();
  });
});

describe("served values", () => {
  it("pass anything but a plain object through untouched", () => {
    const names = new Set<string>();
    expect(servedValue("text", names)).toBe("text");
    expect(servedValue(null, names)).toBeNull();
    expect(servedValue([1, 2], names)).toStrictEqual([1, 2]);
    expect(servedValue(7, names)).toBe(7);
  });
});

describe("the market floor", () => {
  const fill = { intent: "11111111111111111111111111111111" as Address, amountIn: 1_000n, delivered: 1n, signature: "s", blockTime: null };

  it("refuses a floor that rounds to zero and takes one of exactly one", () => {
    let refused: unknown;
    try {
      marketFloor([fill], 1n, undefined);
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(InvalidInput);
    expect((refused as InvalidInput).issues).toEqual([{ path: "min_receive", message: NO_MARKET }]);
    expect(marketFloor([fill], 1_011n, undefined)).toBe(1n);
  });
});

describe("polling", () => {
  it("waits at most within seconds while the clock stands still", async () => {
    const sleeps: number[] = [];
    const frozen = { now: () => 0n, sleep: async (seconds: number) => sleeps.push(seconds) > 0 };
    expect(await poll(frozen, 3, async () => false)).toBe(3);
    expect(sleeps).toEqual([1, 1, 1]);
  });

  it("stops once the clock reaches the deadline", async () => {
    let at = 0n;
    const fast = {
      now: () => at,
      sleep: async () => {
        at += 2n;
        return true;
      },
    };
    expect(await poll(fast, 4, async () => false)).toBe(2);
  });
});
