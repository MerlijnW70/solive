import type { Address, Instruction, Signature, TransactionSigner } from "@solana/kit";
import { attestedResult, InvalidInput, limitOrder, NATIVE_MINT, swapExactIn } from "@intent-engine/core";
import { createClient } from "./client.js";
import { PreviewRefused } from "./client-errors.js";
import { type Client, type ClientOptions, DEFAULT_EXPIRES_IN, type ParamsWithSpec } from "./client-types.js";
import { boundMembers } from "./memoized-transport.js";
import { hexOf, mintOfToken, nameOfMint, secondsOf, specHashBytes, tokenAmount, wholeTokens } from "./simple-tokens.js";
import type { LimitInput, Outcome, PayForWorkInput, Preview, PreviewOption, Sent, SwapInput } from "./simple-types.js";
import type { Transport } from "./transport.js";

export const ESCROW_EXPIRES_IN = 86_400n;
export const PREVIEW_SIGNATURE = "1".repeat(64) as Signature;
export const RECORD_TOKEN_NEEDED = "paying in SOL off devnet needs recordToken: any other token, which only labels the escrow";

export type SimpleContext = { url: string; signer: TransactionSigner; client: Client; options: ClientOptions };

type Done = { signature: Signature; intent?: Address; nonce?: bigint };

function capturing(transport: Transport): { transport: Transport; taken: Instruction[] } {
  const taken: Instruction[] = [];
  const refuse = async (): Promise<never> => {
    throw new PreviewRefused();
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

export async function outcome<I extends PreviewOption>(
  ctx: SimpleContext,
  input: I,
  summary: string,
  act: (client: Client) => Promise<Done>,
): Promise<Outcome<I>> {
  return (await outcomeOf(ctx, input.preview, summary, act)) as Outcome<I>;
}

async function outcomeOf(ctx: SimpleContext, preview: boolean | undefined, summary: string, act: (client: Client) => Promise<Done>): Promise<Sent | Preview> {
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
    throw new InvalidInput("buy", "conflict", "sell and buy name the same token");
  }
  const [sold, bought] = await Promise.all([ctx.client.mint(inputMint), ctx.client.mint(outputMint)]);
  return { inputMint, outputMint, sold, bought };
}

function placed(ctx: SimpleContext, terms: ParamsWithSpec, inputMint: Address, outputMint: Address, expiresIn: bigint) {
  return (client: Client) => client.createIntent({ signer: ctx.signer, inputMint, outputMint, expiresIn, ...terms });
}

export function orderSends(ctx: SimpleContext) {
  const swap = async <I extends SwapInput>(input: I): Promise<Outcome<I>> => {
    const { inputMint, outputMint, sold, bought } = await pair(ctx, input.sell, input.buy);
    const amountIn = tokenAmount(input.amount, sold.decimals, "amount");
    const minOut = tokenAmount(input.minReceive, bought.decimals, "minReceive");
    const expiresIn = secondsOf(input.expiresIn, DEFAULT_EXPIRES_IN);
    const summary = `Swap ${wholeTokens(amountIn, sold.decimals, inputMint)} for at least ${wholeTokens(minOut, bought.decimals, outputMint)}, open for ${expiresIn} seconds`;
    return outcome(ctx, input, summary, placed(ctx, { params: swapExactIn({ amountIn, minOut }) }, inputMint, outputMint, expiresIn));
  };

  const limit = async <I extends LimitInput>(input: I): Promise<Outcome<I>> => {
    const { inputMint, outputMint, sold, bought } = await pair(ctx, input.sell, input.buy);
    const makeAmount = tokenAmount(input.amount, sold.decimals, "amount");
    const price = tokenAmount(input.price, bought.decimals, "price");
    const scale = 10n ** BigInt(sold.decimals);
    const takeAmount = (makeAmount * price + scale - 1n) / scale;
    const expiresIn = secondsOf(input.expiresIn, DEFAULT_EXPIRES_IN);
    const summary = `Limit order: sell ${wholeTokens(makeAmount, sold.decimals, inputMint)} for at least ${wholeTokens(takeAmount, bought.decimals, outputMint)} (${input.price.trim()} ${nameOfMint(outputMint)} per ${nameOfMint(inputMint)}), open for ${expiresIn} seconds`;
    return outcome(ctx, input, summary, placed(ctx, { params: limitOrder({ makeAmount, takeAmount }) }, inputMint, outputMint, expiresIn));
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
      throw new InvalidInput("recordToken", "missing", RECORD_TOKEN_NEEDED);
    }
  };

  const payForWork = async <I extends PayForWorkInput>(input: I): Promise<Outcome<I>> => {
    const inputMint = mintOfToken(input.token ?? "SOL", ctx.url);
    const outputMint = recordMint(inputMint, input.recordToken);
    if (inputMint === outputMint) {
      throw new InvalidInput("recordToken", "conflict", "recordToken must differ from the token paid");
    }
    const { decimals } = await ctx.client.mint(inputMint);
    const amountIn = tokenAmount(input.amount, decimals, "amount");
    const judgeFee = input.judgeFee === undefined ? 0n : tokenAmount(input.judgeFee, decimals, "judgeFee");
    if (judgeFee >= amountIn) {
      throw new InvalidInput("judgeFee", "range", "judgeFee must be below amount");
    }
    const specHash = specHashBytes(input.specHash);
    const expiresIn = secondsOf(input.expiresIn, ESCROW_EXPIRES_IN);
    const params = attestedResult({ amountIn, minResult: 1n, maxResult: 1n, attestor: input.judge, specHash, judgeFee });
    const summary = `Pay ${wholeTokens(amountIn, decimals, inputMint)} for work judged by ${input.judge} against spec ${hexOf(specHash)}, judge fee ${wholeTokens(judgeFee, decimals, inputMint)}, open for ${expiresIn} seconds`;
    return outcome(ctx, input, summary, placed(ctx, input.specUrl === undefined ? { params } : { params, specUrl: input.specUrl }, inputMint, outputMint, expiresIn));
  };

  return { swap, limit, payForWork };
}
