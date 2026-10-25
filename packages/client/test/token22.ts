import { type Address, AccountRole, generateKeyPairSigner, type Instruction, type KeyPairSigner } from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import { getCreateAssociatedTokenIdempotentInstructionAsync, getInitializeAccount3Instruction, getInitializeMint2Instruction, getMintToInstruction } from "@solana-program/token";
import { findAssociatedTokenAddress } from "@intent-engine/core";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@intent-engine/core/internal";
import { SYSTEM_PROGRAM_ADDRESS } from "../src/accounts.js";
import type { World } from "./svm.js";

const MINT_LEN = 82n;
const ACCOUNT_LEN = 165n;
const REALLOCATE = 29;
const MEMO_TRANSFER_EXTENSION = 8;
const MEMO_TRANSFER = 30;
const ENABLE = 0;
const T22 = { programAddress: TOKEN_2022_PROGRAM_ADDRESS };

export async function mint22(w: World, decimals = 6): Promise<Address> {
  const created = await generateKeyPairSigner();
  await w.chain.transport.send(
    [
      getCreateAccountInstruction({ payer: w.authority, newAccount: created, lamports: w.chain.svm.minimumBalanceForRentExemption(MINT_LEN), space: MINT_LEN, programAddress: TOKEN_2022_PROGRAM_ADDRESS }),
      getInitializeMint2Instruction({ mint: created.address, decimals, mintAuthority: w.authority.address }, T22),
    ],
    w.authority,
  );
  return created.address;
}

export const ata22 = (owner: Address, mint: Address): Promise<Address> => findAssociatedTokenAddress({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });

export async function tokens22(w: World, owner: Address, mint: Address, amount: bigint): Promise<Address> {
  const account = await ata22(owner, mint);
  await w.chain.transport.send(
    [
      await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: w.authority, owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }),
      ...(amount > 0n ? [getMintToInstruction({ mint, token: account, mintAuthority: w.authority, amount }, T22)] : []),
    ],
    w.authority,
  );
  return account;
}

export async function otherAccount22(w: World, owner: Address, mint: Address): Promise<Address> {
  const created = await generateKeyPairSigner();
  await w.chain.transport.send(
    [
      getCreateAccountInstruction({ payer: w.authority, newAccount: created, lamports: w.chain.svm.minimumBalanceForRentExemption(ACCOUNT_LEN), space: ACCOUNT_LEN, programAddress: TOKEN_2022_PROGRAM_ADDRESS }),
      getInitializeAccount3Instruction({ account: created.address, mint, owner }, T22),
    ],
    w.authority,
  );
  return created.address;
}

export async function requireMemos(w: World, owner: KeyPairSigner, account: Address): Promise<void> {
  const reallocate: Instruction = {
    programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    accounts: [
      { address: account, role: AccountRole.WRITABLE },
      { address: w.authority.address, role: AccountRole.WRITABLE_SIGNER, signer: w.authority },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: owner.address, role: AccountRole.READONLY_SIGNER, signer: owner },
    ] as NonNullable<Instruction["accounts"]>,
    data: Uint8Array.of(REALLOCATE, MEMO_TRANSFER_EXTENSION, 0),
  };
  const enable: Instruction = {
    programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    accounts: [
      { address: account, role: AccountRole.WRITABLE },
      { address: owner.address, role: AccountRole.READONLY_SIGNER, signer: owner },
    ] as NonNullable<Instruction["accounts"]>,
    data: Uint8Array.of(MEMO_TRANSFER, ENABLE),
  };
  await w.chain.transport.send([reallocate, enable], w.authority);
}

export function balance22(w: World, account: Address): bigint {
  const found = w.chain.svm.getAccount(account);
  return found.exists ? new DataView(found.data.buffer, found.data.byteOffset).getBigUint64(64, true) : 0n;
}
