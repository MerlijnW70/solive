import { type Address, createNoopSigner, type TransactionSigner } from "@solana/kit";
import { getRevokeInstruction } from "@solana-program/token";
import {
  buildApproveDelegate,
  buildCancelIntent,
  buildCreateIntentByAgent,
  buildCreateMandate,
  buildRevokeMandate,
  describeMandate,
  describeTerms,
  encodeParams,
  escrowAmount,
  findIntentPda,
  findMandatePda,
  formatAmount,
  formatTime,
  getIntentDecoder,
  getMandateDecoder,
  IntentStatus,
  getMandateDiscriminatorBytes,
  Kind,
  kindBit,
  type Mandate,
  type MandateSpec,
  findAssociatedTokenAddress,
  mandateLane,
  mandateKinds,
  validate,
  tokenOf,
} from "@intent-engine/core";
import {
  chainTime,
  createdAccount,
  engineAccount,
  loadConfig,
  loadUser,
  mintOf,
  MissingAccount,
  tokenProgramOf,
  type Transport,
} from "@intent-engine/client";
import { vaultBalance } from "../crank.js";
import { type AgentContext, define } from "./actions.js";
import { createCost, release, rentFor, reserve, TOKEN_ACCOUNT_RENT_BYTES } from "./budget.js";
import { expiryOf, MAX_EXPIRES_IN, MIN_EXPIRES_IN, WARN_SCALED } from "./create.js";
import { tool } from "./names.js";
import {
  initUserIfMissing,
  lowerAllowance,
  raiseAllowance,
  setupLines,
  tokenAccountIfMissing,
  wrapIfShort,
  unusedIntent,
} from "./owner.js";
import { prepare } from "./prepare.js";
import { paying } from "./signed.js";
import { type Call, claim, claimedBy, type Claims, PREPARED_TTL } from "./claims.js";
import { decimalsFor } from "./read.js";
import { AgentRefusal, SimulationFailed } from "./problems.js";
import { orderSchema, paramsOf, partnerSchema, preparedSchema, preparedView } from "./shapes.js";
import { TOKEN_NAMES, tokenNames } from "../tokens.js";
import {
  account,
  amount,
  choice,
  integer,
  list,
  nullable,
  object,
  optional,
  text,
  time,
  InvalidInput,
} from "./schema.js";

export const MANDATE_KIND_NAMES = ["swap", "limit", "dutch"] as const;
const MAX_MANDATE_SECONDS = 365 * 24 * 60 * 60;
const MAX_MANDATE_INTENTS = 1_000_000;
export const MANDATE_ID_PROBES = 64;
export const REVOKE_CANCELS = 6;

const KIND_OF = { swap: Kind.SwapExactIn, limit: Kind.LimitOrder, dutch: Kind.DutchAuction } as const;

const kindBits = (names: readonly (typeof MANDATE_KIND_NAMES)[number][]): number =>
  names.reduce((bits, name) => bits | Number(kindBit(KIND_OF[name])), 0);

export const NO_MANDATE_HINT = "it was never granted, or the owner revoked it, which closes it";

const WARN_STILL_OPEN =
  "some of the agent's intents stay open after this; they can no longer be filled, but their escrow stays locked until you cancel them";

export async function loadMandate(transport: Transport, owner: Address, agent: Address, id: bigint) {
  const [address] = await findMandatePda({ owner, agent, id });
  const data = await engineAccount(transport, address, getMandateDiscriminatorBytes(), "mandate").catch((error: unknown) => {
    if (error instanceof MissingAccount) {
      error.message = `${error.message}; ${NO_MANDATE_HINT}`;
    }
    throw error;
  });
  return { address, mandate: getMandateDecoder().decode(data) };
}

function specOf(m: Mandate): MandateSpec {
  return {
    id: m.id,
    agent: m.agent,
    kinds: m.kinds,
    perIntent: m.perIntent,
    total: m.total,
    maxIntents: m.maxIntents,
    maxTtl: m.maxTtl,
    validUntil: m.validUntil,
    floorOut: m.floorOut,
    floorIn: m.floorIn,
    ...(m.partnerBps === 0 ? {} : { partner: { key: m.partner, bps: m.partnerBps } }),
    agentFee: m.agentFee,
  };
}

function limitsOf(m: Mandate): string {
  return `this mandate allows at most ${m.perIntent} raw input units per intent including the agent fee of ${m.agentFee}, ${m.total - m.spent} more raw input units in total, ${m.maxIntents - m.intents} more intents, each expiring within ${m.maxTtl} seconds, and at least ${m.floorOut} raw output units for every ${m.floorIn} raw input units it draws`;
}

