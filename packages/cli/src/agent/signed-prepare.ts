import { createNoopSigner, getBase64Decoder, type SignatureBytes } from "@solana/kit";
import {
  buildApproveDelegate,
  buildEd25519Instruction,
  describeSignedIntent,
  escrowAmount,
  formatAmount,
  MEMO_URL_RULE,
  signedIntentMessage,
  validate,
} from "@intent-engine/core";
import {
  chainTime,
  clusterDomain,
  initUserIfMissing,
  loadConfig,
  loadUser,
  mintOf,
  tokenAccountIfMissing,
} from "@intent-engine/client";
import { define } from "./actions.js";
import { tool } from "./names.js";
import { expiryOf, termsInput, termsOutput, warningsOf } from "./create.js";
import { pickNonce, raiseAllowance, setupLines, unusedIntent } from "./owner.js";
import { prepare } from "./prepare.js";
import { AgentRefusal } from "./problems.js";
import { SIGNATURE_FEE } from "./budget.js";
import { refuseCostlyTerms, refuseLongRelay } from "./relay.js";
import { claim, claimedBy } from "./claims.js";
import { paramsOf, preparedSchema, preparedView } from "./shapes.js";
import { tokenNames } from "../tokens.js";
import { account, amount, integer, object, optional, text } from "./schema.js";
import {
  DEFAULT_SUBMIT_WITHIN,
  fieldsOf,
  MAX_SUBMIT_WITHIN,
  published,
  publishedUrl,
  publishesLine,
  signedTerms,
  type SignedTerms,
  SPEC_URL_UNSIGNED,
} from "./signed-terms.js";
import { offeredFee, RELAY_TOO_LARGE, relayCreate, relayFits, relayFloor, SPEC_URL_TOO_LONG } from "./signed-relay.js";

