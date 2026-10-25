import { createNoopSigner } from "@solana/kit";
import { findAssociatedTokenAddress } from "@intent-engine/core";
import { buildApproveDelegate, buildCreateMandate, describeMandate, findMandatePda, type MandateSpec, mandateKinds } from "@intent-engine/core/internal";
import { chainTime, initUserIfMissing, loadUser, mintOf, tokenAccountIfMissing, wrapIfShort } from "@intent-engine/client/internal";
import { define } from "./actions.js";
import { MAX_EXPIRES_IN, MIN_EXPIRES_IN, WARN_SCALED } from "./create.js";
import { tool } from "./names.js";
import { raiseAllowance, setupLines } from "./owner.js";
import { prepare } from "./prepare.js";
import { decimalsFor } from "./read.js";
import { partnerSchema, preparedSchema, preparedView } from "./shapes.js";
import { tokenNames } from "../tokens.js";
import { account, amount, choice, integer, list, nullable, object, optional, text, time, InvalidInput } from "./schema.js";
import {
  freeMandateId,
  kindBits,
  loadMandate,
  MANDATE_KIND_NAMES,
  mandateRef,
  MAX_MANDATE_INTENTS,
  MAX_MANDATE_SECONDS,
  specOf,
} from "./mandate-state.js";

export const prepareMandate = define({
  name: tool("prepare_mandate"),
  title: "Prepare a mandate for an agent",
  description: `Build the one transaction an owner signs to let an agent key create intents on their behalf, within limits the program enforces: one token pair, the allowed kinds, a cap per intent, a total budget, a maximum number of intents, a maximum lifetime per intent, a price floor and an end date. Proceeds always go to the owner. The owner pays this transaction's fee and rent; the agent pays the network fee and rent of every intent it creates. The owner may grant the agent a fee per intent in the input token, which counts against every limit. The transaction also registers the owner and creates their output token account if needed, and raises the engine's spending allowance on the input token by the total budget. Revoke with ${tool("prepare_revoke_mandate")}.`,
  effect: "prepare",
  input: object({
    owner: account("the wallet that grants the mandate and signs"),
    agent: account("the agent key that may create intents"),
    input_mint: account("the only token the agent may sell"),
    output_mint: account("the only token the agent may buy"),
    kinds: list(choice(MANDATE_KIND_NAMES), 3, "the intent kinds the agent may create", 1),
    per_intent: amount("most raw input units one intent may draw, agent fee included"),
    total: amount("most raw input units all the agent's intents may sell together"),
    max_intents: integer(1, MAX_MANDATE_INTENTS, "most intents the agent may create"),
    max_ttl: integer(MIN_EXPIRES_IN, MAX_EXPIRES_IN, "longest an intent may stay open, in seconds"),
    valid_for: integer(MIN_EXPIRES_IN, MAX_MANDATE_SECONDS, "seconds from now until the mandate ends"),
    floor: object(
      {
        out: amount("raw output units"),
        in: amount("raw input units"),
      },
      "the worst price in raw units: every intent must ask at least out raw output units for every in raw input units it draws, fee included; one whole token is 10^decimals raw units, and get_balances gives the decimals",
    ),
    id: optional(amount("leave out to use the next free id")),
    partner: optional(partnerSchema),
    agent_fee: optional(
      amount("raw input units the agent takes from the owner per intent; counted in per_intent, total and the price floor; default 0"),
    ),
  }),
  output: object({
    mandate: account(),
    id: amount(),
    valid_until: time(),
    summary: list(text(), 24, "the grant in plain words; show these to the owner before signing"),
    warnings: list(text(), 4),
    prepared: preparedSchema,
  }),
  run: async ({ transport }, input) => {
    const now = await chainTime(transport);
    if (input.agent_fee === undefined && input.per_intent === 0n) {
      throw new InvalidInput([{ path: "per_intent", message: "must be more than 0" }]);
    }
    if (input.agent_fee !== undefined && input.agent_fee >= input.per_intent) {
      throw new InvalidInput([{ path: "agent_fee", message: "must be less than per_intent, which includes it" }]);
    }
    const id = input.id ?? (await freeMandateId(transport, input.owner, input.agent));
    const spec: MandateSpec = {
      id,
      agent: input.agent,
      kinds: kindBits(input.kinds),
      perIntent: input.per_intent,
      total: input.total,
      maxIntents: input.max_intents,
      maxTtl: BigInt(input.max_ttl),
      validUntil: now + BigInt(input.valid_for),
      floorOut: input.floor.out,
      floorIn: input.floor.in,
      ...(input.partner === undefined ? {} : { partner: { key: input.partner.account, bps: input.partner.bps } }),
      ...(input.agent_fee === undefined ? {} : { agentFee: input.agent_fee }),
    };
    const inputToken = await mintOf(transport, input.input_mint);
    const outputToken = await mintOf(transport, input.output_mint);
    const described = describeMandate(spec, {
      inputMint: input.input_mint,
      outputMint: input.output_mint,
      ...tokenNames(input.input_mint, input.output_mint),
      now,
      inputDecimals: inputToken.decimals,
      outputDecimals: outputToken.decimals,
    });
    const owner = createNoopSigner(input.owner);
    const source = await findAssociatedTokenAddress({
      owner: input.owner,
      mint: input.input_mint,
      tokenProgram: inputToken.tokenProgram,
    });
    const allowance = await raiseAllowance(transport, input.owner, source, spec.total);
    const register = await initUserIfMissing(await loadUser(transport, input.owner), input.owner);
    const receiver = await tokenAccountIfMissing(transport, owner, input.owner, input.output_mint, outputToken.tokenProgram);
    const wrap = await wrapIfShort(transport, input.owner, input.input_mint, inputToken.tokenProgram, spec.total);
    const instructions = [
      ...register,
      ...receiver.create,
      ...wrap.instructions,
      await buildApproveDelegate({
        owner,
        mint: input.input_mint,
        tokenProgram: inputToken.tokenProgram,
        amount: allowance.after,
        decimals: inputToken.decimals,
      }),
      await buildCreateMandate({
        owner,
        inputMint: input.input_mint,
        outputMint: input.output_mint,
        inputTokenProgram: inputToken.tokenProgram,
        outputTokenProgram: outputToken.tokenProgram,
        mandate: spec,
        ownerInput: source,
        receiver: receiver.address,
      }),
    ];
    const disclosed = setupLines({
      registers: register.length > 0,
      creates: receiver.create.length > 0 ? [input.output_mint] : [],
      allowance,
      decimals: inputToken.decimals,
      wraps: wrap.lamports,
    });
    const prepared = preparedView(await prepare(transport, instructions, input.owner));
    const [mandate] = await findMandatePda({ owner: input.owner, agent: input.agent, id });
    return {
      mandate,
      id,
      valid_until: spec.validUntil,
      summary: [...described.lines, `Proceeds go to ${receiver.address}; the agent spends only from ${source}`, ...disclosed.lines],
      warnings: [
        ...described.warnings,
        ...disclosed.warnings,
        ...(inputToken.scaled || outputToken.scaled ? [WARN_SCALED] : []),
      ],
      prepared,
    };
  },
});

