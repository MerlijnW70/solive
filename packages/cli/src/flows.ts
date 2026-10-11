import {
  type Address,
  type Blockhash,
  createNoopSigner,
  getBase58Decoder,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  type KeyPairSigner,
  partiallySignTransaction,
  signBytes,
} from "@solana/kit";
import { getRevokeInstruction, getTokenDecoder } from "@solana-program/token";
import {
  buildApproveDelegate,
  findAssociatedTokenAddress,
  findDelegatePda,
  formatAmount,
  parseAmount,
} from "@intent-engine/core";
import { createdAccount, mintOf } from "./accounts.js";
import { type AgentContext, type AnyAction, invoke } from "./agent/actions.js";
import { WARN_REPLACES_DELEGATE } from "./agent/owner.js";
import { prepare } from "./agent/prepare.js";
import { problemOf } from "./agent/problems.js";
import { preparedView } from "./agent/shapes.js";
import { type Side, type Tokens, UsageError } from "./args.js";
import type { Transport } from "./transport.js";

const PREPARED_KEYS = ["setup", "prepared"] as const;

export const NOT_SENT = "nothing was sent; check the summary and pass --yes to sign and send";

export type PreparedView = {
  transaction: string;
  signers: string[];
  last_valid_block_height: string | bigint;
  priority_fee_lamports?: string | bigint;
};

export class FlowRefused extends Error {}

const isTokens = (value: unknown): value is Tokens =>
  value !== null && typeof value === "object" && "tokens" in value && "side" in value;

export function hasTokens(value: unknown): boolean {
  if (isTokens(value)) {
    return true;
  }
  return value !== null && typeof value === "object" && Object.values(value).some(hasTokens);
}

export function scaled(value: unknown, decimals: Record<Side, number>): unknown {
  if (isTokens(value)) {
    try {
      return parseAmount(value.tokens, decimals[value.side]).toString();
    } catch (error) {
      throw new UsageError(error instanceof Error ? error.message : String(error));
    }
  }
  if (Array.isArray(value)) {
    return value.map((v) => scaled(v, decimals));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scaled(v, decimals)]));
  }
  return value;
}

export async function inRaw<T>(transport: Transport, input: T, inputMint: Address, outputMint: Address): Promise<T> {
  if (!hasTokens(input)) {
    return input;
  }
  const decimalsOf = async (mint: Address) => {
    try {
      return (await mintOf(transport, mint)).decimals;
    } catch (error) {
      const problem = problemOf(error);
      throw new FlowRefused(`${problem.code}: ${problem.hint}`);
    }
  };
  await transport.warm?.([inputMint, outputMint]);
  const decimals = { input: await decimalsOf(inputMint), output: await decimalsOf(outputMint) };
  return scaled(input, decimals) as T;
}

export async function execute(transport: Transport, view: PreparedView, signer: KeyPairSigner): Promise<string> {
  const others = view.signers.filter((s) => s !== signer.address);
  if (others.length > 0) {
    throw new FlowRefused(`this transaction also needs signatures from ${others.join(", ")}`);
  }
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(view.transaction));
  const signed = await partiallySignTransaction([signer.keyPair], tx);
  const latest = { blockhash: "" as Blockhash, lastValidBlockHeight: BigInt(view.last_valid_block_height) };
  return transport.sendWire(getBase64EncodedWireTransaction(signed), latest);
}

export async function ask(action: AnyAction, ctx: AgentContext, input: object): Promise<Record<string, unknown>> {
  const outcome = await invoke(action, ctx, input);
  if (!outcome.ok) {
    const message = `${outcome.problem.code}: ${outcome.problem.hint}`;
    throw outcome.problem.code === "InvalidInput" ? new UsageError(message) : new FlowRefused(message);
  }
  return outcome.value;
}

export async function finish(
  transport: Transport,
  value: Record<string, unknown>,
  signer: KeyPairSigner,
  yes: boolean,
): Promise<object> {
  const views = PREPARED_KEYS.map((key) => value[key] as PreparedView | undefined).filter((v) => v !== undefined);
  const priority = views.reduce((sum, v) => sum + BigInt(v.priority_fee_lamports ?? 0n), 0n);
  const shown = {
    ...Object.fromEntries(Object.entries(value).filter(([k]) => !(PREPARED_KEYS as readonly string[]).includes(k))),
    ...(priority > 0n ? { priority_fee_lamports: priority } : {}),
  };
  if (!yes) {
    return { ...shown, sent: false, next: NOT_SENT };
  }
  const signatures = [];
  for (const view of views) {
    signatures.push(await execute(transport, view, signer));
  }
  return { ...shown, sent: true, signatures };
}

export async function perform(
  action: AnyAction,
  ctx: AgentContext,
  input: object,
  signer: KeyPairSigner,
  yes: boolean,
): Promise<object> {
  return finish(ctx.transport, await ask(action, ctx, input), signer, yes);
}

export async function signMessage(signer: KeyPairSigner, base64: string): Promise<string> {
  return getBase58Decoder().decode(await signBytes(signer.keyPair.privateKey, getBase64Encoder().encode(base64)));
}

export async function approval(
  transport: Transport,
  signer: KeyPairSigner,
  mint: Address,
  amount: bigint | undefined,
  yes: boolean,
): Promise<object> {
  const token = await mintOf(transport, mint);
  const owner = createNoopSigner(signer.address);
  const account = await findAssociatedTokenAddress({ owner: signer.address, mint, tokenProgram: token.tokenProgram });
  const view = await createdAccount(transport, account);
  if (view === null) {
    throw new FlowRefused(`${signer.address} holds no token account for ${mint} at ${account}`);
  }
  const state = getTokenDecoder().decode(view.data);
  const [engine] = await findDelegatePda({ owner: signer.address });
  const delegate = state.delegate.__option === "Some" ? state.delegate.value : null;
  const before = delegate === engine ? state.delegatedAmount : 0n;
  const show = (raw: bigint) => formatAmount(raw, token.decimals);
  if (amount === undefined && delegate !== engine) {
    throw new FlowRefused(
      delegate === null
        ? `${account} gives no spending allowance to anyone; nothing to remove`
        : `the allowance on ${account} belongs to ${delegate}, not the engine; it is left alone`,
    );
  }
  const instruction =
    amount === undefined
      ? getRevokeInstruction({ source: account, owner }, { programAddress: token.tokenProgram })
      : await buildApproveDelegate({ owner, mint, tokenProgram: token.tokenProgram, amount, decimals: token.decimals });
  const summary =
    amount === undefined
      ? [`Removes the engine's spending allowance on ${account} (now ${show(before)})`]
      : [`Sets the engine's spending allowance on ${account} to ${show(amount)} (now ${show(before)})`];
  const warnings = delegate !== null && delegate !== engine ? [WARN_REPLACES_DELEGATE] : [];
  return finish(
    transport,
    {
      account,
      allowance: amount ?? 0n,
      summary: [...summary, ...warnings.map((w) => `WARNING: ${w}`)],
      warnings,
      prepared: preparedView(await prepare(transport, [instruction], signer.address)),
    },
    signer,
    yes,
  );
}
