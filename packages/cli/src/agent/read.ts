import { getTokenDecoder } from "@solana-program/token";
import type { Address } from "@solana/kit";
import {
  feeBpsFor,
  findAssociatedTokenAddress,
  findDelegatePda,
  formatAmount,
  getIntentDecoder,
  IntentStatus,
  kindBit,
  PAUSE_CREATE,
  PAUSE_FILL,
  remainingOf,
} from "@intent-engine/core";
import { chainTime, clusterDomain, createdAccount, loadConfig, loadIntent, mintOf, quoteOf, sameBytes, STATUS } from "../accounts.js";
import type { Transport } from "../transport.js";
import { define } from "./actions.js";
import { tool } from "./names.js";
import { type Decimals, intentSchema, intentView, KIND_NAMES, KINDS } from "./shapes.js";
import { account, amount, choice, flag, integer, list, object, optional, text, time } from "./schema.js";

const LIST_LIMIT = 100;
const LIST_DEFAULT = 20;

const intentRef = {
  owner: account("the wallet that created the intent"),
  nonce: amount("the intent's nonce under that owner"),
};

export const getConfig = define({
  name: tool("get_config"),
  title: "Engine settings",
  description:
    "Read the engine's live settings: which order kinds are enabled, fees per kind, the partner cut, the create fee and crank bounty in lamports, and whether creating or filling is paused.",
  effect: "read",
  input: object({}),
  output: object({
    address: account(),
    admin: account(),
    guardian: account(),
    fee_recipient: account(),
    paused: object({ create: flag(), fill: flag() }),
    kinds: list(
      object({
        kind: choice(Object.values(KIND_NAMES)),
        enabled: flag("intents of this kind can be created"),
        fills_stopped: flag("fills of this kind are stopped"),
        fee_bps: integer(0, 10_000),
      }),
      4,
    ),
    partner_cut_bps: integer(0, 10_000, "share of every partner fee kept by the protocol"),
    crank_bounty: amount("lamports escrowed in each new intent for whoever expires or closes it"),
    create_fee: amount("lamports paid to the treasury for each new intent"),
    domain_matches_cluster: flag("false means this RPC is a different cluster than the engine was configured for"),
  }),
  run: async ({ transport }) => {
    const { address, config } = await loadConfig(transport);
    return {
      address,
      admin: config.admin,
      guardian: config.guardian,
      fee_recipient: config.feeRecipient,
      paused: { create: (config.paused & PAUSE_CREATE) !== 0, fill: (config.paused & PAUSE_FILL) !== 0 },
      kinds: KINDS.map((kind) => ({
        kind: KIND_NAMES[kind],
        enabled: (config.enabledKinds & kindBit(kind)) !== 0n,
        fills_stopped: (config.fillDisabledKinds & kindBit(kind)) !== 0n,
        fee_bps: feeBpsFor(config, kind),
      })),
      partner_cut_bps: config.partnerCutBps,
      crank_bounty: BigInt(config.crankBounty),
      create_fee: BigInt(config.createFee),
      domain_matches_cluster: sameBytes(config.domain, await clusterDomain(transport)),
    };
  },
});

export const getIntent = define({
  name: tool("get_intent"),
  title: "Read one intent",
  description:
    "Read one intent by owner and nonce: its status, what is escrowed and still for sale, its terms in plain words, expiry, partner fee and crank bounty.",
  effect: "read",
  input: object(intentRef),
  output: intentSchema,
  run: async ({ transport }, input) => {
    const { address, intent } = await loadIntent(transport, input.owner, input.nonce);
    return intentView(address, intent, await decimalsFor(transport, new Map(), intent.inputMint, intent.outputMint));
  },
});

export const listIntents = define({
  name: tool("list_intents"),
  title: "List intents",
  description: `List intents, optionally only one owner's or only one status. Returns at most limit intents (default ${LIST_DEFAULT}, up to ${LIST_LIMIT}); more is true when others matched too.`,
  effect: "read",
  input: object({
    owner: optional(account("only intents created by this wallet")),
    status: optional(choice(STATUS, "only intents in this status")),
    limit: optional(integer(1, LIST_LIMIT)),
  }),
  output: object({
    intents: list(intentSchema, LIST_LIMIT),
    more: flag(),
    unreadable: integer(0, Number.MAX_SAFE_INTEGER, "intents skipped because their account could not be read"),
  }),
  run: async ({ transport }, input) => {
    const limit = input.limit ?? LIST_DEFAULT;
    const views = [];
    let unreadable = 0;
    const cache = new Map<Address, number | null>();
    for (const { address, data } of await transport.intents(input.owner)) {
      let intent;
      try {
        intent = getIntentDecoder().decode(data);
      } catch {
        unreadable += 1;
        continue;
      }
      const decimals = await decimalsFor(transport, cache, intent.inputMint, intent.outputMint);
      try {
        views.push(intentView(address, intent, decimals));
      } catch {
        unreadable += 1;
      }
    }
    const matching = views.filter(
      (view) => (input.owner === undefined || view.owner === input.owner) && (input.status === undefined || view.status === input.status),
    );
    return { intents: matching.slice(0, limit), more: matching.length > limit, unreadable };
  },
});

