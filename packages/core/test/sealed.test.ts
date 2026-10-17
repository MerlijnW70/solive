import { generateKeyPairSync } from "node:crypto";
import { type Address, getAddressDecoder } from "@solana/kit";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isSealed, MAX_SEALED_RECIPIENTS, NotInvited, SEALED_TAG, SEALED_VERSION, SealedError, sealedTo, seal, unseal, x25519PublicOf } from "../src/index.js";

function wallet(): { address: Address; keypair: Uint8Array } {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  const keypair = Uint8Array.from([...Buffer.from(jwk.d ?? "", "base64url"), ...Buffer.from(jwk.x ?? "", "base64url")]);
  return { address: getAddressDecoder().decode(keypair.slice(32)), keypair };
}

const text = (s: string) => new TextEncoder().encode(s);
const json = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;

describe("sealed files", () => {
  it("open for every wallet they were sealed to and for no other", async () => {
    const [a, b, c] = [wallet(), wallet(), wallet()];
    const plain = text("write answer.txt holding 42\n");
    const sealed = await seal(plain, [a.address, b.address, a.address]);
    expect(isSealed(sealed)).toBe(true);
    expect(sealedTo(sealed)).toEqual([a.address, b.address]);
    expect(await unseal(sealed, a.keypair)).toEqual(plain);
    expect(await unseal(sealed, b.keypair)).toEqual(plain);
    const refused = await unseal(sealed, c.keypair).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(NotInvited);
    expect((refused as NotInvited).wallet).toBe(c.address);
    expect(new TextDecoder().decode(sealed)).not.toContain("answer.txt");
  });

  it("round-trips any bytes for any set of wallets", async () => {
    const pool = Array.from({ length: 5 }, wallet);
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 4096 }), fc.subarray(pool, { minLength: 1 }), async (plain, chosen) => {
        const sealed = await seal(plain, chosen.map((w) => w.address));
        for (const w of chosen) {
          expect(await unseal(sealed, w.keypair)).toEqual(plain);
        }
      }),
      { numRuns: 20 },
    );
  });

  it("carries a file of a mebibyte", async () => {
    const w = wallet();
    const big = new Uint8Array(1_048_576);
    for (let at = 0; at < big.length; at += 65_536) {
      crypto.getRandomValues(big.subarray(at, at + 65_536));
    }
    expect(Buffer.from(await unseal(await seal(big, [w.address]), w.keypair)).equals(Buffer.from(big))).toBe(true);
  }, 60_000);

  it("refuses a sealed file whose data, key or wallet entry was changed", async () => {
    const [a, b] = [wallet(), wallet()];
    const sealed = json(await seal(text("the spec"), [a.address]));
    const encode = (e: unknown) => text(JSON.stringify(e));
    const data = Buffer.from(sealed["data"] as string, "base64");
    data[0] = (data[0] ?? 0) ^ 1;
    const changed = [
      { ...sealed, data: data.toString("base64") },
      { ...sealed, to: (sealed["to"] as Record<string, string>[]).map((r) => ({ ...r, key: Buffer.from(Buffer.from(r["key"] ?? "", "base64").map((x, i) => (i === 0 ? x ^ 1 : x))).toString("base64") })) },
      { ...sealed, to: (sealed["to"] as Record<string, string>[]).map((r) => ({ ...r, epk: Buffer.alloc(32, 9).toString("base64") })) },
    ];
    for (const envelope of changed) {
      const error = await unseal(encode(envelope), a.keypair).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SealedError);
      expect(error).not.toBeInstanceOf(NotInvited);
    }
    const stolen = { ...sealed, to: (sealed["to"] as Record<string, string>[]).map((r) => ({ ...r, wallet: b.address })) };
    expect(await unseal(encode(stolen), b.keypair).catch((e: unknown) => e)).toBeInstanceOf(SealedError);
  });

  it("names only well formed envelopes of its version as sealed", async () => {
    const a = wallet();
    const sealed = json(await seal(text("x"), [a.address]));
    const encode = (e: unknown) => text(JSON.stringify(e));
    expect(sealed[SEALED_TAG]).toBe(SEALED_VERSION);
    for (const bad of [
      text("# a plain spec\n"),
      new Uint8Array([0xff, 0xfe]),
      text("null"),
      encode({ ...sealed, [SEALED_TAG]: SEALED_VERSION + 1 }),
      encode({ ...sealed, to: "nobody" }),
      encode({ ...sealed, data: 7 }),
      encode({ ...sealed, to: [{ wallet: "not-an-address", epk: "", iv: "", key: "" }] }),
      encode({ ...sealed, to: [null] }),
    ]) {
      expect(isSealed(bad)).toBe(false);
      expect(() => sealedTo(bad)).toThrow(SealedError);
      expect(await unseal(bad, a.keypair).catch((e: unknown) => e)).toBeInstanceOf(SealedError);
    }
  });

  it("seals to one to the maximum number of wallets, from a whole wallet key, to wallets that have an encryption key", async () => {
    const a = wallet();
    await expect(seal(text("x"), [])).rejects.toThrow(SealedError);
    const many = Array.from({ length: MAX_SEALED_RECIPIENTS + 1 }, () => wallet().address);
    await expect(seal(text("x"), many)).rejects.toThrow(SealedError);
    expect(sealedTo(await seal(text("x"), many.slice(0, MAX_SEALED_RECIPIENTS)))).toHaveLength(MAX_SEALED_RECIPIENTS);
    await expect(unseal(await seal(text("x"), [a.address]), a.keypair.slice(0, 32))).rejects.toThrow(SealedError);
    const identity = getAddressDecoder().decode(Uint8Array.from([1, ...new Array(31).fill(0)]));
    expect(() => x25519PublicOf(identity)).toThrow(SealedError);
    await expect(seal(text("x"), [identity])).rejects.toThrow(SealedError);
    expect(x25519PublicOf(a.address)).toHaveLength(32);
  });
});