function explained(m: Mandate): (error: unknown) => never {
  return (error) => {
    if (error instanceof SimulationFailed && error.problem.code.startsWith("Mandate")) {
      throw new SimulationFailed({ ...error.problem, hint: `${error.problem.hint}; ${limitsOf(m)}` });
    }
    throw error;
  };
}

export const AGENT_NONCE_PROBES = 64n;

type Holding = { claims: Claims; call: Call; now: bigint };

export async function agentNonce(
  transport: Transport,
  owner: Address,
  serial: bigint,
  used: number,
  hold: Holding,
): Promise<bigint> {
  const lane = mandateLane(serial);
  if (lane === null) {
    throw new AgentRefusal("NoFreeNonce", "this mandate's grant serial has no nonce lane; the owner must grant a new mandate");
  }
  for (let k = 0n; k < AGENT_NONCE_PROBES; k++) {
    const nonce = lane | ((BigInt(used) + k) & 0xffff_ffffn);
    if (claimedBy(hold.claims, owner, hold.now).has(nonce)) {
      continue;
    }
    const [intent] = await findIntentPda({ owner, nonce });
    const taken = (await createdAccount(transport, intent)) !== null;
    if (!taken && !claimedBy(hold.claims, owner, hold.now).has(nonce)) {
      claim(hold.claims, hold.call, owner, nonce, hold.now + PREPARED_TTL, hold.now);
      return nonce;
    }
  }
  throw new AgentRefusal("NoFreeNonce", "this mandate's nonce lane is crowded; close some of its finished intents first");
}

export async function freeMandateId(transport: Transport, owner: Address, agent: Address): Promise<bigint> {
  for (let id = 0n; id < BigInt(MANDATE_ID_PROBES); id++) {
    const [address] = await findMandatePda({ owner, agent, id });
    if ((await createdAccount(transport, address)) === null) {
      return id;
    }
  }
  throw new AgentRefusal("NoFreeMandateId", `this owner already granted ${MANDATE_ID_PROBES} mandates to this agent; revoke one first`);
}

const mandateRef = {
  owner: account("the wallet that granted the mandate"),
  agent: account("the agent key the mandate authorises"),
  id: optional(amount("which of the owner's mandates for this agent; default 0")),
};

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

