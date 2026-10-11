import { type Address, createNoopSigner, type Instruction, isSome, type TransactionSigner } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import {
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getSyncNativeInstruction,
  getTokenDecoder,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import {
  buildInitUser,
  findAssociatedTokenAddress,
  findDelegatePda,
  formatAmount,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  U64_MAX,
  findIntentPda,
  findUserStatePda,
  getUserStateDecoder,
} from "@intent-engine/core";
import { createdAccount, TOKEN_PROGRAMS } from "../accounts.js";
import { NATIVE_MINT } from "../tokens.js";
import type { Transport } from "../transport.js";
import { AgentRefusal, ENGINE_PROBLEMS } from "./problems.js";
import { SOL_DECIMALS } from "./read.js";

export type UserWindow = { nonceBase: bigint; nonceBitmap: readonly bigint[]; epoch: bigint };

export async function userOf(transport: Transport, owner: Address): Promise<UserWindow | null> {
  const [address] = await findUserStatePda({ owner });
  const view = await createdAccount(transport, address);
  if (view === null) {
    return null;
  }
  if (view.owner !== INTENT_ENGINE_PROGRAM_ADDRESS) {
    throw new Error(`${address} is not an engine user account`);
  }
  return getUserStateDecoder().decode(view.data);
}

export const NONCE_WINDOW = 256n;

export function pickNonce(
  user: UserWindow | null,
  requested: bigint | undefined,
  reserved: ReadonlySet<bigint> = new Set(),
): bigint {
  if (requested !== undefined) {
    return requested;
  }
  const base = user?.nonceBase ?? 0n;
  for (let offset = 0n; offset < NONCE_WINDOW && base + offset <= U64_MAX; offset++) {
    const word = user?.nonceBitmap[Number(offset / 64n)] ?? 0n;
    const used = ((word >> offset % 64n) & 1n) === 1n;
    if (!used && !reserved.has(base + offset)) {
      return base + offset;
    }
  }
  throw new AgentRefusal(
    "NoFreeNonce",
    "every nonce in the owner's window is used or promised to a pending signature; the owner must advance the nonce window first",
  );
}

export async function initUserIfMissing(user: UserWindow | null, owner: Address): Promise<Instruction[]> {
  return user === null ? [await buildInitUser({ owner: createNoopSigner(owner) })] : [];
}

export async function tokenAccountIfMissing(
  transport: Transport,
  payer: TransactionSigner,
  owner: Address,
  mint: Address,
  tokenProgram: Address,
): Promise<{ address: Address; create: Instruction[] }> {
  const address = await findAssociatedTokenAddress({ owner, mint, tokenProgram });
  const create =
    (await createdAccount(transport, address)) === null
      ? [
          await getCreateAssociatedTokenIdempotentInstructionAsync({
            payer,
            owner,
            mint,
            tokenProgram,
          }),
        ]
      : [];
  return { address, create };
}

export type Wrap = { instructions: Instruction[]; lamports: bigint };

export async function wrapIfShort(
  transport: Transport,
  owner: Address,
  mint: Address,
  tokenProgram: Address,
  needed: bigint,
): Promise<Wrap> {
  if (mint !== NATIVE_MINT || tokenProgram !== TOKEN_PROGRAM_ADDRESS) {
    return { instructions: [], lamports: 0n };
  }
  const account = await findAssociatedTokenAddress({ owner, mint, tokenProgram });
  const view = await createdAccount(transport, account);
  const held = view === null ? 0n : getTokenDecoder().decode(view.data).amount;
  if (held >= needed) {
    return { instructions: [], lamports: 0n };
  }
  const payer = createNoopSigner(owner);
  return {
    instructions: [
      ...(view === null ? [await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner, mint, tokenProgram })] : []),
      getTransferSolInstruction({ source: payer, destination: account, amount: needed - held }),
      getSyncNativeInstruction({ account }),
    ],
    lamports: needed - held,
  };
}

export async function unusedIntent(transport: Transport, owner: Address, nonce: bigint): Promise<Address> {
  const [intent] = await findIntentPda({ owner, nonce });
  if ((await createdAccount(transport, intent)) !== null) {
    throw new AgentRefusal("NonceUsed", ENGINE_PROBLEMS.NonceUsed.hint);
  }
  return intent;
}

export type Allowance = { account: Address; before: bigint; after: bigint; replaces: Address | null };

export async function raiseAllowance(
  transport: Transport,
  owner: Address,
  account: Address,
  by: bigint,
): Promise<Allowance> {
  const view = await createdAccount(transport, account);
  if (view !== null && !TOKEN_PROGRAMS.includes(view.owner)) {
    throw new Error(`${account} is not a token account`);
  }
  const token = view === null ? null : getTokenDecoder().decode(view.data);
  const [engine] = await findDelegatePda({ owner });
  const current = token !== null && isSome(token.delegate) ? token.delegate.value : null;
  const before = current === engine && token !== null ? token.delegatedAmount : 0n;
  return {
    account,
    before,
    after: before > U64_MAX - by ? U64_MAX : before + by,
    replaces: current === null || current === engine ? null : current,
  };
}

export async function lowerAllowance(
  transport: Transport,
  owner: Address,
  account: Address,
  by: bigint,
): Promise<Allowance> {
  const view = await createdAccount(transport, account);
  const token = view === null || !TOKEN_PROGRAMS.includes(view.owner) ? null : getTokenDecoder().decode(view.data);
  const [engine] = await findDelegatePda({ owner });
  const current = token !== null && isSome(token.delegate) ? token.delegate.value : null;
  const before = current === engine && token !== null ? token.delegatedAmount : 0n;
  return { account, before, after: before > by ? before - by : 0n, replaces: null };
}

export const WARN_REPLACES_DELEGATE = "the setup replaces another app's spending approval on your token account";

export function setupLines(o: {
  registers: boolean;
  creates: Address[];
  allowance: Allowance | null;
  decimals?: number;
  wraps?: bigint;
}): { lines: string[]; warnings: string[] } {
  const a = o.allowance;
  return {
    lines: [
      ...(o.registers ? ["Setup: registers you with the engine (a one-time account you pay rent for)"] : []),
      ...o.creates.map((mint) => `Setup: creates your token account for ${mint} (you pay its rent)`),
      ...(o.wraps === undefined || o.wraps === 0n
        ? []
        : [`Setup: wraps ${formatAmount(o.wraps, SOL_DECIMALS)} of your SOL into your wrapped SOL account`]),
      ...(a === null
        ? []
        : [
            `Setup: sets the engine's spending allowance on ${a.account} to ${formatAmount(a.after, o.decimals)} (now ${formatAmount(a.before, o.decimals)})`,
            ...(a.replaces === null ? [] : [`Setup: removes the approval ${a.replaces} holds on ${a.account}`]),
          ]),
    ],
    warnings: a !== null && a.replaces !== null ? [WARN_REPLACES_DELEGATE] : [],
  };
}
