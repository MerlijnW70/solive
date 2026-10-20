import { createHash, generateKeyPairSync } from "node:crypto";
import { type Address, createKeyPairSignerFromBytes, type KeyPairSigner, lamports } from "@solana/kit";
import { deliveryMemo, type SealRecipient, sealDelivery } from "@intent-engine/core";
import { commitmentOf, saltCheckOf } from "@intent-engine/client";
import { h } from "./harness.js";

export async function keyed(path?: string): Promise<KeyPairSigner> {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  const keypair = Uint8Array.from([...Buffer.from(jwk.d ?? "", "base64url"), ...Buffer.from(jwk.x ?? "", "base64url")]);
  const signer = await createKeyPairSignerFromBytes(keypair);
  h.svm.airdrop(signer.address, lamports(100_000_000_000n));
  if (path !== undefined) {
    h.files.set(path, JSON.stringify(Array.from(keypair)));
  }
  return signer;
}

export const saltFor = (intent: Address): string => createHash("sha256").update(`test salt ${intent}`).digest("hex").slice(0, 32);

export const announcement = (intent: Address, worker: Address, sha256: string, blob: string): string => {
  const salt = saltFor(intent);
  return deliveryMemo({ intent, commitment: commitmentOf(intent, worker, salt, sha256), check: saltCheckOf(salt), blob });
};

export const sealedBlob = (intent: Address, url: string, sealedTo: readonly SealRecipient[]): Promise<string> => sealDelivery({ salt: saltFor(intent), url }, sealedTo, intent);

export async function sealedDelivery(intent: Address, worker: Address, sha256: string, url: string, sealedTo: readonly SealRecipient[]): Promise<string> {
  return announcement(intent, worker, sha256, await sealedBlob(intent, url, sealedTo));
}