export const getMandate = define({
  name: tool("get_mandate"),
  title: "Read a mandate",
  description:
    "Read a mandate: its limits, how much of its budget and intent count the agent has used, and whether it is active, expired, or revoked because the owner advanced their signing epoch. A mandate the owner revoked outright is closed, so reading it fails with NotFound.",
  effect: "read",
  input: object(mandateRef),
  output: object({
    mandate: account(),
    owner: account(),
    agent: account(),
    id: amount(),
    status: choice(["active", "expired", "revoked"]),
    input_mint: account(),
    output_mint: account(),
    kinds: list(choice(MANDATE_KIND_NAMES), 3),
    per_intent: amount(),
    total: amount(),
    spent: amount(),
    remaining: amount("raw input units the agent may still sell"),
    max_intents: integer(0, 0xffff_ffff),
    intents: integer(0, 0xffff_ffff),
    max_ttl: time(),
    valid_until: time(),
    floor: object({ out: amount(), in: amount() }),
    partner: nullable(partnerSchema),
    agent_fee: amount("raw input units each intent pays the agent"),
    summary: list(text(), 16),
  }),
  run: async ({ transport }, input) => {
    const { address, mandate } = await loadMandate(transport, input.owner, input.agent, input.id ?? 0n);
    const now = await chainTime(transport);
    const decimals = await decimalsFor(transport, new Map(), mandate.inputMint, mandate.outputMint);
    const user = await loadUser(transport, input.owner);
    const status = user?.epoch !== mandate.epoch ? "revoked" : now >= mandate.validUntil ? "expired" : "active";
    return {
      mandate: address,
      owner: mandate.owner,
      agent: mandate.agent,
      id: mandate.id,
      status,
      input_mint: mandate.inputMint,
      output_mint: mandate.outputMint,
      kinds: mandateKinds(mandate.kinds),
      per_intent: mandate.perIntent,
      total: mandate.total,
      spent: mandate.spent,
      remaining: mandate.total - mandate.spent,
      max_intents: mandate.maxIntents,
      intents: mandate.intents,
      max_ttl: mandate.maxTtl,
      valid_until: mandate.validUntil,
      floor: { out: mandate.floorOut, in: mandate.floorIn },
      partner: mandate.partnerBps === 0 ? null : { account: mandate.partner, bps: mandate.partnerBps },
      agent_fee: mandate.agentFee,
      summary: describeMandate(specOf(mandate), { inputMint: mandate.inputMint, outputMint: mandate.outputMint, now, ...decimals, ...tokenNames(mandate.inputMint, mandate.outputMint) }).lines,
    };
  },
});
