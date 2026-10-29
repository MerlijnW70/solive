import { generateKeyPairSync } from "node:crypto";
import { type Address, getAddressDecoder } from "@solana/kit";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { NotInvited, SealedError } from "../src/index.js";
import { isSealed, MAX_SEALED_RECIPIENTS, SEALED_TAG, SEALED_VERSION, type SealRecipient, sealedTo, seal, unseal, wrapKey, x25519PublicOf, x25519SecretOf } from "../src/internal.js";

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
    expect((refused as NotInvited).message).toBe(`${c.address} is not one of the wallets this was sealed to`);
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

  it("names only tagged envelopes as sealed and refuses any that is malformed or of another version", async () => {
    const a = wallet();
    const sealed = json(await seal(text("x"), [a.address]));
    const encode = (e: unknown) => text(JSON.stringify(e));
    expect(sealed[SEALED_TAG]).toBe(SEALED_VERSION);
    for (const plain of [text("# a plain spec\n"), new Uint8Array([0xff, 0xfe]), text("null"), text("[]"), Uint8Array.from([...text(JSON.stringify(sealed).slice(0, -1)), ...text(',"note":"'), 0xff, ...text('"}')])]) {
      expect(isSealed(plain)).toBe(false);
      expect(() => sealedTo(plain)).toThrow(SealedError);
      expect(await unseal(plain, a.keypair).catch((e: unknown) => e)).toBeInstanceOf(SealedError);
    }
    const future = encode({ ...sealed, [SEALED_TAG]: SEALED_VERSION + 1 });
    expect(() => sealedTo(future)).toThrow("this sealed file has a version this release does not read");
    for (const bad of [
      future,
      encode({ ...sealed, to: "nobody" }),
      encode({ ...sealed, to: (sealed["to"] as Record<string, string>[]).map((r) => ({ ...r, wallet: `${r["wallet"]}0` })) }),
      encode({ ...sealed, data: 7 }),
      encode({ ...sealed, to: [{ wallet: "not-an-address", pk: "", epk: "", iv: "", key: "" }] }),
      encode({ ...sealed, to: [null] }),
      encode({ ...sealed, to: "" }),
      ...(["pk", "epk", "iv", "key"] as const).map((field) => encode({ ...sealed, to: (sealed["to"] as Record<string, string>[]).map((r) => ({ ...r, [field]: 7 })) })),
      ...(["pk", "epk", "iv", "key"] as const).map((field) => encode({ ...sealed, to: (sealed["to"] as Record<string, string>[]).map((r) => ({ ...r, [field]: "AAAA" })) })),
    ]) {
      expect(isSealed(bad)).toBe(true);
      expect(() => sealedTo(bad)).toThrow(SealedError);
      expect(await unseal(bad, a.keypair).catch((e: unknown) => e)).toBeInstanceOf(SealedError);
      if (bad !== future) {
        expect(() => sealedTo(bad)).toThrow("this sealed file is malformed");
      }
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
    const prime = getAddressDecoder().decode(Uint8Array.from([0xed, ...new Array(30).fill(0xff), 0x7f]));
    expect(() => x25519PublicOf(prime)).toThrow(SealedError);
    await expect(seal(text("x"), [identity])).rejects.toThrow(SealedError);
    expect(x25519PublicOf(a.address)).toHaveLength(32);
  });
});

describe("sealed file keys", () => {
  it("keep the encryption key a wallet listed when the same wallet is listed again", async () => {
    const [a, b] = [wallet(), wallet()];
    const key = x25519PublicOf(b.address);
    const pks = async (recipients: SealRecipient[]) => (json(await seal(text("x"), recipients))["to"] as { pk: string }[]).map((entry) => entry.pk);
    const keyed = { wallet: a.address, encryptionKey: key };
    const bare = { wallet: a.address, encryptionKey: null };
    const [keyPk, walletPk] = [Buffer.from(key).toString("base64"), Buffer.from(x25519PublicOf(a.address)).toString("base64")];
    expect(await pks([keyed, a.address])).toEqual([keyPk]);
    expect(await pks([a.address, keyed])).toEqual([keyPk]);
    expect(await pks([keyed, bare])).toEqual([keyPk]);
    expect(await pks([bare, keyed])).toEqual([keyPk]);
    expect(await pks([a.address, bare])).toEqual([walletPk]);
    expect(await pks([bare, a.address])).toEqual([walletPk]);
  });

  it("never make a key extractable while sealing or opening", async () => {
    const [a, b] = [wallet(), wallet()];
    const imports = vi.spyOn(crypto.subtle, "importKey");
    const generated = vi.spyOn(crypto.subtle, "generateKey");
    const derived = vi.spyOn(crypto.subtle, "deriveKey");
    try {
      const sealed = await seal(text("x"), [a.address, { wallet: b.address, encryptionKey: x25519PublicOf(b.address) }]);
      await unseal(sealed, a.keypair);
      const secret = await x25519SecretOf(a.keypair);
      const wrapping = await wrapKey(new Uint8Array(32), new Uint8Array(16));
      expect([secret.extractable, wrapping.extractable]).toEqual([false, false]);
      const flags = (calls: unknown[][], at: number) => calls.map((call) => call[at]);
      const [importFlags, generateFlags, deriveFlags] = [flags(imports.mock.calls, 3), flags(generated.mock.calls, 1), flags(derived.mock.calls, 3)];
      expect([importFlags.length > 4, generateFlags.length, deriveFlags.length > 1]).toEqual([true, 2, true]);
      expect([...importFlags, ...generateFlags, ...deriveFlags].every((flag) => flag === false)).toBe(true);
    } finally {
      imports.mockRestore();
      generated.mockRestore();
      derived.mockRestore();
    }
  });
});
