import { randomUUID } from "node:crypto";
import type { Address } from "@solana/kit";
import { chainTime, CLOCK_SYSVAR, explain, mintOf, unmemoized } from "@intent-engine/client";
import type { AgentContext } from "../actions.js";
import type { Call } from "../claims.js";
import { prepareCreate } from "../create.js";
import { AgentRefusal, problemOf } from "../problems.js";
import { account, amount, flag, list, object, optional, type Schema, text } from "../schema.js";
import { orderSchema } from "../shapes.js";
import type { Sale } from "../sales.js";
import { walletEmpty, access, signerOf, mintNamed, limited, bookOf, live, salesOf, checkSale, sent, refusedBeforeSending } from "./guard.js";

export const offerFields = {
  intent: account(),
  nonce: amount(),
  summary: list(text(), 24),
  warnings: list(text(), 16),
  sent: flag(),
  signature: optional(text()),
  next: optional(text()),
};

export const offerOutput = object(offerFields);

export type Token = Awaited<ReturnType<typeof mintOf>>;

type Order = typeof orderSchema extends Schema<infer T> ? T : never;

type Terms = { order: Order; expires_at: bigint; spec_url?: string };

export async function offered(
  ctx: AgentContext,
  call: Call,
  input: { sell: string; buy: string; pay_to?: Address | undefined; send?: boolean | undefined },
  terms: (sold: Token, bought: Token, now: bigint, inputMint: Address, outputMint: Address) => Promise<Terms> | Terms,
) {
  const wallet = access(ctx);
  const signer = await signerOf(ctx);
  const inputMint = mintNamed(input.sell, wallet.url, "sell");
  const outputMint = mintNamed(input.buy, wallet.url, "buy");
  await ctx.transport.warm?.([signer.address, inputMint, outputMint, CLOCK_SYSVAR]);
  if (((await ctx.transport.getAccount(signer.address))?.lamports ?? 0n) === 0n) {
    throw new AgentRefusal("WalletEmpty", walletEmpty(signer.address));
  }
  const [inputToken, outputToken, now] = await Promise.all([
    mintOf(ctx.transport, inputMint),
    mintOf(ctx.transport, outputMint),
    chainTime(ctx.transport),
  ]);
  const made = await terms(inputToken, outputToken, now, inputMint, outputMint);
  const sold = (made.order as { amount_in: bigint }).amount_in;
  const guard = wallet.limits;
  checkSale(guard, inputMint, inputToken.decimals, sold, now, await salesOf(wallet, now));
  const created = async (context: AgentContext) => {
    const view = (await prepareCreate.run(
      context,
      { owner: signer.address, input_mint: inputMint, output_mint: outputMint, ...(input.pay_to === undefined ? {} : { pay_to: input.pay_to }), ...made } as never,
      call,
    )) as Record<string, unknown>;
    const { intent, nonce, summary, warnings, prepared } = view;
    return { intent, nonce, summary, warnings, prepared };
  };
  const first = await created(ctx);
  if (input.send !== true) {
    return sent(ctx, signer, first, input.send, call);
  }
  const path = limited(guard) ? await bookOf(wallet) : undefined;
  const sale: Sale = { id: randomUUID(), mint: inputMint, at: now, amount: sold };
  if (path !== undefined) {
    await guard.book.update(path, (sales) => {
      const kept = live(sales, now);
      checkSale(guard, inputMint, inputToken.decimals, sold, now, kept);
      return { sales: [...kept, sale], value: undefined };
    });
  }
  try {
    try {
      return await sent(ctx, signer, first, true, call);
    } catch (error) {
      if (!nonceTaken(error)) {
        throw error;
      }
      return await sent(ctx, signer, await created({ ...ctx, transport: unmemoized(ctx.transport) }), true, call);
    }
  } catch (error) {
    if (path !== undefined && refusedBeforeSending(error)) {
      await guard.book.update(path, (sales) => ({ sales: sales.filter((s) => s.id !== sale.id), value: undefined })).catch(() => undefined);
    }
    throw error;
  }
}

const NONCE_COLLISIONS: ReadonlySet<string> = new Set(["NonceUsed", "NonceTaken"]);

export function nonceTaken(error: unknown): boolean {
  if (NONCE_COLLISIONS.has(problemOf(error).code) || explain(error)?.name === "NonceUsed") {
    return true;
  }
  const text = error instanceof Error ? error.message : String(error);
  return /already in use/i.test(text);
}
