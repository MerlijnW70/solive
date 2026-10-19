import { generateKeyPairSync } from "node:crypto";
import { type Address, createKeyPairSignerFromBytes, type KeyPairSigner, lamports } from "@solana/kit";
import { deliveryMemoV2, sealUrl } from "@intent-engine/core";
import { commitmentOf } from "@intent-engine/client";
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

export const announcement = (intent: Address, worker: Address, sha256: string, blob: string): string =>
  deliveryMemoV2({ intent, commitment: commitmentOf(intent, worker, sha256), blob });

export async function sealedDelivery(intent: Address, worker: Address, sha256: string, url: string, sealedTo: readonly Address[]): Promise<string> {
  return announcement(intent, worker, sha256, await sealUrl(url, sealedTo, intent));
}
