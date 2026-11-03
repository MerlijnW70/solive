import { homedir } from "node:os";
import { createKeyPairSignerFromBytes, type KeyPairSigner, type TransactionPartialSigner } from "@solana/kit";
import { readKeyFile } from "@intent-engine/client/node";
import { isLedgerPath, ledgerSigner, type OpenTransport } from "./ledger.js";
import { Refusal } from "./squads.js";

const KEYPAIR_BYTES = 64;

export const keypairExposed = (file: string) => `the keypair file ${file} can be read or changed by other users; restrict it with chmod 600`;

export async function readKeypair(path: string, platform: string = process.platform, home: string = homedir()): Promise<KeyPairSigner> {
  const read = await readKeyFile(path, platform, home);
  const notKeypair = new Refusal(`the keypair file ${read.file} is not a keypair: it holds no JSON array of ${KEYPAIR_BYTES} bytes that form a key pair`);
  if (!("bytes" in read)) {
    if (read.problem === "unreadable") {
      throw new Refusal(`cannot read the keypair file ${read.file}: it is missing or unreadable`);
    }
    throw read.problem === "exposed" ? new Refusal(keypairExposed(read.file)) : notKeypair;
  }
  try {
    return await createKeyPairSignerFromBytes(read.bytes);
  } catch {
    throw notKeypair;
  }
}

export const readSigner = async (path: string, open?: OpenTransport): Promise<TransactionPartialSigner> =>
  isLedgerPath(path) ? ledgerSigner(path, open) : readKeypair(path);