export const prepareRevokeMandate = define({
  name: tool("prepare_revoke_mandate"),
  title: "Prepare a mandate revocation",
  description: `Build the transaction that revokes one mandate and returns its rent to the owner. From then on no solver can fill any intent opened under it. The same transaction cancels up to ${REVOKE_CANCELS} of those intents that are still open, refunding their escrow, and lowers the engine's spending allowance by the unused budget; still_open counts the ones left, which list_intents finds and prepare_cancel cancels. Intents the owner made outside this mandate stay open and are counted in other_open. To revoke every mandate and pending signature together, the owner advances their signing epoch instead.`,
  effect: "prepare",
  input: object(mandateRef),
  output: object({
    mandate: account(),
    cancelled: list(account(), REVOKE_CANCELS, "intents this transaction cancels"),
    still_open: integer(0, MAX_MANDATE_INTENTS, "intents opened under the mandate that stay open, unfillable, until cancelled"),
    other_open: integer(
      0,
      Number.MAX_SAFE_INTEGER,
      "the owner's open intents not made under this mandate, such as their own or signed ones, which revoking leaves untouched",
    ),
    allowance: amount("the engine's spending allowance on the mandate's input account once this transaction lands"),
    summary: list(text(), 32, "what signing does, in plain words"),
    warnings: list(text(), 8, "anything to check before signing"),
    prepared: preparedSchema,
  }),
  run: async ({ transport }, input) => {
    const id = input.id ?? 0n;
    const { address, mandate } = await loadMandate(transport, input.owner, input.agent, id);
    const owner = createNoopSigner(input.owner);
    const inputToken = await mintOf(transport, mandate.inputMint);
    const unused = mandate.total - mandate.spent;
    const allowance = await lowerAllowance(transport, input.owner, mandate.inputAccount, unused);
    const lower =
      allowance.after === allowance.before
        ? []
        : allowance.after === 0n
          ? [getRevokeInstruction({ source: mandate.inputAccount, owner }, { programAddress: inputToken.tokenProgram })]
          : [
              await buildApproveDelegate({
                owner,
                mint: mandate.inputMint,
                tokenProgram: inputToken.tokenProgram,
                amount: allowance.after,
                decimals: inputToken.decimals,
                source: mandate.inputAccount,
              }),
            ];
    const live = (await transport.intents(input.owner))
      .map(({ address: intent, data }) => ({ intent, state: getIntentDecoder().decode(data) }))
      .filter(({ state }) => state.owner === input.owner && state.status === IntentStatus.Open);
    const open = live.filter(({ state }) => state.mandate === address);
    const chosen = open.slice(0, REVOKE_CANCELS);
    const cancels = [];
    for (const { state } of chosen) {
      cancels.push(
        await buildCancelIntent({
          owner,
          nonce: state.nonce,
          inputMint: state.inputMint,
          tokenProgram: await tokenProgramOf(transport, state.inputMint),
        }),
      );
    }
    const ix = await buildRevokeMandate({ owner, agent: input.agent, id });
    const show = (raw: bigint) => formatAmount(raw, inputToken.decimals);
    let refunded = 0n;
    for (const { intent } of chosen) {
      refunded += await vaultBalance(transport, intent);
    }
    const left = open.length - chosen.length;
    const others = live.filter(({ state }) => state.mandate !== address);
    return {
      mandate: address,
      cancelled: chosen.map(({ intent }) => intent),
      still_open: left,
      other_open: others.length,
      allowance: allowance.after,
      summary: [
        `Revokes mandate ${address}: ${input.agent} can no longer create intents for you, and nobody can fill the ones it made`,
        ...(chosen.length === 0
          ? ["None of the agent's intents under it are open"]
          : [`Cancels the agent's ${chosen.length} open intent(s) and returns ${show(refunded)} of ${tokenOf(mandate.inputMint, TOKEN_NAMES[mandate.inputMint])} to you`]),
        ...(left === 0 ? [] : [`Leaves ${left} more of its intents open but unfillable; cancel them with ${tool("prepare_cancel")}`]),
        allowance.after === allowance.before
          ? `Leaves the engine's spending allowance on ${mandate.inputAccount} at ${show(allowance.before)}`
          : `Lowers the engine's spending allowance on ${mandate.inputAccount} from ${show(allowance.before)} to ${show(allowance.after)}, taking back the mandate's unused ${show(unused)}`,
        ...(others.length === 0
          ? []
          : [`Leaves your ${others.length} other open intent(s) untouched: ${others.map(({ intent }) => intent).join(", ")}`]),
        "Returns the mandate's rent to you",
      ],
      warnings: left === 0 ? [] : [WARN_STILL_OPEN],
      prepared: preparedView(await prepare(transport, [ix, ...cancels, ...lower], input.owner)),
    };
  },
});

const agentTerms = {
  owner: account("the wallet whose mandate the agent uses"),
  id: optional(amount("which of the owner's mandates for this agent; default 0")),
  order: orderSchema,
  expires_at: optional(time("unix seconds after which nobody can fill the intent")),
  expires_in: optional(integer(MIN_EXPIRES_IN, MAX_EXPIRES_IN, "seconds from now until the intent expires")),
  nonce: optional(amount("leave out to use the mandate's next free nonce; one you pass must have the top bit set")),
};

type AgentTerms = {
  owner: Address;
  id?: bigint;
  order: Parameters<typeof paramsOf>[0];
  expires_at?: bigint;
  expires_in?: number;
  nonce?: bigint;
};

const agentOutput = {
  intent: account(),
  nonce: amount(),
  expires_at: time(),
  escrow: amount(),
  agent_fee: amount("raw input units held with the escrow and paid to the agent only if this intent fills"),
  budget_remaining: amount("raw input units the mandate still allows after this intent and its fee"),
  summary: list(text(), 16),
};

