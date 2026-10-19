import { getPublicKeyFromAddress, verifySignature } from "@solana/kit";
import {
  buildEd25519Instruction,
  describeSignedIntent,
  formatAmount,
  findIntentPda,
  getIntentDecoder,
  signedIntentMessage,
  validate,
} from "@intent-engine/core";
import {
  chainTime,
  clusterDomain,
  createdAccount,
  loadUser,
  mintCapOf,
  mintOf,
  tokenAccountIfMissing,
  type Transport,
} from "@intent-engine/client";
import { define } from "./actions.js";
import { tool } from "./names.js";
import { escrowJudge } from "./create.js";
import { prepare } from "./prepare.js";
import { AgentRefusal } from "./problems.js";
import { createCost, rentFor, rentRate, SIGNATURE_FEE, TOKEN_ACCOUNT_RENT_BYTES } from "./budget.js";
import { admitRelay, type Relay } from "./relay.js";
import { type Call, enter } from "./claims.js";
import { paramsOf } from "./shapes.js";
import { tokenNames } from "../tokens.js";
import { account, amount, integer, list, nullable, object, text } from "./schema.js";
import {
  fieldsOf,
  published,
  publishedUrl,
  publishesLine,
  sameTerms,
  signatureBytes,
  signedTerms,
  type SignedTerms,
  SPEC_URL_UNSIGNED,
} from "./signed-terms.js";
import {
  paying,
  preparedFits,
  RELAY_TOO_LARGE,
  relayCreate,
  relayFloor,
  refuseRepricing,
  SPEC_URL_TOO_LONG,
} from "./signed-relay.js";

export const submitSignedIntent = define({
  name: tool("submit_signed_intent"),
  title: "Submit a signed intent",
  description:
    `Relay an owner's signed intent: the relayer key this server was started with (--relayer) pays the fee and creates the intent on chain, within the relayer's limits: accepted input tokens and their minimum fee, lamport cost per intent and per hour, expiry, transaction size and intents per owner per hour. Pass the submit object from ${tool("prepare_signed_intent")} unchanged plus the owner's base58 signature of its message; ${tool("preview_signed_intent")} checks the same input first without sending. When submit carries a spec_url, the relayer also records it in a memo it signs with the create, so ${tool("find_jobs")} lists it; that url is not part of the owner's signature. Calling again after success returns the same intent without sending anything.`,
  effect: "submit",
  input: object({ ...signedTerms, signature: text("the owner's base58 Ed25519 signature of the message") }),
  output: object({ intent: account(), signature: nullable(text("the relayed transaction's signature; null if it already existed")) }),
  run: async ({ transport, relay, claims }, input, call) => {
    if (relay === undefined) {
      throw new AgentRefusal("RelayerNotConfigured", "this server has no relayer key; start it with --relayer to submit signed intents");
    }
    const leave = enter(claims, `${input.owner}:${input.nonce}`);
    try {
      return await relaySigned(transport, relay, input, call);
    } finally {
      leave();
    }
  },
});

