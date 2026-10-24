import { generateKeyPairSync } from "node:crypto";
import { type Address, getAddressDecoder, getProgramDerivedAddress, isOffCurveAddress } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  isOnCurve,
  isSealed,
  MAX_SEALED_RECIPIENTS,
  newEncryptionKeyFile,
  NotInvited,
  OLD_SEALED,
  parseEncryptionKey,
  readEncryptionKeyFile,
  SEALED_LIMIT,
  SEALED_TAG,
  SealedError,
  sealedTo,
  seal,
  unseal,
  x25519PublicOf,
} from "../src/index.js";

function wallet(): { address: Address; keypair: Uint8Array } {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  const keypair = Uint8Array.from([...Buffer.from(jwk.d ?? "", "base64url"), ...Buffer.from(jwk.x ?? "", "base64url")]);
  return { address: getAddressDecoder().decode(keypair.slice(32)), keypair };
}

const text = (s: string) => new TextEncoder().encode(s);
type Entry = { wallet: string; pk: string; epk: string; iv: string; key: string };
const parsed = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as { to: Entry[] } & Record<string, unknown>;
const encoded = (envelope: object) => text(`${JSON.stringify(envelope)}\n`);
const opens = (bytes: Uint8Array, keypair: Uint8Array) => unseal(bytes, keypair).then(() => true, () => false);
const pkOf = (address: Address) => Buffer.from(x25519PublicOf(address)).toString("base64");

describe("the recipient list of a sealed file", () => {
  it("is bound to the sealed data, so a file with a wallet added does not open for anyone", async () => {
    const [a, outsider] = [wallet(), wallet()];
    const sealed = await seal(text("spec"), [a.address]);
    expect(await opens(sealed, a.keypair)).toBe(true);
    const envelope = parsed(sealed);
    const [entry] = envelope.to as [Entry];
    const widened = encoded({ ...envelope, to: [...envelope.to, { ...entry, wallet: outsider.address, pk: pkOf(outsider.address) }] });
    expect(sealedTo(widened)).toEqual([a.address, outsider.address]);
    expect(await opens(widened, a.keypair)).toBe(false);
    expect(await opens(widened, outsider.keypair)).toBe(false);
  });

  it("does not open once a wallet is removed or the wallets are reordered", async () => {
    const [a, b] = [wallet(), wallet()];
    const sealed = await seal(text("spec"), [a.address, b.address]);
    const envelope = parsed(sealed);
    const [first, second] = envelope.to as [Entry, Entry];
    for (const to of [[first], [second], [second, first]]) {
      const changed = encoded({ ...envelope, to });
      expect(await opens(changed, a.keypair)).toBe(false);
      expect(await opens(changed, b.keypair)).toBe(false);
    }
    expect(await opens(sealed, a.keypair)).toBe(true);
    expect(await opens(sealed, b.keypair)).toBe(true);
  });

  it("refuses a list with a wallet twice, no wallet, or more than the most allowed", async () => {
    const a = wallet();
    const envelope = parsed(await seal(text("spec"), [a.address]));
    const [entry] = envelope.to as [Entry];
    const junk = { ...entry, key: Buffer.alloc(48).toString("base64") };
    const many = Array.from({ length: MAX_SEALED_RECIPIENTS + 1 }, () => {
      const address = wallet().address;
      return { ...entry, wallet: address, pk: pkOf(address) };
    });
    for (const to of [[junk, entry], [entry, entry], [], many]) {
      const refused = encoded({ ...envelope, to });
      expect(isSealed(refused)).toBe(true);
      expect(() => sealedTo(refused)).toThrow(SEALED_LIMIT);
      await expect(unseal(refused, a.keypair)).rejects.toThrow(SEALED_LIMIT);
    }
  });

  it("refuses a file in the old format with a message saying to seal it again", async () => {
    const a = wallet();
    const envelope = parsed(await seal(text("spec"), [a.address]));
    const old = encoded({ ...envelope, [SEALED_TAG]: 1, to: envelope.to.map(({ wallet: w, epk, iv, key }) => ({ wallet: w, epk, iv, key })) });
    expect(isSealed(old)).toBe(true);
    expect(() => sealedTo(old)).toThrow(OLD_SEALED);
    await expect(unseal(old, a.keypair)).rejects.toThrow(OLD_SEALED);
    expect(OLD_SEALED).toContain("seal it again");
  });
});

