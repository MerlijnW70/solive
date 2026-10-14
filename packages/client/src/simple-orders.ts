import type { Address, Instruction, Signature, TransactionSigner } from "@solana/kit";
import { type IntentParams, Kind, NATIVE_MINT } from "@intent-engine/core";
import { createClient } from "./client.js";
import { type Client, type ClientOptions, DEFAULT_EXPIRES_IN } from "./client-types.js";
import { boundMembers } from "./memoized-transport.js";
import { hexOf, mintOfToken, nameOfMint, secondsOf, specHashBytes, tokenAmount, wholeTokens } from "./simple-tokens.js";
import type { LimitInput, PayForWorkInput, Preview, Sent, SwapInput } from "./simple-types.js";
import type { Transport } from "./transport.js";

export const ESCROW_EXPIRES_IN = 86_400n;
export const PREVIEW_SIGNATURE = "1".repeat(64) as Signature;
export const RECORD_TOKEN_NEEDED = "paying in SOL off devnet needs recordToken: any other token, which only labels the escrow";

export type SimpleContext = { url: string; signer: TransactionSigner; client: Client; options: ClientOptions };

type Done = { signature: Signature; intent?: Address; nonce?: bigint };

function capturing(transport: Transport): { transport: Transport; taken: Instruction[] } {
  const taken: Instruction[] = [];
  const refuse = async (): Promise<never> => {
    throw new Error("a preview sends nothing");
  };
  return {
    taken,
    transport: {
      ...boundMembers(transport),
      send: async (instructions) => {
        taken.push(...instructions);
        return PREVIEW_SIGNATURE;
      },
      sendWire: refuse,
      submitWire: refuse,
      airdrop: refuse,
    },
  };
}

export async function outcome(
  ctx: SimpleContext,
  preview: boolean | undefined,
  summary: string,
  act: (client: Client) => Promise<Done>,
): Promise<Sent | Preview> {
  if (preview !== true) {
    return { ...(await act(ctx.client)), summary };
  }
  const { transport, taken } = capturing(ctx.client.transport);
  const { intent, nonce } = await act(createClient({ ...ctx.options, transport }));
  return { summary, instructions: taken, ...(intent === undefined ? {} : { intent }), ...(nonce === undefined ? {} : { nonce }) };
}

async function pair(ctx: SimpleContext, sell: string, buy: string) {
  const inputMint = mintOfToken(sell, ctx.url);
  const outputMint = mintOfToken(buy, ctx.url);
  if (inputMint === outputMint) {
    throw new RangeError("sell and buy name the same token");
  }
  const [sold, bought] = await Promise.all([ctx.client.mint(inputMint), ctx.client.mint(outputMint)]);
  return { inputMint, outputMint, sold, bought };
}

function placed(ctx: SimpleContext, params: IntentParams, inputMint: Address, outputMint: Address, expiresIn: bigint, specUrl?: string) {
  return (client: Client) =>
    client.createIntent({ signer: ctx.signer, params, inputMint, outputMint, expiresIn, ...(specUrl === undefined ? {} : { specUrl }) });
}

export function orderSends(ctx: SimpleContext) {
  const swap = async (input: SwapInput) => {
    const { inputMint, outputMint, sold, bought } = await pair(ctx, input.sell, input.buy);
    const amountIn = tokenAmount(input.amount, sold.decimals, "amount");
    const minOut = tokenAmount(input.minReceive, bought.decimals, "minReceive");
    const expiresIn = secondsOf(input.expiresIn, DEFAULT_EXPIRES_IN);
    const summary = `Swap ${wholeTokens(amountIn, sold.decimals, inputMint)} for at least ${wholeTokens(minOut, bought.decimals, outputMint)}, open for ${expiresIn} seconds`;
    return outcome(ctx, input.preview, summary, placed(ctx, { kind: Kind.SwapExactIn, amountIn, minOut }, inputMint, outputMint, expiresIn));
  };

  const limit = async (input: LimitInput) => {
    const { inputMint, outputMint, sold, bought } = await pair(ctx, input.sell, input.buy);
    const makeAmount = tokenAmount(input.amount, sold.decimals, "amount");
    const price = tokenAmount(input.price, bought.decimals, "price");
    const scale = 10n ** BigInt(sold.decimals);
    const takeAmount = (makeAmount * price + scale - 1n) / scale;
    const expiresIn = secondsOf(input.expiresIn, DEFAULT_EXPIRES_IN);
    const summary = `Limit order: sell ${wholeTokens(makeAmount, sold.decimals, inputMint)} for at least ${wholeTokens(takeAmount, bought.decimals, outputMint)} (${input.price.trim()} ${nameOfMint(outputMint)} per ${nameOfMint(inputMint)}), open for ${expiresIn} seconds`;
    return outcome(ctx, input.preview, summary, placed(ctx, { kind: Kind.LimitOrder, makeAmount, takeAmount }, inputMint, outputMint, expiresIn));
  };

  const recordMint = (paid: Address, chosen: string | undefined): Address => {
    if (chosen !== undefined) {
      return mintOfToken(chosen, ctx.url);
    }
    if (paid !== NATIVE_MINT) {
      return NATIVE_MINT;
    }
    try {
      return mintOfToken("TEST", ctx.url);
    } catch {
      throw new RangeError(RECORD_TOKEN_NEEDED);
    }
  };

  const payForWork = async (input: PayForWorkInput) => {
    const inputMint = mintOfToken(input.token ?? "SOL", ctx.url);
    const outputMint = recordMint(inputMint, input.recordToken);
    if (inputMint === outputMint) {
      throw new RangeError("recordToken must differ from the token paid");
    }
    const { decimals } = await ctx.client.mint(inputMint);
    const amountIn = tokenAmount(input.amount, decimals, "amount");
    const judgeFee = input.judgeFee === undefined ? 0n : tokenAmount(input.judgeFee, decimals, "judgeFee");
    if (judgeFee >= amountIn) {
      throw new RangeError("judgeFee must be below amount");
    }
    const specHash = specHashBytes(input.specHash);
    const expiresIn = secondsOf(input.expiresIn, ESCROW_EXPIRES_IN);
    const params = { kind: Kind.AttestedResult, amountIn, minResult: 1n, maxResult: 1n, attestor: input.judge, specHash, judgeFee } as const;
    const summary = `Pay ${wholeTokens(amountIn, decimals, inputMint)} for work judged by ${input.judge} against spec ${hexOf(specHash)}, judge fee ${wholeTokens(judgeFee, decimals, inputMint)}, open for ${expiresIn} seconds`;
    return outcome(ctx, input.preview, summary, placed(ctx, params, inputMint, outputMint, expiresIn, input.specUrl));
  };

  return { swap, limit, payForWork };
}
