import { createNoopSigner } from "@solana/kit";
import {
  buildCreateIntent,
  describeTerms,
  encodeParams,
  escrowAmount,
  findAssociatedTokenAddress,
  findConfigPda,
  findIntentPda,
  findUserStatePda,
  formatTime,
  Kind,
  LONG_LIVED_SECONDS,
  validate,
  WARN_ATTESTOR,
  WARN_LONG_LIVED,
  WARN_RECEIVER,
} from "@intent-engine/core";
import { chainTime, CLOCK_SYSVAR, loadConfig, mintOf } from "../accounts.js";
import { define } from "./actions.js";
import { tool } from "./names.js";
import { claim, claimedBy, PREPARED_TTL } from "./claims.js";
import { initUserIfMissing, pickNonce, setupLines, tokenAccountIfMissing, unusedIntent, userOf, walletRecipient, wrapIfShort } from "./owner.js";
import { NATIVE_MINT } from "../tokens.js";
import { prepare } from "./prepare.js";
import { InvalidInput } from "./schema.js";
import { orderSchema, paramsOf, partnerSchema, preparedSchema, preparedView } from "./shapes.js";
import { tokenNames } from "../tokens.js";
import { account, amount, integer, list, object, optional, text, time } from "./schema.js";

export const WRAPPED = ", as wrapped SOL they unwrap themselves";

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
  input: object({
    ...termsInput,
    pay_to: optional(account("the wallet that receives what the solver pays; default the owner")),
  }),
  output: object({
    ...termsOutput,
    create_fee: amount("lamports the owner pays the treasury"),
    crank_bounty: amount("lamports the owner escrows for whoever later expires or closes the intent"),
    wraps: amount("lamports of the owner's SOL wrapped first so the escrow can be drawn from their wrapped SOL account; 0 for other tokens"),
    prepared: preparedSchema,
  }),
  run: async ({ transport, claims }, input, call) => {
    const [[configAddress], [userAddress]] = await Promise.all([findConfigPda(), findUserStatePda({ owner: input.owner })]);
    await transport.warm?.([CLOCK_SYSVAR, configAddress, input.input_mint, input.output_mint, userAddress]);
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
    const recipient = input.pay_to ?? input.owner;
    if (recipient !== input.owner) {
      await walletRecipient(transport, recipient, "pay_to");
    }
    const [[intentAddress], receiverAddress, sourceAddress] = await Promise.all([
      findIntentPda({ owner: input.owner, nonce }),
      findAssociatedTokenAddress({ owner: recipient, mint: input.output_mint, tokenProgram: outputToken.tokenProgram }),
      findAssociatedTokenAddress({ owner: input.owner, mint: input.input_mint, tokenProgram: inputToken.tokenProgram }),
    ]);
    await transport.warm?.([intentAddress, receiverAddress, sourceAddress]);
    const intent = await unusedIntent(transport, input.owner, nonce);
    const owner = createNoopSigner(input.owner);
    const receiver = await tokenAccountIfMissing(transport, owner, recipient, input.output_mint, outputToken.tokenProgram);
    const elsewhere = recipient !== input.owner;
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
      ...(elsewhere ? { receiver: receiver.address, receiverAuthority: recipient } : {}),
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
        ...(elsewhere ? [`Pays to: ${recipient}, who receives what the solver pays${input.output_mint === NATIVE_MINT ? WRAPPED : ""}`] : []),
        ...(input.partner === undefined ? [] : [`Partner fee: ${input.partner.bps} bps of the sold amount to ${input.partner.account}`]),
        ...setupLines({
          registers: register.length > 0,
          creates: receiver.create.length > 0 && !elsewhere ? [input.output_mint] : [],
          allowance: null,
          wraps: wrap.lamports,
        }).lines,
        ...(receiver.create.length > 0 && elsewhere ? [`Setup: creates ${recipient}'s token account for ${input.output_mint} (you pay its rent)`] : []),
      ],
      warnings: [
        ...warningsOf(params.kind, expiresAt, now, inputToken.scaled || outputToken.scaled),
        ...(elsewhere ? [WARN_RECEIVER] : []),
      ],
      create_fee: BigInt(config.createFee),
      crank_bounty: BigInt(config.crankBounty),
      wraps: wrap.lamports,
      prepared: preparedView(prepared),
    };
  },
});
