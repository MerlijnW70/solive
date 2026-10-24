import { type Address, createNoopSigner, type Instruction, type TransactionSigner } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { getCreateAssociatedTokenIdempotentInstructionAsync, getSyncNativeInstruction, getTokenDecoder } from "@solana-program/token";
import { buildInitUser, findAssociatedTokenAddress, NATIVE_MINT, TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import { createdAccount, type NonceWindow } from "./accounts.js";
import type { Transport } from "./transport.js";

export type Owner = Address | TransactionSigner;

const signerOf = (owner: Owner): TransactionSigner => (typeof owner === "string" ? createNoopSigner(owner) : owner);
const addressOf = (owner: Owner): Address => (typeof owner === "string" ? owner : owner.address);

export async function initUserIfMissing(user: NonceWindow | null, owner: Owner): Promise<Instruction[]> {
  return user === null ? [await buildInitUser({ owner: signerOf(owner) })] : [];
}

export type TokenAccountSetup = { address: Address; create: Instruction[] };

export async function tokenAccountIfMissing(
  transport: Transport,
  payer: TransactionSigner,
  owner: Address,
  mint: Address,
  tokenProgram: Address,
): Promise<TokenAccountSetup> {
  const address = await findAssociatedTokenAddress({ owner, mint, tokenProgram });
  const create =
    (await createdAccount(transport, address)) === null
      ? [await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner, mint, tokenProgram })]
      : [];
  return { address, create };
}

export type Wrap = { instructions: Instruction[]; lamports: bigint };

export async function wrapIfShort(
  transport: Transport,
  owner: Owner,
  mint: Address,
  tokenProgram: Address,
  needed: bigint,
): Promise<Wrap> {
  if (mint !== NATIVE_MINT || tokenProgram !== TOKEN_PROGRAM_ADDRESS) {
    return { instructions: [], lamports: 0n };
  }
  const holder = addressOf(owner);
  const account = await findAssociatedTokenAddress({ owner: holder, mint, tokenProgram });
  const view = await createdAccount(transport, account);
  const held = view === null ? 0n : getTokenDecoder().decode(view.data).amount;
  if (held >= needed) {
    return { instructions: [], lamports: 0n };
  }
  const payer = signerOf(owner);
  return {
    instructions: [
      ...(view === null ? [await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner: holder, mint, tokenProgram })] : []),
      getTransferSolInstruction({ source: payer, destination: account, amount: needed - held }),
      getSyncNativeInstruction({ account }),
    ],
    lamports: needed - held,
  };
}
