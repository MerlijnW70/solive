import {
  type Address,
  createNoopSigner,
  getBase58Encoder,
  getBase64Decoder,
  getBase64Encoder,
  type Instruction,
  getPublicKeyFromAddress,
  type SignatureBytes,
  verifySignature,
} from "@solana/kit";
import {
  buildApproveDelegate,
  buildCreateIntentSigned,
  buildEd25519Instruction,
  createExt,
  describeSignedIntent,
  encodeParams,
  escrowAmount,
  findAssociatedTokenAddress,
  formatAmount,
  findIntentPda,
  getIntentDecoder,
  type Intent,
  type IntentParams,
  partnerOf,
  type SignedIntentFields,
  signedIntentMessage,
  validate,
} from "@intent-engine/core";
import { define } from "./actions.js";
import { tool } from "./names.js";
import { expiryOf, termsInput, termsOutput, warningsOf } from "./create.js";
import { pickNonce, raiseAllowance, setupLines, unusedIntent } from "./owner.js";
import { prepare, type Prepared, transactionSize } from "./prepare.js";
import { AgentRefusal } from "./problems.js";
import { createCost, rentFor, SIGNATURE_FEE, TOKEN_ACCOUNT_RENT_BYTES } from "./budget.js";
import { bytesFit } from "@intent-engine/solver";
import {
  chainTime,
  Charged,
  clusterDomain,
  createdAccount,
  initUserIfMissing,
  loadConfig,
  loadUser,
  mintOf,
  tokenAccountIfMissing,
  type Transport,
} from "@intent-engine/client";
import { admitRelay, type Relay, refuseCostlyTerms, refuseLongRelay } from "./relay.js";
import { type Call, claim, claimedBy, enter } from "./claims.js";
import { type Order, orderSchema, paramsOf, partnerSchema, preparedSchema, preparedView } from "./shapes.js";
import { tokenNames } from "../tokens.js";
import { account, amount, integer, list, nullable, object, optional, text, time } from "./schema.js";

export const DEFAULT_SUBMIT_WITHIN = 60 * 60;
export const MAX_SUBMIT_WITHIN = 24 * 60 * 60;
const SIGNATURE_PATTERN = "^[1-9A-HJ-NP-Za-km-z]{64,88}$";

const signedTerms = {
  owner: account("the wallet that signs the message and sells"),
  input_mint: account(),
  output_mint: account(),
  order: orderSchema,
  expires_at: time(),
  nonce: amount(),
  submit_by: time("unix seconds after which the signature can no longer be submitted"),
  epoch: amount("the owner's signing epoch the signature is bound to"),
  relayer_fee: amount("raw input units the owner pays, from the same allowance, to whoever submits the signature"),
  partner: optional(partnerSchema),
};

type SignedTerms = {
  owner: Address;
  input_mint: Address;
  output_mint: Address;
  order: Order;
  expires_at: bigint;
  nonce: bigint;
  submit_by: bigint;
  epoch: bigint;
  relayer_fee: bigint;
  partner?: { account: Address; bps: number };
};

async function fieldsOf(transport: Transport, t: SignedTerms, params: IntentParams, outputTokenProgram: Address) {
  const { config } = await loadConfig(transport);
  const inputToken = await mintOf(transport, t.input_mint);
  const fields: SignedIntentFields = {
    domain: Uint8Array.from(config.domain),
    owner: t.owner,
    ownerInput: await findAssociatedTokenAddress({ owner: t.owner, mint: t.input_mint, tokenProgram: inputToken.tokenProgram }),
    inputMint: t.input_mint,
    outputMint: t.output_mint,
    receiver: await findAssociatedTokenAddress({ owner: t.owner, mint: t.output_mint, tokenProgram: outputTokenProgram }),
    nonce: t.nonce,
    expiresAt: t.expires_at,
    submitBy: t.submit_by,
    kind: params.kind,
    params: encodeParams(params),
    epoch: t.epoch,
    relayerFee: t.relayer_fee,
    ext: createExt(t.partner === undefined ? {} : { partner: { key: t.partner.account, bps: t.partner.bps } }),
  };
  return { config, inputToken, fields };
}

function relayFloor(relay: Relay, mint: Address): bigint {
  const floor = relay.fees.get(mint);
  if (floor === undefined) {
    throw new AgentRefusal(
      "RelayMintNotAccepted",
      `this server's relayer does not relay intents selling ${mint}; it relays only ${[...relay.fees.keys()].join(", ")}`,
    );
  }
  return floor;
}

export const RELAY_TOO_LARGE =
  "this server's relayer cannot fit these signed terms in one Solana transaction; drop the partner fee or use a relayer that adds no priority fee";

async function relayCreate(
  input: SignedTerms,
  relay: Relay,
  config: { feeRecipient: Address; createFee: number; crankBounty: number },
  params: IntentParams,
  tokenPrograms: { input: Address; output: Address },
): Promise<Instruction> {
  return buildCreateIntentSigned({
    payer: relay.signer,
    owner: input.owner,
    treasury: config.feeRecipient,
    maxCreateFee: config.createFee,
    maxBounty: config.crankBounty,
    nonce: input.nonce,
    params,
    expiresAt: input.expires_at,
    ...(input.partner === undefined ? {} : { partner: { key: input.partner.account, bps: input.partner.bps } }),
    inputMint: input.input_mint,
    outputMint: input.output_mint,
    inputTokenProgram: tokenPrograms.input,
    outputTokenProgram: tokenPrograms.output,
    submitBy: input.submit_by,
    relayerFee: input.relayer_fee,
  });
}