const BALANCE_MINTS = 8;
export const SOL_DECIMALS = 9;

async function decimalsOf(transport: Transport, cache: Map<Address, number | null>, mint: Address): Promise<number | null> {
  if (!cache.has(mint)) {
    cache.set(mint, await mintOf(transport, mint).then((t) => t.decimals, () => null));
  }
  return cache.get(mint) ?? null;
}

export async function decimalsFor(
  transport: Transport,
  cache: Map<Address, number | null>,
  inputMint: Address,
  outputMint: Address,
): Promise<Decimals> {
  const input = await decimalsOf(transport, cache, inputMint);
  const output = await decimalsOf(transport, cache, outputMint);
  return { ...(input === null ? {} : { inputDecimals: input }), ...(output === null ? {} : { outputDecimals: output }) };
}

export const getBalances = define({
  name: tool("get_balances"),
  title: "Token balances",
  description:
    "Read a wallet's SOL and its holdings of the given tokens: each token's decimals (every amount in these tools is in raw units, so one whole token is 10^decimals raw units), the wallet's canonical token account and balance, the spending allowance it gives the engine, and how much is still escrowed in its open intents. Use it to turn amounts a person names into raw units and to check that tokens came back.",
  effect: "read",
  input: object({
    owner: account("the wallet to read"),
    mints: list(account(), BALANCE_MINTS, "the tokens to read", 1),
  }),
  output: object({
    owner: account(),
    lamports: amount("SOL the wallet holds, in lamports (one SOL is 1000000000); it pays network fees and rent"),
    sol: text("the same in whole SOL"),
    tokens: list(
      object({
        mint: account(),
        decimals: integer(0, 255),
        account: account("the wallet's canonical token account for this mint"),
        exists: flag("false when the wallet has no such token account yet"),
        balance: amount("raw units held"),
        balance_tokens: text("the balance in whole tokens"),
        engine_allowance: amount("raw units the engine may still draw for signed and agent intents"),
        escrowed: amount("raw units still locked in this wallet's open intents selling this token"),
      }),
      BALANCE_MINTS,
    ),
  }),
  run: async ({ transport }, input) => {
    const [engine] = await findDelegatePda({ owner: input.owner });
    const open = (await transport.intents(input.owner))
      .map(({ data }) => getIntentDecoder().decode(data))
      .filter((intent) => intent.owner === input.owner && intent.status === IntentStatus.Open);
    const tokens = [];
    for (const mint of input.mints) {
      const token = await mintOf(transport, mint);
      const address = await findAssociatedTokenAddress({ owner: input.owner, mint, tokenProgram: token.tokenProgram });
      const view = await createdAccount(transport, address);
      const state = view === null ? null : getTokenDecoder().decode(view.data);
      const delegate = state !== null && state.delegate.__option === "Some" ? state.delegate.value : null;
      const balance = state?.amount ?? 0n;
      tokens.push({
        mint,
        decimals: token.decimals,
        account: address,
        exists: state !== null,
        balance,
        balance_tokens: formatAmount(balance, token.decimals),
        engine_allowance: delegate === engine ? (state?.delegatedAmount ?? 0n) : 0n,
        escrowed: open.filter((intent) => intent.inputMint === mint).reduce((sum, intent) => sum + remainingOf(intent), 0n),
      });
    }
    const lamports = (await transport.getAccount(input.owner))?.lamports ?? 0n;
    return { owner: input.owner, lamports, sol: formatAmount(lamports, SOL_DECIMALS), tokens };
  },
});

export const quote = define({
  name: tool("quote"),
  title: "Quote an intent",
  description:
    "Work out what filling an intent requires: the least output the owner must receive at a given time (default: now on chain) and how the remaining input splits into protocol fee, partner fee and the net a solver gets to sell. Attested intents have no output minimum and cannot be quoted.",
  effect: "read",
  input: object({ ...intentRef, at: optional(time("unix seconds to price at; defaults to the chain's current time")) }),
  output: object({
    address: account(),
    at: time(),
    amount_in: amount("raw input units a fill sells"),
    required_out: amount("least raw output units the receiver must get"),
    fee_bps: integer(0, 10_000),
    partner_bps: integer(0, 10_000),
    protocol_fee: amount(),
    partner_fee: amount(),
    net_in: amount("raw input units the solver receives to sell"),
  }),
  run: async ({ transport }, input) => {
    const { address, intent } = await loadIntent(transport, input.owner, input.nonce);
    const { config } = await loadConfig(transport);
    const q = quoteOf(intent, config, input.at ?? (await chainTime(transport)));
    return {
      address,
      at: q.at,
      amount_in: q.amountIn,
      required_out: q.requiredOut,
      fee_bps: q.feeBps,
      partner_bps: q.partnerBps,
      protocol_fee: q.protocolFee,
      partner_fee: q.partnerFee,
      net_in: q.net,
    };
  },
});
