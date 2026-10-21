import { type Address, isSome } from "@solana/kit";
import { SYSTEM_PROGRAM_ADDRESS } from "@solana-program/system";
import { getTokenDecoder } from "@solana-program/token";
import { findDelegatePda, formatAmount, U64_MAX, findIntentPda } from "@intent-engine/core";
import { createdAccount, TOKEN_PROGRAMS, type NonceWindow, type Transport } from "@intent-engine/client";
import { AgentRefusal, ENGINE_PROBLEMS } from "./problems.js";
import { SOL_DECIMALS } from "./read.js";
import { InvalidInput } from "./schema.js";

export const TOKEN_ACCOUNT_RECIPIENT = "this is a token account; give the wallet that owns it";

export const notAWallet = (program: Address) =>
  `this account belongs to the program ${program}, not to a wallet, so nothing paid to it could be spent; give a wallet address`;

export async function walletRecipient(transport: Transport, recipient: Address, path: string): Promise<void> {
  const held = await transport.getAccount(recipient);
  if (held === null || held.owner === SYSTEM_PROGRAM_ADDRESS) {
    return;
  }
  throw new InvalidInput([{ path, message: TOKEN_PROGRAMS.includes(held.owner) ? TOKEN_ACCOUNT_RECIPIENT : notAWallet(held.owner) }]);
}

const NONCE_WINDOW = 256n;

export function pickNonce(
  user: NonceWindow | null,
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

export async function unusedIntent(transport: Transport, owner: Address, nonce: bigint): Promise<Address> {
  const [intent] = await findIntentPda({ owner, nonce });
  if ((await createdAccount(transport, intent)) !== null) {
    throw new AgentRefusal("NonceUsed", ENGINE_PROBLEMS.NonceUsed.hint);
  }
  return intent;
}

type Allowance = { account: Address; before: bigint; after: bigint; replaces: Address | null };

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
  const [after = U64_MAX] = [before + by, U64_MAX].sort((x, y) => Number(x - y));
  return {
    account,
    before,
    after,
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
  const [after = 0n] = [before - by, 0n].sort((x, y) => Number(y - x));
  return { account, before, after, replaces: null };
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