async function relayFits(transport: Transport, relay: Relay, instructions: readonly Instruction[]): Promise<boolean> {
  const budgeted = await transport.budget(instructions, relay.signer.address);
  return bytesFit(await transactionSize(transport, budgeted, relay.signer.address));
}

const preparedFits = (prepared: Prepared): boolean => bytesFit(getBase64Encoder().encode(prepared.transaction).length);

function offeredFee(floor: bigint, offered: bigint | undefined): bigint {
  if (offered === undefined) {
    return floor;
  }
  if (offered < floor) {
    throw new AgentRefusal(
      "RelayFeeTooLow",
      `this server's relayer charges ${floor} raw units of the input token; offer at least that or leave relayer_fee out`,
    );
  }
  return offered;
}

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
      if (!(await relayFits(transport, relay, [placeholder, create]))) {
        throw new AgentRefusal("RelayTooLarge", RELAY_TOO_LARGE);
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
        ...disclosed.lines,
      ],
      warnings: [
        ...new Set([
          ...warningsOf(params, expiresAt, now, inputToken.scaled || outputToken.scaled),
          ...description.warnings,
          ...disclosed.warnings,
        ]),
      ],
      message: getBase64Decoder().decode(await signedIntentMessage(fields)),
      digest: description.digest,
      submit: terms,
      setup: prepared,
    };
  },
});

export const submitSignedIntent = define({
  name: tool("submit_signed_intent"),
  title: "Submit a signed intent",
  description:
    `Relay an owner's signed intent: the relayer key this server was started with (--relayer) pays the fee and creates the intent on chain, within the relayer's limits: accepted input tokens and their minimum fee, lamport cost per intent and per hour, expiry, transaction size and intents per owner per hour. Pass the submit object from ${tool("prepare_signed_intent")} unchanged plus the owner's base58 signature of its message. Calling again after success returns the same intent without sending anything.`,
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
    await relayCreate(input, relay, config, params, { input: inputToken.tokenProgram, output: outputToken.tokenProgram }),
  ];
  const now = await chainTime(transport);
  let prepared = await prepare(transport, [...feeAccount.create, ...relayed], relay.signer.address);
  const split = feeAccount.create.length !== 0 && !preparedFits(prepared);
  const ticket = admitRelay(
    relay,
    input.owner,
    BigInt(config.createFee) + BigInt(config.crankBounty) + prepared.priorityLamports,
    createCost(config) +
      prepared.priorityLamports +
      (feeAccount.create.length > 0 ? rentFor(TOKEN_ACCOUNT_RENT_BYTES) : 0n) +
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
    throw new AgentRefusal("RelayTooLarge", RELAY_TOO_LARGE);
  }
  return { intent, signature: await paying(paid, transport.send(prepared.instructions, relay.signer)) };
}

export async function paying<T>(paid: { any: boolean }, sending: Promise<T>): Promise<T> {
  try {
    const result = await sending;
    paid.any = true;
    return result;
  } catch (error) {
    if (error instanceof Charged) {
      paid.any = true;
    }
    throw error;
  }
}

export const repriced = (admitted: bigint, now: bigint) =>
  `the priority fee rose from the admitted ${admitted} to ${now} lamports while relaying; ask again later`;

export function refuseRepricing(admitted: bigint, now: bigint): void {
  if (now > admitted) {
    throw new AgentRefusal("RelayTooCostly", repriced(admitted, now));
  }
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
        `Relaying costs you ${createCost(config)} lamports in create fee, crank bounty, rent and signature fee, plus any priority fee; you receive ${formatAmount(input.relayer_fee, inputToken.decimals)} of ${input.input_mint}`,
      ],
      warnings: description.warnings,
    };
  },
});

export function sameTerms(stored: Intent, fields: SignedIntentFields): boolean {
  const partner = partnerOf(fields.ext ?? new Uint8Array());
  return (
    stored.inputMint === fields.inputMint &&
    stored.outputMint === fields.outputMint &&
    stored.receiver === fields.receiver &&
    stored.expiresAt === fields.expiresAt &&
    stored.kind === fields.kind &&
    stored.flags === (fields.flags ?? 0) &&
    stored.partnerBps === (partner?.bps ?? 0) &&
    (partner === undefined || stored.partner === partner.key) &&
    stored.params.length === fields.params.length &&
    stored.params.every((byte, i) => byte === fields.params[i])
  );
}

function signatureBytes(text: string): SignatureBytes {
  const bytes = new RegExp(SIGNATURE_PATTERN).test(text) ? getBase58Encoder().encode(text) : new Uint8Array();
  if (bytes.length !== 64) {
    throw new AgentRefusal("SignatureMalformed", "the signature must be 64 bytes written in base58");
  }
  return bytes as SignatureBytes;
}
