import { generateKeyPairSync } from "node:crypto";
import { type Address, createNoopSigner, getAddressDecoder } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { IntentCoreError, isSdkError } from "../src/index.js";
import {
  buildClaimHeld,
  buildEd25519BatchInstruction,
  buildSetAnnounceFee,
  buildSyncCommitteeKeys,
  delivery,
  I64_MAX,
  I64_MIN,
  MAX_CREATE_FEE,
  seal,
  sealedTo,
  U64_MAX,
} from "../src/internal.js";
import { InvalidInput } from "../src/errors.js";

const address = (n: number): Address => getAddressDecoder().decode(new Uint8Array(32).fill(n));
const wallets = (count: number): Address[] => Array.from({ length: count }, (_, i) => address(i + 1));

async function refusal(run: () => unknown): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return null;
}

const refused = (error: unknown, field: string, rule: string) => {
  expect(error).toBeInstanceOf(InvalidInput);
  expect(error).toMatchObject({ field, rule });
};

describe("announce fee bounds", () => {
  it("accepts zero and the maximum and refuses one past either end", async () => {
    const admin = createNoopSigner(address(9));
    expect((await buildSetAnnounceFee({ admin, fee: 0 })).data).toBeDefined();
    expect((await buildSetAnnounceFee({ admin, fee: MAX_CREATE_FEE })).data).toBeDefined();
    for (const fee of [-1, MAX_CREATE_FEE + 1, 0.5, Number.NaN]) {
      refused(await refusal(() => buildSetAnnounceFee({ admin, fee })), "fee", "range");
    }
  });
});

describe("committee key sync bounds", () => {
  it("accepts one to eight distinct members and refuses none, nine and repeats", async () => {
    const committee = address(99);
    for (const count of [1, 8]) {
      const ix = await buildSyncCommitteeKeys({ committee, members: wallets(count) });
      expect(ix.accounts.length).toBeGreaterThan(count);
    }
    for (const members of [[], wallets(9), [address(1), address(1)]]) {
      refused(await refusal(() => buildSyncCommitteeKeys({ committee, members })), "members", "range");
    }
  });
});

describe("announcement close and refute bounds", () => {
  it("accepts the whole i64 range for every time and refuses one past either end", () => {
    const [low, high] = [I64_MIN, I64_MAX];
    for (const edge of [low, high]) {
      expect(() => delivery.closable("announced", true, false, edge, 0n, 0n)).not.toThrow();
      expect(() => delivery.closable("announced", true, false, 0n, edge, 0n)).not.toThrow();
      expect(() => delivery.closable("announced", true, false, 0n, 0n, edge)).not.toThrow();
    }
    for (const bad of [low - 1n, high + 1n]) {
      expect(() => delivery.closable("announced", true, false, bad, 0n, 0n)).toThrow(InvalidInput);
      expect(() => delivery.closable("announced", true, false, 0n, bad, 0n)).toThrow(InvalidInput);
      expect(() => delivery.closable("announced", true, false, 0n, 0n, bad)).toThrow(InvalidInput);
    }
  });

  it("accepts sequence numbers from zero to the u64 maximum and refuses one past either end", () => {
    const payee = address(3);
    expect(() => delivery.refutes(0n, 1n, address(1), [payee])).not.toThrow();
    expect(() => delivery.refutes(U64_MAX - 1n, U64_MAX, address(1), [payee])).not.toThrow();
    for (const [earlier, paid] of [[-1n, 1n], [0n, U64_MAX + 1n], [-1n, U64_MAX + 1n]] as const) {
      expect(() => delivery.refutes(earlier, paid, address(1), [payee])).toThrow(InvalidInput);
    }
    expect(() => delivery.refutes(1n, 1n, address(1), [payee])).toThrow(IntentCoreError);
  });
});

describe("ed25519 batch message bound", () => {
  it("accepts a message of 65535 bytes and refuses 65536", () => {
    const entries = [{ publicKey: address(1), signature: new Uint8Array(64) }];
    expect(buildEd25519BatchInstruction({ entries, message: new Uint8Array(0xffff) }).data?.length).toBe(2 + 14 + 32 + 64 + 0xffff);
    expect(() => buildEd25519BatchInstruction({ entries, message: new Uint8Array(0x10000) })).toThrow(InvalidInput);
  });
});

describe("sdk error check", () => {
  it("names only branded errors, optionally of one code", () => {
    const brand = Symbol.for("@intent-engine/sdk-error");
    const branded = new InvalidInput("x", "range", "x");
    expect(isSdkError(branded)).toBe(true);
    expect(isSdkError(branded, "invalid-input")).toBe(true);
    expect(isSdkError(branded, "sealed-error")).toBe(false);
    expect(isSdkError(new Error("plain"))).toBe(false);
    expect(isSdkError(new Error("plain"), "invalid-input")).toBe(false);
    expect(isSdkError({ [brand]: true })).toBe(false);
    expect(isSdkError(Object.assign(new Error("fake"), { [brand]: true }))).toBe(true);
    expect(isSdkError(Object.assign(new Error("fake"), { [brand]: false }))).toBe(false);
    expect(isSdkError(null)).toBe(false);
  });
});

describe("claim_held index and recipient bounds", () => {
  const base = (recipients: Address[], index: number) => ({
    wallet: createNoopSigner(recipients[index] ?? address(200)),
    intent: address(50),
    announcement: address(51),
    to: address(52),
    inputMint: address(53),
    inputTokenProgram: address(54),
    index,
    recipients,
    weights: recipients.map(() => 1),
  });

  it("accepts one to eight recipients and an index from zero to the last", async () => {
    const eight = wallets(8);
    expect(await buildClaimHeld(base(wallets(1), 0))).toBeDefined();
    expect(await buildClaimHeld(base(eight, 0))).toBeDefined();
    expect(await buildClaimHeld(base(eight, 7))).toBeDefined();
  });

  it("refuses no recipients, nine, and an index outside the split by its field", async () => {
    refused(await refusal(() => buildClaimHeld(base([], 0))), "recipients", "range");
    refused(await refusal(() => buildClaimHeld(base(wallets(9), 0))), "recipients", "range");
    const two = wallets(2);
    for (const index of [-1, 2, 1.5, Number.NaN]) {
      refused(await refusal(() => buildClaimHeld({ ...base(two, 0), index })), "index", "range");
    }
  });
});

describe("sealed file envelope", () => {
  it("is refused when only its nonce or only its data is not valid base64", async () => {
    const wallet = getAddressDecoder().decode(Uint8Array.from(Buffer.from(generateKeyPairSync("ed25519").publicKey.export({ format: "jwk" }).x ?? "", "base64url")));
    const envelope = JSON.parse(new TextDecoder().decode(await seal(new Uint8Array([1]), [wallet]))) as Record<string, unknown>;
    expect(sealedTo(new TextEncoder().encode(JSON.stringify(envelope)))).toEqual([wallet]);
    for (const changed of [{ iv: "AAAA" }, { data: "AAAA!" }, { iv: 7 }, { data: 7 }, { iv: "AAAA", data: "AAAA!" }]) {
      const bytes = new TextEncoder().encode(JSON.stringify({ ...envelope, ...changed }));
      expect(() => sealedTo(bytes), JSON.stringify(changed)).toThrow("this sealed file is malformed");
    }
  });
});