async function agentIntent(
  transport: Transport,
  agent: TransactionSigner,
  input: AgentTerms,
  claims: Claims,
  call: Call,
) {
  const id = input.id ?? 0n;
  const { mandate } = await loadMandate(transport, input.owner, agent.address, id);
  const now = await chainTime(transport);
  const expiresAt = expiryOf(input, now);
  const params = validate(paramsOf(input.order));
  const { config } = await loadConfig(transport);
  const inputToken = await mintOf(transport, mandate.inputMint);
  const outputToken = await mintOf(transport, mandate.outputMint);
  if (input.nonce !== undefined) {
    await unusedIntent(transport, input.owner, input.nonce);
    claim(claims, call, input.owner, input.nonce, now + PREPARED_TTL, now);
  }
  const nonce = input.nonce ?? (await agentNonce(transport, input.owner, mandate.serial, mandate.intents, { claims, call, now }));
  const intent = await unusedIntent(transport, input.owner, nonce);
  const feeAccount =
    mandate.agentFee === 0n
      ? { create: [] }
      : await tokenAccountIfMissing(transport, agent, agent.address, mandate.inputMint, inputToken.tokenProgram);
  const create = await buildCreateIntentByAgent({
    agent,
    owner: input.owner,
    mandateId: id,
    treasury: config.feeRecipient,
    maxCreateFee: config.createFee,
    maxBounty: config.crankBounty,
    nonce,
    params,
    expiresAt,
    ...(mandate.partnerBps === 0 ? {} : { partner: { key: mandate.partner, bps: mandate.partnerBps } }),
    inputMint: mandate.inputMint,
    outputMint: mandate.outputMint,
    inputTokenProgram: inputToken.tokenProgram,
    outputTokenProgram: outputToken.tokenProgram,
    ownerInput: mandate.inputAccount,
    receiver: mandate.outputAccount,
  });
  const escrow = escrowAmount(params);
  return {
    mandate,
    instructions: [...feeAccount.create, create],
    cost: createCost(config) + (feeAccount.create.length > 0 ? rentFor(TOKEN_ACCOUNT_RENT_BYTES) : 0n),
    now,
    view: {
      intent,
      nonce,
      expires_at: expiresAt,
      escrow,
      agent_fee: mandate.agentFee,
      budget_remaining: mandate.total - mandate.spent - escrow - mandate.agentFee,
      summary: [
        ...describeTerms(
          { kind: params.kind, params: encodeParams(params), inputMint: mandate.inputMint, outputMint: mandate.outputMint },
          { inputDecimals: inputToken.decimals, outputDecimals: outputToken.decimals, ...tokenNames(mandate.inputMint, mandate.outputMint) },
        ),
        `Expires: ${formatTime(expiresAt)}`,
        ...(mandate.agentFee === 0n
          ? []
          : [
              `Agent fee: ${formatAmount(mandate.agentFee, inputToken.decimals)} of ${tokenOf(mandate.inputMint, TOKEN_NAMES[mandate.inputMint])}, held with the escrow and paid to the agent only if this intent fills; refunded to the owner if it is cancelled or expires`,
            ]),
      ],
    },
  };
}

export const prepareAgentCreate = define({
  name: tool("prepare_agent_create"),
  title: "Prepare an intent under a mandate",
  description: `Build the transaction an agent key signs to create an intent for an owner under the mandate the owner granted it. The agent pays the fee, rent and any create fee; the owner's tokens move from the allowance they gave the engine. The program refuses anything outside the mandate. Use ${tool("agent_create")} instead when this server holds the agent key.`,
  effect: "prepare",
  input: object({ agent: account("the agent key that signs and pays"), ...agentTerms }),
  output: object({ ...agentOutput, prepared: preparedSchema }),
  run: async ({ transport, claims }, input, call) => {
    const built = await agentIntent(transport, createNoopSigner(input.agent), input, claims, call);
    const prepared = await prepare(transport, built.instructions, input.agent).catch(explained(built.mandate));
    return { ...built.view, prepared: preparedView(prepared) };
  },
});

export const agentCreate = define({
  name: tool("agent_create"),
  title: "Create an intent under a mandate",
  description:
    "Create an intent for an owner under the mandate the owner granted to this server's agent key, signing and paying with that key. Needs a server started with --agent. This server refuses owners outside its --agent-owners list and spending beyond its hourly lamport budget; the program refuses anything outside the mandate's limits. Each call creates a new intent.",
  effect: "submit",
  repeats: true,
  input: object(agentTerms),
  output: object({ ...agentOutput, signature: text() }),
  run: async (ctx: AgentContext, input, call) => {
    const key = ctx.agent;
    if (key === undefined) {
      throw new AgentRefusal("AgentNotConfigured", "this server holds no agent key; start it with --agent to act under mandates");
    }
    if (!key.owners.has(input.owner)) {
      throw new AgentRefusal("OwnerNotServed", `this agent only acts for the owners it was started with; ${input.owner} is not one of them`);
    }
    const built = await agentIntent(ctx.transport, key.signer, input, ctx.claims, call);
    const prepared = await prepare(ctx.transport, built.instructions, key.signer.address).catch(explained(built.mandate));
    const spend = reserve(key.budget, built.cost + prepared.priorityLamports, built.now);
    const paid = { any: false };
    call.undo.push(() => {
      if (!paid.any) {
        release(key.budget, spend);
      }
    });
    return { ...built.view, signature: await paying(paid, ctx.transport.send(prepared.instructions, key.signer)) };
  },
});
