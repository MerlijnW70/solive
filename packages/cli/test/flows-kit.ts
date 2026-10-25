import { type Address, getBase64Encoder, getTransactionDecoder, type KeyPairSigner, partiallySignTransaction } from "@solana/kit";
import { getTokenDecoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { FailedTransactionMetadata } from "litesvm";
import { findAssociatedTokenAddress } from "@intent-engine/core";
import { h, type World, world } from "./harness.js";

export type Json = Record<string, any>;

export const ESCROW = 400n;

export const allowance = (account: Address) => {
  const view = h.svm.getAccount(account);
  return view.exists ? getTokenDecoder().decode(view.data).delegatedAmount : -1n;
};

export const exists = (address: Address) => h.svm.getAccount(address).exists;

export async function signAndSend(transaction: string, signer: KeyPairSigner): Promise<void> {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(transaction));
  const result = h.svm.sendTransaction(await partiallySignTransaction([signer.keyPair], tx));
  if (result instanceof FailedTransactionMetadata) {
    throw new Error(result.toString());
  }
}

export async function ataOf(owner: Address, mint: Address): Promise<Address> {
  return findAssociatedTokenAddress({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
}

export const flowCreate = (w: World, kind: string, ...rest: string[]) => [
  "create",
  kind,
  "--keypair",
  "owner.json",
  "--input-mint",
  w.inputMint,
  "--output-mint",
  w.outputMint,
  "--expires-in",
  "3600",
  ...(rest.includes("--units") ? [] : ["--units", "raw"]),
  ...rest,
];

export async function flowWorld(): Promise<{ w: World; keys: Record<string, KeyPairSigner> }> {
  const w = await world();
  h.files.clear();
  for (const name of Object.keys(h.env)) {
    delete h.env[name];
  }
  return { w, keys: { "owner.json": w.owner, "admin.json": w.authority } };
}
