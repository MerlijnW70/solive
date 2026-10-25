import type { Address, TransactionSigner } from "@solana/kit";
import { type Lookup, type SpecFetch, type Transport } from "@intent-engine/client";
import { memoized } from "@intent-engine/client/internal";
import { systemLookup } from "../public-address.js";
import type { SpecReach } from "../invites.js";
import { type Problem, problemOf } from "./problems.js";
import type { Budget } from "./budget.js";
import type { Relay } from "./relay.js";
import { type Call, callOf, type Claims } from "./claims.js";
import { InvalidInput, type Schema } from "./schema.js";
import type { Clock, WalletAccess } from "./wallet.js";

export type Effect = "read" | "prepare" | "submit";

export type AgentContext = {
  transport: Transport;
  relay: Relay | undefined;
  agent: AgentKey | undefined;
  claims: Claims;
  wallet?: WalletAccess;
  clock?: Clock;
  url?: string;
  fetch?: SpecFetch;
  lookup?: Lookup;
  confirm?: Transport;
};

export const lookupOf = (ctx: AgentContext): Lookup => ctx.lookup ?? systemLookup;

export const specReach = (ctx: AgentContext): SpecReach => ({ lookup: lookupOf(ctx), rpcUrl: ctx.url ?? ctx.wallet?.url });

type AgentKey = { signer: TransactionSigner; budget: Budget; owners: ReadonlySet<Address> };

type Action<I> = {
  name: string;
  title: string;
  description: string;
  effect: Effect;
  repeats?: true;
  destructive?: false;
  input: Schema<I>;
  output: Schema<unknown>;
  run(ctx: AgentContext, input: I, call: Call): Promise<object>;
};

export type AnyAction = Action<never>;

export const define = <I>(action: Action<I>): AnyAction => action as unknown as AnyAction;

export function toJson(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(toJson);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJson(v)]));
  }
  return value;
}

export class OutputMismatch extends Error {
  constructor(action: string, cause: InvalidInput) {
    super(`${action} produced output outside its schema: ${cause.message}`);
    this.name = "OutputMismatch";
  }
}

export type Outcome = { ok: true; value: Record<string, unknown> } | { ok: false; problem: Problem };

const SENDING = new Set(["send", "approval"]);

const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k): [string, unknown] => [k, (value as Record<string, unknown>)[k]])
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, canonical(v)]),
        )
      : value;

export function askedOf(name: string, raw: unknown): string {
  const input = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? Object.fromEntries(Object.entries(raw).filter(([k]) => !SENDING.has(k))) : raw;
  return JSON.stringify([name, canonical(input ?? {})]);
}

export function askedWith(asked: string, passed: Record<string, unknown>): string {
  const [name, input] = JSON.parse(asked) as [string, unknown];
  return askedOf(name, input !== null && typeof input === "object" && !Array.isArray(input) ? { ...input, ...passed } : input);
}

export async function invoke(action: AnyAction, ctx: AgentContext, raw: unknown): Promise<Outcome> {
  const call = callOf(askedOf(action.name, raw));
  try {
    const input = action.input.read(raw ?? {}, "");
    const value = toJson(await action.run({ ...ctx, transport: memoized(ctx.transport) }, input as never, call));
    try {
      action.output.read(value, "");
    } catch (error) {
      throw error instanceof InvalidInput ? new OutputMismatch(action.name, error) : error;
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch (error) {
    for (const undo of call.undo.reverse()) {
      undo();
    }
    return { ok: false, problem: problemOf(error, ctx.url ?? ctx.wallet?.url) };
  }
}
