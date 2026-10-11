import { createNoopSigner } from "@solana/kit";
import {
  buildCreateIntent,
  describeTerms,
  encodeParams,
  escrowAmount,
  formatTime,
  Kind,
  LONG_LIVED_SECONDS,
  validate,
  WARN_ATTESTOR,
  WARN_LONG_LIVED,
} from "@intent-engine/core";
import { chainTime, loadConfig, mintOf } from "../accounts.js";
import { define } from "./actions.js";
import { tool } from "./names.js";
import { claim, claimedBy, PREPARED_TTL } from "./claims.js";
import { initUserIfMissing, pickNonce, setupLines, tokenAccountIfMissing, unusedIntent, userOf, wrapIfShort } from "./owner.js";
import { prepare } from "./prepare.js";
import { InvalidInput } from "./schema.js";
import { orderSchema, paramsOf, partnerSchema, preparedSchema, preparedView } from "./shapes.js";
import { tokenNames } from "../tokens.js";
import { account, amount, integer, list, object, optional, text, time } from "./schema.js";

export const MAX_EXPIRES_IN = 365 * 24 * 60 * 60;
export const MIN_EXPIRES_IN = 60;

export function expiryOf(input: { expires_at?: bigint; expires_in?: number }, now: bigint): bigint {
  if (input.expires_at !== undefined && input.expires_in === undefined) {
    return input.expires_at;
  }
  if (input.expires_in !== undefined && input.expires_at === undefined) {
    return now + BigInt(input.expires_in);
  }
  throw new InvalidInput([{ path: "expires_at", message: "give exactly one of expires_at or expires_in" }]);
}

export const termsInput = {
  owner: account("the wallet that sells and signs; it pays the fees and rent"),
  input_mint: account("the token to sell"),
  output_mint: account("the token to receive"),
  order: orderSchema,
  expires_at: optional(time("unix seconds after which nobody can fill the intent; give exactly one of expires_at and expires_in")),
  expires_in: optional(integer(MIN_EXPIRES_IN, MAX_EXPIRES_IN, "seconds from now until the intent expires; give exactly one of expires_at and expires_in")),
  nonce: optional(amount("leave out to use the owner's next free nonce")),
  partner: optional(partnerSchema),
};

export const termsOutput = {
  intent: account("the address the intent will have"),
  nonce: amount(),
  expires_at: time(),
  escrow: amount("raw input units locked until the intent is filled, cancelled or expired"),
  summary: list(text(), 24, "the terms in plain words; show these to the owner before signing"),
  warnings: list(text(), 16),
};

export const WARN_SCALED =
  "a token here scales the amounts wallets display (interest-bearing or scaled UI amount); the amounts shown are base units at its decimals";

export function warningsOf(kind: Kind, expiresAt: bigint, now: bigint, scaled: boolean): string[] {
  return [
    ...(kind === Kind.AttestedResult ? [WARN_ATTESTOR] : []),
    ...(expiresAt - now > LONG_LIVED_SECONDS ? [WARN_LONG_LIVED] : []),
    ...(scaled ? [WARN_SCALED] : []),
  ];
}

export const prepareCreate = define({
  name: tool("prepare_create"),
  title: "Prepare a new intent",
  description:
    "Build the transaction that escrows the owner's tokens in a new intent: sell exactly the given amount and receive at least the given output before the expiry (for attested orders, an amount set by the attested result), or get everything back. Returns an unsigned transaction that already simulated successfully; the owner's wallet must sign and send it. Nothing moves until then.",
  effect: "prepare",
  input: object(termsInput),
  output: object({
    ...termsOutput,
    create_fee: amount("lamports the owner pays the treasury"),
    crank_bounty: amount("lamports the owner escrows for whoever later expires or closes the intent"),
    wraps: amount("lamports of the owner's SOL wrapped first so the escrow can be drawn from their wrapped SOL account; 0 for other tokens"),
    prepared: preparedSchema,
  }),
  run: async ({ transport, claims }, input, call) => {
    const now = await chainTime(transport);
    const expiresAt = expiryOf(input, now);
    const params = validate(paramsOf(input.order));
    const { config } = await loadConfig(transport);
    const [inputToken, outputToken] = [await mintOf(transport, input.input_mint), await mintOf(transport, input.output_mint)];
    const user = await userOf(transport, input.owner);
    if (input.nonce !== undefined) {
      await unusedIntent(transport, input.owner, input.nonce);
    }
    const nonce = pickNonce(user, input.nonce, claimedBy(claims, input.owner, now));
    claim(claims, call, input.owner, nonce, now + PREPARED_TTL, now);
    const intent = await unusedIntent(transport, input.owner, nonce);
    const owner = createNoopSigner(input.owner);
    const receiver = await tokenAccountIfMissing(
      transport,
      owner,
      input.owner,
      input.output_mint,
      outputToken.tokenProgram,
    );
    const create = await buildCreateIntent({
      owner,
      treasury: config.feeRecipient,
      maxCreateFee: config.createFee,
      maxBounty: config.crankBounty,
      nonce,
      params,
      expiresAt,
      ...(input.partner === undefined ? {} : { partner: { key: input.partner.account, bps: input.partner.bps } }),
      inputMint: input.input_mint,
      outputMint: input.output_mint,
      inputTokenProgram: inputToken.tokenProgram,
      outputTokenProgram: outputToken.tokenProgram,
    });
    const register = await initUserIfMissing(user, input.owner);
    const wrap = await wrapIfShort(transport, input.owner, input.input_mint, inputToken.tokenProgram, escrowAmount(params));
    const prepared = await prepare(transport, [...register, ...receiver.create, ...wrap.instructions, create], input.owner);
    return {
      intent,
      nonce,
      expires_at: expiresAt,
      escrow: escrowAmount(params),
      summary: [
        ...describeTerms(
          { kind: params.kind, params: encodeParams(params), inputMint: input.input_mint, outputMint: input.output_mint },
          { inputDecimals: inputToken.decimals, outputDecimals: outputToken.decimals, ...tokenNames(input.input_mint, input.output_mint) },
        ),
        `Expires: ${formatTime(expiresAt)}`,
        ...(input.partner === undefined ? [] : [`Partner fee: ${input.partner.bps} bps of the sold amount to ${input.partner.account}`]),
        ...setupLines({
          registers: register.length > 0,
          creates: receiver.create.length > 0 ? [input.output_mint] : [],
          allowance: null,
          wraps: wrap.lamports,
        }).lines,
      ],
      warnings: warningsOf(params.kind, expiresAt, now, inputToken.scaled || outputToken.scaled),
      create_fee: BigInt(config.createFee),
      crank_bounty: BigInt(config.crankBounty),
      wraps: wrap.lamports,
      prepared: preparedView(prepared),
    };
  },
});