export const prepareSignedIntent = define({
  name: tool("prepare_signed_intent"),
  title: "Prepare a relayer-submitted signed intent",
  description:
    `Build an intent the owner authorises by signing a message off-chain, so a relayer creates it on chain and pays its rent and fees. Steps: (1) the owner signs and sends the returned setup transaction; it registers them, creates the receiving token account and raises the engine's spending allowance on the input token by this intent's escrow plus any relayer fee, and it is the only part that costs the owner SOL: its network fee, which the summary gives in lamports, plus rent for any account it creates; (2) the owner signs message with their wallet's sign-message; (3) pass submit unchanged plus that base58 signature to ${tool("submit_signed_intent")}. When this server runs a relayer, it relays only the input tokens it lists a fee for, the message includes that fee, and the owner pays it in that token as the intent is created; it refuses, before the owner signs or pays anything, an expiry beyond that relayer's longest or a create fee and crank bounty above what it pays; without --relayer this server can prepare but not submit. Read summary and warnings before the owner signs anything.`,
  effect: "prepare",
  input: object({
    ...termsInput,
    owner: account("the wallet that signs the message off-chain; it pays only the setup transaction's network fee and any rent named in the summary, in SOL"),
    submit_within: optional(
      integer(60, MAX_SUBMIT_WITHIN, `seconds the relayer has to submit the signature; default ${DEFAULT_SUBMIT_WITHIN}`),
    ),
    relayer_fee: optional(
      amount("raw input units offered to whoever submits; default and minimum is this server's relayer fee for the input token"),
    ),
    spec_url: optional(
      text(`where the acceptance spec of an attested order with spec_hash is published, ${MEMO_URL_RULE}; passed on in submit for the relayer to record in a memo it signs with the create, so workers find it. It is not part of what the owner signs`),
    ),
  }),
  output: object({
    ...termsOutput,
    message: text("base64 bytes the owner signs with sign-message"),
    digest: text("sha-256 of the signed terms; the wallet shows the same value"),
    submit: object(signedTerms, `pass these unchanged, plus the signature, to ${tool("submit_signed_intent")}`),
    setup: preparedSchema,
  }),
  run: async ({ transport, claims, relay }, input, call) => {
    const now = await chainTime(transport);
    const expiresAt = expiryOf(input, now);
    const params = validate(paramsOf(input.order));
    const specUrl = await publishedUrl(transport, params, input.spec_url);
    if (relay !== undefined) {
      refuseLongRelay(relay, expiresAt, now);
      const { config } = await loadConfig(transport);
      refuseCostlyTerms(relay, BigInt(config.createFee) + BigInt(config.crankBounty));
    }
    const user = await loadUser(transport, input.owner);
    const outputToken = await mintOf(transport, input.output_mint);
    if (input.nonce !== undefined) {
      await unusedIntent(transport, input.owner, input.nonce);
    }
    const terms: SignedTerms = {
      owner: input.owner,
      input_mint: input.input_mint,
      output_mint: input.output_mint,
      order: input.order,
      expires_at: expiresAt,
      nonce: pickNonce(user, input.nonce, claimedBy(claims, input.owner, now)),
      submit_by: now + BigInt(input.submit_within ?? DEFAULT_SUBMIT_WITHIN),
      epoch: user?.epoch ?? 0n,
      relayer_fee: offeredFee(relay === undefined ? 0n : relayFloor(relay, input.input_mint), input.relayer_fee),
      ...(input.partner === undefined ? {} : { partner: input.partner }),
      ...(specUrl === undefined ? {} : { spec_url: specUrl }),
    };
    claim(claims, call, input.owner, terms.nonce, terms.submit_by, now);
    const { config, inputToken, fields } = await fieldsOf(transport, terms, params, outputToken.tokenProgram);
    if (relay !== undefined) {
      const placeholder = buildEd25519Instruction({
        publicKey: input.owner,
        signature: new Uint8Array(64) as SignatureBytes,
        message: await signedIntentMessage(fields),
      });
      const create = await relayCreate(terms, relay, config, params, {
        input: inputToken.tokenProgram,
        output: outputToken.tokenProgram,
      });
      if (!(await relayFits(transport, relay, [placeholder, create, ...published(relay.signer, specUrl)]))) {
        const memoOnly = specUrl !== undefined && (await relayFits(transport, relay, [placeholder, create]));
        throw new AgentRefusal("RelayTooLarge", memoOnly ? SPEC_URL_TOO_LONG : RELAY_TOO_LARGE);
      }
    }
    const description = await describeSignedIntent(fields, {
      now,
      currentEpoch: terms.epoch,
      expectedDomain: await clusterDomain(transport),
      outputTokenProgram: outputToken.tokenProgram,
      inputDecimals: inputToken.decimals,
      outputDecimals: outputToken.decimals,
      ...tokenNames(fields.inputMint, fields.outputMint),
    });
    const escrow = escrowAmount(params);
    const allowance = await raiseAllowance(transport, input.owner, fields.ownerInput, escrow + terms.relayer_fee);
    const receiver = await tokenAccountIfMissing(transport, createNoopSigner(input.owner), input.owner, input.output_mint, outputToken.tokenProgram);
    const approve = await buildApproveDelegate({
      owner: createNoopSigner(input.owner),
      mint: input.input_mint,
      tokenProgram: inputToken.tokenProgram,
      amount: allowance.after,
      decimals: inputToken.decimals,
    });
    const register = await initUserIfMissing(user, input.owner);
    const setup = [...register, ...receiver.create, approve];
    const intent = await unusedIntent(transport, input.owner, terms.nonce);
    const disclosed = setupLines({
      registers: register.length > 0,
      creates: receiver.create.length > 0 ? [input.output_mint] : [],
      allowance,
      decimals: inputToken.decimals,
    });
    const ready = await prepare(transport, setup, input.owner);
    const prepared = preparedView(ready);
    const setupFee = SIGNATURE_FEE * BigInt(ready.signers.length) + ready.priorityLamports;
    return {
      intent,
      nonce: terms.nonce,
      expires_at: expiresAt,
      escrow,
      summary: [
        ...description.lines,
        terms.relayer_fee === 0n
          ? `Cost to you: no relayer fee; only ${setupFee} lamports of SOL for the setup transaction's network fee, once`
          : `Cost to you: ${formatAmount(terms.relayer_fee, inputToken.decimals)} of ${input.input_mint} to the relayer, plus ${setupFee} lamports of SOL for the setup transaction's network fee, once`,
        ...(specUrl === undefined ? [] : [publishesLine(specUrl)]),
        ...disclosed.lines,
      ],
      warnings: [
        ...new Set([
          ...warningsOf(params, expiresAt, now, inputToken.scaled || outputToken.scaled),
          ...description.warnings,
          ...disclosed.warnings,
          ...(specUrl === undefined ? [] : [SPEC_URL_UNSIGNED]),
        ]),
      ],
      message: getBase64Decoder().decode(await signedIntentMessage(fields)),
      digest: description.digest,
      submit: terms,
      setup: prepared,
    };
  },
});
