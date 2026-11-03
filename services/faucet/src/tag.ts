import {
  AccountRole,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  getBase58Encoder,
  isAddress,
  isBlockhash,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  verifySignature,
  type Address,
  type Blockhash,
  type Instruction,
  type KeyPairSigner,
  type SignatureBytes,
} from "@solana/kit";
import { DRIP_LAMPORTS } from "./limits.js";

export const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;
export const MEMO_PROGRAM = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" as Address;
const TRANSFER = 2;
const SIGNATURE_BYTES = 64;
const LISTED_TAG = /^\[(\d+)\] (drip (\S+) (\S+))$/;

export type Lifetime = { readonly blockhash: Blockhash; readonly lastValidBlockHeight: bigint };

export const dripTag = (recipient: Address, blockhash: Blockhash): string => `drip ${recipient} ${blockhash}`;

function transferInstruction(payer: KeyPairSigner | Address, to: Address): Instruction {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, TRANSFER, true);
  view.setBigUint64(4, DRIP_LAMPORTS, true);
  const from = typeof payer === "string" ? { address: payer, role: AccountRole.WRITABLE_SIGNER } : { address: payer.address, role: AccountRole.WRITABLE_SIGNER, signer: payer };
  return { programAddress: SYSTEM_PROGRAM, accounts: [from, { address: to, role: AccountRole.WRITABLE }], data } as Instruction;
}

const memoInstruction = (text: string): Instruction => ({ programAddress: MEMO_PROGRAM, data: new TextEncoder().encode(text) });

export function dripMessage(payer: KeyPairSigner | Address, recipient: Address, lifetime: Lifetime) {
  const feePayer = typeof payer === "string" ? payer : payer.address;
  return pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(feePayer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(lifetime, m),
    (m) => appendTransactionMessageInstructions([transferInstruction(payer, recipient), memoInstruction(dripTag(recipient, lifetime.blockhash))], m),
  );
}

export type Tag = { readonly recipient: Address; readonly blockhash: Blockhash };

export function tagOf(memo: string | null | undefined): Tag | undefined {
  const match = LISTED_TAG.exec(memo ?? "");
  const [, length, text, recipient, blockhash] = match ?? [];
  if (text === undefined || recipient === undefined || blockhash === undefined) return undefined;
  if (Number(length) !== new TextEncoder().encode(text).length) return undefined;
  if (!isAddress(recipient) || !isBlockhash(blockhash)) return undefined;
  return { recipient, blockhash };
}

export async function ownDrip(faucet: KeyPairSigner, signature: string, memo: string | null | undefined): Promise<boolean> {
  const tag = tagOf(memo);
  if (tag === undefined) return false;
  const message = compileTransaction(dripMessage(faucet.address, tag.recipient, { blockhash: tag.blockhash, lastValidBlockHeight: 0n }));
  try {
    const bytes = getBase58Encoder().encode(signature);
    if (bytes.length !== SIGNATURE_BYTES) return false;
    return await verifySignature(faucet.keyPair.publicKey, bytes as SignatureBytes, message.messageBytes);
  } catch {
    return false;
  }
}
