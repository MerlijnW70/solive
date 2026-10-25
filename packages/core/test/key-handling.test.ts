import { generateKeyPairSync } from "node:crypto";
import { type Address, getAddressDecoder } from "@solana/kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type DeliverySecrets,
  deliverySecrets,
  newEncryptionKeyFile,
  openDeliveryV4,
  openWithContentKey,
  openWithEsk,
  readEncryptionKeyFile,
  seal,
  sealDeliveryV4,
  unseal,
  wrapKey,
  x25519SecretOf,
} from "../src/internal.js";

type Wallet = { address: Address; keypair: Uint8Array };

function wallet(): Wallet {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  const keypair = Uint8Array.from([...Buffer.from(jwk.d ?? "", "base64url"), ...Buffer.from(jwk.x ?? "", "base64url")]);
  return { address: getAddressDecoder().decode(keypair.slice(32)), keypair };
}

const URL = "https://example.org/work.tar";

const isPair = (value: unknown): value is { privateKey: CryptoKey } => typeof value === "object" && value !== null && "privateKey" in value;

async function keysMadeBy(run: () => Promise<unknown>): Promise<CryptoKey[]> {
  const subtle = crypto.subtle;
  const spies = [vi.spyOn(subtle, "importKey"), vi.spyOn(subtle, "deriveKey"), vi.spyOn(subtle, "generateKey")];
  await run();
  const made = await Promise.allSettled(spies.flatMap((spy) => spy.mock.results.map((result) => result.value as Promise<unknown>)));
  vi.restoreAllMocks();
  return made.flatMap((outcome) => (outcome.status === "fulfilled" ? [isPair(outcome.value) ? outcome.value.privateKey : (outcome.value as CryptoKey)] : []));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("key handling", () => {
  it("never makes a key that can be exported while sealing or opening a file", async () => {
    const [a, b] = [wallet(), wallet()];
    const plain = new TextEncoder().encode("the work");
    let sealed: Uint8Array = new Uint8Array();
    const sealing = await keysMadeBy(async () => {
      sealed = await seal(plain, [a.address, b.address]);
    });
    const opening = await keysMadeBy(async () => {
      expect(await unseal(sealed, b.keypair)).toEqual(plain);
    });
    expect([sealing.length, opening.length].every((n) => n >= 4)).toBe(true);
    expect([...sealing, ...opening].filter((key) => key.extractable)).toEqual([]);
  });

  it("never makes a key that can be exported while sealing or opening a delivery", async () => {
    const [intent, worker] = [wallet().address, wallet().address];
    const judge = wallet();
    const { text } = await newEncryptionKeyFile();
    const reading = await keysMadeBy(() => readEncryptionKeyFile(text));
    const key = await readEncryptionKeyFile(text);
    const recipients = [judge.address, { wallet: wallet().address, encryptionKey: key.publicKey }];
    let secrets: DeliverySecrets | null = null;
    let blob = new Uint8Array();
    const sealing = await keysMadeBy(async () => {
      secrets = await deliverySecrets(URL, recipients);
      blob = await sealDeliveryV4(secrets, intent, worker);
    });
    const kept = secrets as DeliverySecrets | null;
    if (kept === null) {
      throw new Error("nothing was sealed");
    }
    const opening = await keysMadeBy(async () => {
      expect((await openDeliveryV4(blob, judge.keypair, intent, worker))?.url).toBe(URL);
      expect((await openDeliveryV4(blob, key, intent, worker))?.url).toBe(URL);
      expect((await openWithEsk(blob, kept.esk, recipients, intent, worker))?.url).toBe(URL);
      expect((await openWithContentKey(blob, kept.key, intent, worker))?.url).toBe(URL);
    });
    expect([reading.length, sealing.length, opening.length].every((n) => n >= 2)).toBe(true);
    expect([...reading, ...sealing, ...opening].filter((made) => made.extractable)).toEqual([]);
  });

  it("returns wallet secrets and wrapping keys that cannot be exported", async () => {
    const secret = await x25519SecretOf(wallet().keypair);
    const wrapping = await wrapKey(new Uint8Array(32).fill(1), new Uint8Array(16));
    expect([secret.extractable, wrapping.extractable]).toEqual([false, false]);
    expect(wrapping.usages.sort()).toEqual(["decrypt", "encrypt"]);
  });
});
