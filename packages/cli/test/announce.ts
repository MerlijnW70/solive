import { generateKeyPairSync } from "node:crypto";
import { type Address, createKeyPairSignerFromBytes, type KeyPairSigner, lamports } from "@solana/kit";
import { type SealRecipient } from "@intent-engine/core";
import { announcementCommitment, blobLayout, buildAnnounceDelivery, sealDeliveryV4 } from "@intent-engine/core/internal";
import { type Announced, type Transport } from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import { h, transport } from "./harness.js";

export const WORK_URL = "https://" + "example.org/work.tar";

export async function keyed(path?: string): Promise<KeyPairSigner> {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  const keypair = Uint8Array.from([...Buffer.from(jwk.d ?? "", "base64url"), ...Buffer.from(jwk.x ?? "", "base64url")]);
  const signer = await createKeyPairSignerFromBytes(keypair);
  h.svm.airdrop(signer.address, lamports(100_000_000_000n));
  h.keypairs.set(signer.address, keypair);
  if (path !== undefined) {
    h.files.set(path, JSON.stringify(Array.from(keypair)));
  }
  return signer;
}

export function nextSlot(): void {
  h.svm.warpToSlot(h.svm.getClock().slot + 1n);
}

export async function announced(intent: Address, worker: KeyPairSigner, sha256: string, url = WORK_URL, through: Transport = transport): Promise<Announced> {
  nextSlot();
  return createClient({ url: "http://cluster", transport: through }).announce({ worker, intent, sha256, url });
}

export async function griefed(intent: Address, griefer: KeyPairSigner, attestor: Address, recipients: readonly SealRecipient[], sha256: string, committee = false): Promise<Address> {
  nextSlot();
  const blob = await sealDeliveryV4({ source: crypto.getRandomValues(new Uint8Array(32)), url: "https://" + "example.org/grief", recipients }, intent, griefer.address);
  const wrapped = blobLayout(recipients.length, blob.length).wrapped;
  blob[wrapped] = (blob[wrapped] ?? 0) ^ 0xff;
  const commitment = await announcementCommitment(intent, griefer.address, { delivered: Uint8Array.from(Buffer.from(sha256, "hex")), salt: crypto.getRandomValues(new Uint8Array(16)) });
  const { announcement, instruction } = await buildAnnounceDelivery({ worker: griefer, intent, attestor, committee, commitment, blob });
  await createClient({ url: "http://cluster", transport }).send([instruction], griefer);
  return announcement;
}
