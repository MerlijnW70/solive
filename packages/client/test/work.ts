import { createHash, generateKeyPairSync } from "node:crypto";
import { type Address, createKeyPairSignerFromBytes, generateKeyPairSigner, type KeyPairSigner, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize } from "@solana-program/token";
import { findAssociatedTokenAddress, NATIVE_MINT, TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import type { Client, ReleaseOpening } from "../src/index.js";
import type { World } from "./svm.js";

export const SOL = 1_000_000_000n;
export const LOCAL = "http://127.0.0.1:8899";

export const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

export const specHash = (text: string): Uint8Array => new Uint8Array(createHash("sha256").update(text).digest());

export const workUrl = (name = "work.tar"): string => "https://" + "example.org/" + name;

export function nativeMint(w: World): void {
  const space = BigInt(getMintSize());
  w.chain.svm.setAccount({
    address: NATIVE_MINT,
    data: Uint8Array.from(getMintEncoder().encode({ mintAuthority: none(), supply: 0n, decimals: 9, isInitialized: true, freezeAuthority: none() })),
    executable: false,
    lamports: lamports(w.chain.svm.minimumBalanceForRentExemption(space)),
    programAddress: TOKEN_PROGRAM_ADDRESS,
    space,
  });
}

export async function fundedSigner(w: World, sol = 10n): Promise<KeyPairSigner> {
  const signer = await generateKeyPairSigner();
  if (sol > 0n) {
    w.chain.svm.airdrop(signer.address, lamports(sol * SOL));
  }
  return signer;
}

export type Keyed = { signer: KeyPairSigner; keypair: Uint8Array };

export async function keypairSigner(): Promise<Keyed> {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  const keypair = Uint8Array.from([...Buffer.from(jwk.d ?? "", "base64url"), ...Buffer.from(jwk.x ?? "", "base64url")]);
  return { signer: await createKeyPairSignerFromBytes(keypair), keypair };
}

export async function keyed(w: World, sol = 10n): Promise<Keyed> {
  const made = await keypairSigner();
  w.chain.svm.airdrop(made.signer.address, lamports(sol * SOL));
  return made;
}

export async function tokensOf(w: World, owner: Address, mint: Address = NATIVE_MINT): Promise<bigint | null> {
  const found = w.chain.svm.getAccount(await findAssociatedTokenAddress({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS }));
  return found.exists ? new DataView(found.data.buffer, found.data.byteOffset).getBigUint64(64, true) : null;
}

export type Delivered = { announcement: Address; opening: ReleaseOpening; seq: bigint };

export async function announced(client: Client, worker: KeyPairSigner, intent: Address, sha256: string, url = workUrl()): Promise<Delivered> {
  const done = await client.announce({ worker, intent, sha256, url });
  return { announcement: done.announcement, opening: { sha256, salt: done.salt }, seq: done.seq };
}

export const nextSlot = (w: World): void => {
  w.chain.svm.warpToSlot(w.chain.svm.getClock().slot + 1n);
};
