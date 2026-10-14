import { readFile } from "node:fs/promises";
import { createKeyPairSignerFromBytes, type KeyPairSigner, type TransactionPartialSigner } from "@solana/kit";
import { isLedgerPath, ledgerSigner, type OpenTransport } from "./ledger.js";
import { Refusal } from "./squads.js";

const KEYPAIR_BYTES = 64;

const isKeypairBytes = (value: unknown): value is number[] =>
  Array.isArray(value) && value.length === KEYPAIR_BYTES && value.every((b) => Number.isInteger(b) && b >= 0 && b <= 255);

function parsed(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function readKeypair(path: string): Promise<KeyPairSigner> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Refusal(`cannot read the keypair file ${path}: it is missing or unreadable`);
  }
  const bytes = parsed(text);
  const notKeypair = new Refusal(`the keypair file ${path} is not a keypair: it holds no JSON array of ${KEYPAIR_BYTES} bytes that form a key pair`);
  if (!isKeypairBytes(bytes)) {
    throw notKeypair;
  }
  try {
    return await createKeyPairSignerFromBytes(Uint8Array.from(bytes));
  } catch {
    throw notKeypair;
  }
}

export const readSigner = async (path: string, open?: OpenTransport): Promise<TransactionPartialSigner> =>
  isLedgerPath(path) ? ledgerSigner(path, open) : readKeypair(path);
