import { type Address, AccountRole, createKeyPairSignerFromBytes, generateKeyPairSigner, type Instruction, type KeyPairSigner } from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import { getCreateAssociatedTokenIdempotentInstructionAsync, getInitializeAccount3Instruction, getInitializeMint2Instruction, getMintToInstruction } from "@solana-program/token";
import { findAssociatedTokenAddress, Kind } from "@intent-engine/core";
import { findIntentPda, signMessageBytes, splitFee, splitN, TOKEN_2022_PROGRAM_ADDRESS } from "@intent-engine/core/internal";
import { createClient } from "@intent-engine/client/node";
import { SYSTEM_PROGRAM_ADDRESS } from "@intent-engine/client/internal";
import type { Transport } from "@intent-engine/client";
import { announced, keyed } from "./announce.js";
import { FEE_BPS, funded, h, mint as plainMint, send, transport } from "./harness.js";

const T22 = { programAddress: TOKEN_2022_PROGRAM_ADDRESS };
const MINT_LEN = 82n;
const ACCOUNT_LEN = 165n;

export const HELD_PAY = 1_000_000n;
export const HELD_WEIGHTS = [6_000, 4_000];
export const HELD_SHARE = splitN(HELD_PAY - splitFee(HELD_PAY, FEE_BPS).fee, HELD_WEIGHTS)[1] ?? 0n;

export const ata22 = (owner: Address, mint: Address): Promise<Address> => findAssociatedTokenAddress({ owner, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS });

export async function keyOf(address: Address): Promise<KeyPairSigner> {
  for (const text of h.files.values()) {
    try {
      const signer = await createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(text) as number[]));
      if (signer.address === address) {
        return signer;
      }
    } catch {
      continue;
    }
  }
  throw new Error(`no key file holds ${address}`);
}

export async function otherAccount22(payer: KeyPairSigner, owner: Address, mint: Address): Promise<Address> {
  const created = await generateKeyPairSigner();
  await send(payer, [
    getCreateAccountInstruction({ payer, newAccount: created, lamports: h.svm.minimumBalanceForRentExemption(ACCOUNT_LEN), space: ACCOUNT_LEN, programAddress: TOKEN_2022_PROGRAM_ADDRESS }),
    getInitializeAccount3Instruction({ account: created.address, mint, owner }, T22),
  ]);
  return created.address;
}

async function requireMemos(payer: KeyPairSigner, owner: KeyPairSigner, account: Address): Promise<void> {
  const signerMeta = (signer: KeyPairSigner, role: AccountRole) => ({ address: signer.address, role, signer });
  const reallocate: Instruction = {
    programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    accounts: [{ address: account, role: AccountRole.WRITABLE }, signerMeta(payer, AccountRole.WRITABLE_SIGNER), { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY }, signerMeta(owner, AccountRole.READONLY_SIGNER)],
    data: Uint8Array.of(29, 8, 0),
  };
  const enable: Instruction = {
    programAddress: TOKEN_2022_PROGRAM_ADDRESS,
    accounts: [{ address: account, role: AccountRole.WRITABLE }, signerMeta(owner, AccountRole.READONLY_SIGNER)],
    data: Uint8Array.of(30, 0),
  };
  await send(payer, [reallocate, enable]);
}

export type HeldRelease = { mint: Address; owner: KeyPairSigner; nonce: bigint; intent: Address; announcement: Address; blocked: Address; payer: KeyPairSigner };

export type HeldEscrow = Omit<HeldRelease, "announcement"> & { announcer: KeyPairSigner; announcement: Address; salt: string };

export async function heldEscrow(coauthor: KeyPairSigner, work: string, through: Transport, judge: Address): Promise<HeldEscrow> {
  const payer = await funded();
  const created = await generateKeyPairSigner();
  await send(payer, [
    getCreateAccountInstruction({ payer, newAccount: created, lamports: h.svm.minimumBalanceForRentExemption(MINT_LEN), space: MINT_LEN, programAddress: TOKEN_2022_PROGRAM_ADDRESS }),
    getInitializeMint2Instruction({ mint: created.address, decimals: 6, mintAuthority: payer.address }, T22),
  ]);
  const mint = created.address;
  const owner = await funded();
  const ownerAccount = await ata22(owner.address, mint);
  await send(payer, [
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner: owner.address, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS }),
    getMintToInstruction({ mint, token: ownerAccount, mintAuthority: payer, amount: HELD_PAY }, T22),
  ]);
  const announcer = await keyed();
  const client = createClient({ url: "http://cluster", transport: through });
  const { nonce } = await client.createIntent({
    signer: owner,
    params: { kind: Kind.AttestedResult, amountIn: HELD_PAY, minResult: 1n, maxResult: 1n, attestor: judge, specHash: Uint8Array.from(Buffer.from(work, "hex")), judgeFee: 0n },
    inputMint: mint,
    outputMint: await plainMint(payer),
  });
  const [intent] = await findIntentPda({ owner: owner.address, nonce });
  const made = await announced(intent, announcer, work, undefined, through);
  const blocked = await ata22(coauthor.address, mint);
  await send(payer, [await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner: coauthor.address, mint, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS })]);
  await requireMemos(payer, coauthor, blocked);
  return { mint, owner, nonce, intent, announcement: made.announcement, salt: made.salt, blocked, payer, announcer };
}

export async function heldRelease(coauthor: KeyPairSigner, work: string, through: Transport = transport): Promise<HeldRelease> {
  const judge = await keyed();
  const made = await heldEscrow(coauthor, work, through, judge.address);
  const { announcer } = made;
  const client = createClient({ url: "http://cluster", transport: through });
  const target = {
    intent: { owner: made.owner.address, nonce: made.nonce },
    announcement: made.announcement,
    opening: { sha256: work, salt: made.salt },
    result: 1n,
    recipients: [
      { wallet: announcer.address, weight: HELD_WEIGHTS[0] ?? 0 },
      { wallet: coauthor.address, weight: HELD_WEIGHTS[1] ?? 0 },
    ],
  };
  const ballot = await client.splitBallot(target);
  const signatures = await Promise.all([announcer, coauthor].map(async (signer) => ({ wallet: signer.address, signature: await signMessageBytes(signer, ballot.message) })));
  await client.settleSplit({ ...target, judge, signatures });
  return { mint: made.mint, owner: made.owner, nonce: made.nonce, intent: made.intent, announcement: made.announcement, blocked: made.blocked, payer: made.payer };
}
