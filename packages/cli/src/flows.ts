import {
  type Address,
  type Blockhash,
  createNoopSigner,
  getBase58Decoder,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type MessagePartialSigner,
  type TransactionPartialSigner,
} from "@solana/kit";
import { getRevokeInstruction, getTokenDecoder } from "@solana-program/token";
import {
  buildApproveDelegate,
  findAssociatedTokenAddress,
  findDelegatePda,
  formatAmount,
  getIntentDecoder,
  IntentStatus,
  parseAmount,
} from "@intent-engine/core";
import { createdAccount, isSdkError, mintOf, type Transport, unmemoized } from "@intent-engine/client";
import { type AgentContext, type AnyAction, invoke } from "./agent/actions.js";
import { WARN_REPLACES_DELEGATE } from "./agent/owner.js";
import { prepare } from "./agent/prepare.js";
import { problemOf, refusalText } from "./agent/problems.js";
import { preparedView } from "./agent/shapes.js";
import { type Side, type Tokens, UsageError } from "./args.js";
import { printableLines } from "./render.js";

const PREPARED_KEYS = ["setup", "prepared"] as const;
const FOLLOWING_KEY = "cancels";
const FOLLOWING_NAMES = "cancelled";

export const CANCELS_FAILED =
  "the revoke landed and signatures lists every transaction that did; the intents in failed are still open, so cancel each with intent-engine cancel";

export const CANCELS_UNKNOWN =
  "the cancels in unknown were sent but not confirmed and may still land; look each signature up with intent-engine lookup --signature, or read the intent with intent-engine show, before cancelling it again";

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

async function signedView(view: PreparedView, signer: TransactionPartialSigner) {
  const others = view.signers.filter((s) => s !== signer.address);
  if (others.length > 0) {
    throw new FlowRefused(`this transaction also needs signatures from ${others.join(", ")}`);
  }
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(view.transaction));
  if (!(signer.address in tx.signatures)) {
    throw new FlowRefused(`this transaction takes no signature from ${signer.address}`);
  }
  const [own] = await signer.signTransactions([tx as Parameters<TransactionPartialSigner["signTransactions"]>[0][number]]);
  const signed = Object.freeze({ ...tx, signatures: Object.freeze({ ...tx.signatures, ...own }) });
  return {
    wire: getBase64EncodedWireTransaction(signed),
    signature: getSignatureFromTransaction(signed) as string,
    latest: { blockhash: "" as Blockhash, lastValidBlockHeight: BigInt(view.last_valid_block_height) },
  };
}

export async function execute(transport: Transport, view: PreparedView, signer: TransactionPartialSigner): Promise<string> {
  const { wire, latest } = await signedView(view, signer);
  return transport.sendWire(wire, latest);
}

export const STATUS_SCAN = 10;

type Landing = "landed" | "failed" | "unknown";

export async function landingOf(transport: Transport, signature: string, intent: string | null): Promise<Landing> {
  if (intent === null) {
    return "unknown";
  }
  try {
    const fresh = unmemoized(transport);
    const seen = (await fresh.engineTransactions(STATUS_SCAN, intent as Address)).find((tx) => tx.signature === signature);
    if (seen !== undefined) {
      return seen.failed ? "failed" : "landed";
    }
    const view = await fresh.getAccount(intent as Address);
    return view !== null && getIntentDecoder().decode(view.data).status === IntentStatus.Cancelled ? "landed" : "unknown";
  } catch {
    return "unknown";
  }
}

export async function ask(action: AnyAction, ctx: AgentContext, input: object): Promise<Record<string, unknown>> {
  const outcome = await invoke(action, ctx, input);
  if (!outcome.ok) {
    const message = refusalText(outcome.problem);
    throw outcome.problem.code === "InvalidInput" ? new UsageError(message) : new FlowRefused(message);
  }
  return outcome.value;
}

export async function finish(
  transport: Transport,
  value: Record<string, unknown>,
  signer: TransactionPartialSigner,
  yes: boolean,
): Promise<object> {
  const leading = PREPARED_KEYS.map((key) => value[key] as PreparedView | undefined).filter((v) => v !== undefined);
  const following = (value[FOLLOWING_KEY] as PreparedView[] | undefined) ?? [];
  const named = (value[FOLLOWING_NAMES] as string[] | undefined) ?? [];
  const views = [...leading, ...following];
  const priority = views.reduce((sum, v) => sum + BigInt(v.priority_fee_lamports ?? 0n), 0n);
  const shown = {
    ...Object.fromEntries(Object.entries(value).filter(([k]) => !([...PREPARED_KEYS, FOLLOWING_KEY] as readonly string[]).includes(k))),
    ...(priority > 0n ? { priority_fee_lamports: priority } : {}),
  };
  if (!yes) {
    return { ...shown, sent: false, next: NOT_SENT };
  }
  const signatures = [];
  for (const view of leading) {
    signatures.push(await execute(transport, view, signer));
  }
  const failed = [];
  const unknown = [];
  const landed = [];
  const reasonOf = (error: unknown) => printableLines(error instanceof Error ? error.message : String(error));
  for (const [i, view] of following.entries()) {
    const intent = named[i] ?? null;
    let sending;
    try {
      sending = await signedView(view, signer);
    } catch (error) {
      failed.push({ intent, reason: reasonOf(error) });
      continue;
    }
    try {
      signatures.push(await transport.sendWire(sending.wire, sending.latest));
      landed.push(intent);
    } catch (error) {
      const landing = isSdkError(error, "failed-on-chain") ? "failed" : await landingOf(transport, sending.signature, intent);
      if (landing === "landed") {
        signatures.push(sending.signature);
        landed.push(intent);
      } else if (landing === "failed") {
        failed.push({ intent, reason: reasonOf(error) });
      } else {
        unknown.push({ intent, signature: sending.signature, reason: reasonOf(error) });
      }
    }
  }
  const next = [...(failed.length === 0 ? [] : [CANCELS_FAILED]), ...(unknown.length === 0 ? [] : [CANCELS_UNKNOWN])];
  return {
    ...shown,
    ...(following.length === 0 ? {} : { [FOLLOWING_NAMES]: landed.filter((intent) => intent !== null) }),
    sent: true,
    signatures,
    ...(failed.length === 0 ? {} : { failed }),
    ...(unknown.length === 0 ? {} : { unknown }),
    ...(next.length === 0 ? {} : { next: next.join("; ") }),
  };
}

export async function perform(
  action: AnyAction,
  ctx: AgentContext,
  input: object,
  signer: TransactionPartialSigner,
  yes: boolean,
): Promise<object> {
  return finish(ctx.transport, await ask(action, ctx, input), signer, yes);
}

export async function signMessage(signer: MessagePartialSigner, base64: string): Promise<string> {
  const content = new Uint8Array(getBase64Encoder().encode(base64));
  const [signed] = await signer.signMessages([{ content, signatures: {} }]);
  const signature = signed?.[signer.address];
  if (signature === undefined) {
    throw new FlowRefused(`${signer.address} returned no signature for the message; nothing was saved`);
  }
  return getBase58Decoder().decode(signature);
}

export async function approval(
  transport: Transport,
  signer: TransactionPartialSigner,
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
