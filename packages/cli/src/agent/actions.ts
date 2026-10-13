import type { Address, TransactionSigner } from "@solana/kit";
import { memoized, type Transport } from "@intent-engine/client";
import { type Problem, problemOf } from "./problems.js";
import type { Budget } from "./budget.js";
import type { Relay } from "./relay.js";
import { type Call, callOf, type Claims } from "./claims.js";
import { InvalidInput, type Schema } from "./schema.js";
import type { WalletAccess } from "./wallet.js";

export type Effect = "read" | "prepare" | "submit";

export type AgentContext = {
  transport: Transport;
  relay: Relay | undefined;
  agent: AgentKey | undefined;
  claims: Claims;
  wallet?: WalletAccess;
};

type AgentKey = { signer: TransactionSigner; budget: Budget; owners: ReadonlySet<Address> };

type Action<I> = {
  name: string;
  title: string;
  description: string;
  effect: Effect;
  repeats?: true;
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

export async function invoke(action: AnyAction, ctx: AgentContext, raw: unknown): Promise<Outcome> {
  const call = callOf();
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
    return { ok: false, problem: problemOf(error) };
  }
}