async function relaySigned(transport: Transport, relay: Relay, input: SignedTerms & { signature: string }, call: Call) {
  const params = validate(paramsOf(input.order));
  const specUrl = await publishedUrl(transport, params, input.spec_url);
  const outputToken = await mintOf(transport, input.output_mint);
  const { config, inputToken, fields } = await fieldsOf(transport, input, params, outputToken.tokenProgram);
  const [intent] = await findIntentPda({ owner: input.owner, nonce: input.nonce });
  const existing = await createdAccount(transport, intent);
  if (existing !== null) {
    if (!sameTerms(getIntentDecoder().decode(existing.data), fields)) {
      throw new AgentRefusal(
        "NonceTaken",
        "a different intent already uses this owner's nonce; these signed terms can never be submitted",
      );
    }
    return { intent, signature: null };
  }
  const floor = relayFloor(relay, input.input_mint);
  if (input.relayer_fee < floor) {
    throw new AgentRefusal(
      "RelayFeeTooLow",
      `this relayer charges ${floor} raw units of ${input.input_mint} per intent; prepare and sign the intent again on this server`,
    );
  }
  const message = await signedIntentMessage(fields);
  const signature = signatureBytes(input.signature);
  if (!(await verifySignature(await getPublicKeyFromAddress(input.owner), signature, message))) {
    throw new AgentRefusal(
      "SignatureInvalid",
      `the signature is not the owner's signature of these exact terms; sign the message from ${tool("prepare_signed_intent")} again`,
    );
  }
  const feeAccount =
    input.relayer_fee === 0n
      ? { create: [] }
      : await tokenAccountIfMissing(
          transport,
          relay.signer,
          relay.signer.address,
          input.input_mint,
          inputToken.tokenProgram,
        );
  const relayed = [
    buildEd25519Instruction({ publicKey: input.owner, signature, message }),
    await relayCreate(
      input,
      relay,
      config,
      params,
      { input: inputToken.tokenProgram, output: outputToken.tokenProgram },
      await mintCapOf(transport, input.input_mint),
      (await escrowJudge(transport, config, input.input_mint, params, inputToken.decimals)).committee,
    ),
    ...published(relay.signer, specUrl),
  ];
  const now = await chainTime(transport);
  let prepared = await prepare(transport, [...feeAccount.create, ...relayed], relay.signer.address);
  const split = feeAccount.create.length !== 0 && !preparedFits(prepared);
  const rate = await rentRate(transport);
  const ticket = admitRelay(
    relay,
    input.owner,
    BigInt(config.createFee) + BigInt(config.crankBounty) + prepared.priorityLamports,
    createCost(config, rate) +
      prepared.priorityLamports +
      (feeAccount.create.length > 0 ? rentFor(TOKEN_ACCOUNT_RENT_BYTES, rate) : 0n) +
      (split ? SIGNATURE_FEE + prepared.priorityLamports : 0n),
    input.expires_at,
    now,
  );
  const paid = { any: false };
  call.undo.push(() => {
    if (!paid.any) {
      ticket.cancel();
    }
  });
  const admitted = prepared.priorityLamports;
  if (split) {
    await paying(paid, transport.send(feeAccount.create, relay.signer));
    prepared = await prepare(transport, relayed, relay.signer.address);
    refuseRepricing(admitted, prepared.priorityLamports);
  }
  if (!preparedFits(prepared)) {
    throw new AgentRefusal("RelayTooLarge", specUrl === undefined ? RELAY_TOO_LARGE : SPEC_URL_TOO_LONG);
  }
  return { intent, signature: await paying(paid, transport.send(prepared.instructions, relay.signer)) };
}

export const previewSignedIntent = define({
  name: tool("preview_signed_intent"),
  title: "Check a signed intent before relaying it",
  description: `Verify an owner's signature over signed terms and describe what relaying them creates, without sending anything.`,
  effect: "read",
  input: object({ ...signedTerms, signature: text("the owner's base58 Ed25519 signature of the message") }),
  output: object({
    intent: account(),
    exists: integer(0, 1, "1 if the intent is already on chain, else 0"),
    relayer_fee: amount("raw input-token units the relayer receives"),
    summary: list(text(), 32, "what relaying creates"),
    warnings: list(text(), 16, "anything to check before relaying"),
  }),
  run: async ({ transport }, input) => {
    const params = validate(paramsOf(input.order));
    const specUrl = await publishedUrl(transport, params, input.spec_url);
    const outputToken = await mintOf(transport, input.output_mint);
    const { config, inputToken, fields } = await fieldsOf(transport, input, params, outputToken.tokenProgram);
    const message = await signedIntentMessage(fields);
    if (!(await verifySignature(await getPublicKeyFromAddress(input.owner), signatureBytes(input.signature), message))) {
      throw new AgentRefusal("SignatureInvalid", "the signature is not the owner's signature of these exact terms");
    }
    const [intent] = await findIntentPda({ owner: input.owner, nonce: input.nonce });
    const exists = (await createdAccount(transport, intent)) !== null;
    const user = await loadUser(transport, input.owner);
    const description = await describeSignedIntent(fields, {
      now: await chainTime(transport),
      currentEpoch: user?.epoch ?? 0n,
      expectedDomain: await clusterDomain(transport),
      outputTokenProgram: outputToken.tokenProgram,
      inputDecimals: inputToken.decimals,
      outputDecimals: outputToken.decimals,
      ...tokenNames(fields.inputMint, fields.outputMint),
    });
    return {
      intent,
      exists: exists ? 1 : 0,
      relayer_fee: input.relayer_fee,
      summary: [
        ...description.lines,
        `Relaying costs you ${createCost(config, await rentRate(transport))} lamports in create fee, crank bounty, rent and signature fee, plus any priority fee; you receive ${formatAmount(input.relayer_fee, inputToken.decimals)} of ${input.input_mint}`,
        ...(specUrl === undefined ? [] : [publishesLine(specUrl)]),
      ],
      warnings: [...description.warnings, ...(specUrl === undefined ? [] : [SPEC_URL_UNSIGNED])],
    };
  },
});
