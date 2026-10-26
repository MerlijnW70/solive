import { type Address, createNoopSigner, type TransactionSigner } from "@solana/kit";
import { formatAmount } from "@intent-engine/core";
import { buildCreateIntentByAgent, describeTerms, encodeParams, escrowAmount, validate, tokenOf } from "@intent-engine/core/internal";
import { type Transport } from "@intent-engine/client";
import { chainTime, loadConfig, loadUser, mintCapOf, mintOf, tokenAccountIfMissing } from "@intent-engine/client/internal";
import { type AgentContext, define } from "./actions.js";
import { createCost, release, rentFor, rentRate, reserve, TOKEN_ACCOUNT_RENT_BYTES } from "./budget.js";
import { expiryOf, MAX_EXPIRES_IN, MIN_EXPIRES_IN } from "./create.js";
import { expiresLine } from "./expiry.js";
import { tool } from "./names.js";
import { unusedIntent } from "./owner.js";
import { prepare } from "./prepare.js";
import { paying } from "./signed-relay.js";
import { type Call, claim, type Claims, PREPARED_TTL } from "./claims.js";
import { AgentRefusal } from "./problems.js";
import { orderSchema, paramsOf, preparedSchema, preparedView } from "./shapes.js";
import { TOKEN_NAMES, tokenNames } from "../tokens.js";
import { account, amount, integer, list, object, optional, text, time } from "./schema.js";
import { admitUnderMandate, agentNonce, explained, loadMandate } from "./mandate-state.js";

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
  const owner = await loadUser(transport, input.owner);
  admitUnderMandate(mandate, { params, expiresAt, now, ownerEpoch: owner?.epoch ?? null });
  const feeAccount =
    mandate.agentFee === 0n
      ? { create: [] }
      : await tokenAccountIfMissing(transport, agent, agent.address, mandate.inputMint, inputToken.tokenProgram);
  const mintCap = await mintCapOf(transport, mandate.inputMint);
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
    ...(mintCap === undefined ? {} : { mintCap }),
  });
  const escrow = escrowAmount(params);
  const rate = await rentRate(transport);
  return {
    mandate,
    instructions: [...feeAccount.create, create],
    cost: createCost(config, rate) + (feeAccount.create.length > 0 ? rentFor(TOKEN_ACCOUNT_RENT_BYTES, rate) : 0n),
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
        expiresLine(expiresAt, now),
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