describe("sealing to keys", () => {
  it("refuses an address off the ed25519 curve, such as a program's account", async () => {
    const [pda] = await getProgramDerivedAddress({ programAddress: wallet().address, seeds: ["committee"] });
    const a = wallet();
    expect([isOnCurve(pda), isOnCurve(a.address)]).toEqual([false, true]);
    await expect(seal(text("spec"), [a.address, pda])).rejects.toThrow(`${pda} is off the ed25519 curve`);
  });

  it("agrees with kit on which addresses are on the curve, and refuses non-canonical and signed-zero points", async () => {
    const decode = (bytes: Uint8Array) => getAddressDecoder().decode(bytes);
    const corpus = await Promise.all(Array.from({ length: 256 }, async (_, i) => decode(new Uint8Array(await crypto.subtle.digest("SHA-256", text(`curve ${i}`))))));
    const disagree = await Promise.all(corpus.map(async (a) => (isOnCurve(a) === !(await isOffCurveAddress(a)) ? null : a)));
    expect(disagree.filter((a) => a !== null)).toEqual([]);
    expect(new Set(corpus.map(isOnCurve))).toEqual(new Set([true, false]));
    const yBytes = (y: bigint, sign: number) => Uint8Array.from({ length: 32 }, (_, i) => Number((y >> BigInt(8 * i)) & 0xffn) | (i === 31 ? sign << 7 : 0));
    const p = 2n ** 255n - 19n;
    expect([isOnCurve(decode(yBytes(p, 0))), isOnCurve(decode(yBytes(p + 1n, 0))), isOnCurve(decode(yBytes(p - 1n, 0)))]).toEqual([false, false, true]);
    expect([isOnCurve(decode(yBytes(1n, 0))), isOnCurve(decode(yBytes(1n, 1))), isOnCurve(decode(yBytes(p - 1n, 1)))]).toEqual([true, false, false]);
  });

  it("seals to a published encryption key, which opens it where the wallet key does not", async () => {
    const [judge, other] = [wallet(), wallet()];
    const file = await newEncryptionKeyFile();
    const key = await readEncryptionKeyFile(file.text);
    const sealed = await seal(text("the work"), [{ wallet: judge.address, encryptionKey: parseEncryptionKey(file.publicKey) }, other.address]);
    expect(sealedTo(sealed)).toEqual([judge.address, other.address]);
    expect(new TextDecoder().decode(await unseal(sealed, key))).toBe("the work");
    expect(new TextDecoder().decode(await unseal(sealed, [judge.keypair, key]))).toBe("the work");
    await expect(unseal(sealed, judge.keypair)).rejects.toThrow("open it with that encryption key file");
    expect(await unseal(sealed, (await readEncryptionKeyFile((await newEncryptionKeyFile()).text))).catch((e: unknown) => e)).toBeInstanceOf(NotInvited);
    await expect(unseal(sealed, [])).rejects.toBeInstanceOf(NotInvited);
    await expect(unseal(sealed, [])).rejects.toThrow("none of the keys given is one this was sealed to");
    expect(new TextDecoder().decode(await unseal(sealed, other.keypair))).toBe("the work");
  });

  it("keeps a published key over the wallet key when a wallet is named both ways", async () => {
    const judge = wallet();
    const file = await newEncryptionKeyFile();
    const sealed = await seal(text("x"), [judge.address, { wallet: judge.address, encryptionKey: parseEncryptionKey(file.publicKey) }]);
    expect(sealedTo(sealed)).toEqual([judge.address]);
    expect(await unseal(sealed, await readEncryptionKeyFile(file.text))).toEqual(text("x"));
    await expect(seal(text("x"), [{ wallet: judge.address, encryptionKey: new Uint8Array(31) }])).rejects.toThrow(SealedError);
  });
});
