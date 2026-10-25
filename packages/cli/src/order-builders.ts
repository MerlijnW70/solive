import { MAX_EXPIRES_IN, MIN_EXPIRES_IN } from "./agent/create.js";
import { MANDATE_KIND_NAMES } from "./agent/mandate.js";
import { ORDER, type StringKey, type Values } from "./arg-options.js";
import {
  amountOf,
  key,
  memoUrlOf,
  noSub,
  optionalField,
  parseBounded,
  required,
  sha256Of,
  timeOf,
  UsageError,
} from "./arg-values.js";
import type { Command, FlowName, Remote, ToolInput } from "./command-types.js";
import { MAX_PARTNER_BPS } from "@intent-engine/core/internal";

export const MANDATE_USE_KINDS = "a mandate covers swap, limit and dutch orders; name one of those";

const ORDER_FIELDS: Record<string, readonly StringKey[]> = {
  swap: ["amount-in", "min-out"],
  limit: ["make", "take"],
  dutch: ["amount-in", "start-out", "end-out", "start-at", "end-at"],
  attested: ["amount-in", "min-result", "max-result", "attestor"],
};

export function order(kind: string | undefined, values: Values): ToolInput {
  const fields = kind === undefined ? undefined : ORDER_FIELDS[kind];
  if (fields === undefined) {
    throw new UsageError("name the order kind: swap, limit, dutch or attested");
  }
  for (const name of ORDER) {
    if (values[name] !== undefined && !fields.includes(name)) {
      throw new UsageError(`a ${kind} order does not take --${name}`);
    }
  }
  switch (kind) {
    case "swap":
      return { kind, amount_in: amountOf(values, "amount-in"), min_out: amountOf(values, "min-out") };
    case "limit":
      return { kind, make_amount: amountOf(values, "make"), take_amount: amountOf(values, "take") };
    case "dutch":
      return {
        kind,
        amount_in: amountOf(values, "amount-in"),
        start_out: amountOf(values, "start-out"),
        end_out: amountOf(values, "end-out"),
        start_time: timeOf(values, "start-at"),
        end_time: timeOf(values, "end-at"),
      };
    default:
      return {
        kind,
        amount_in: amountOf(values, "amount-in"),
        min_result: amountOf(values, "min-result"),
        max_result: amountOf(values, "max-result"),
        attestor: key(values, "attestor"),
      };
  }
}

export function expiry(values: Values): ToolInput {
  if ((values["expires-at"] === undefined) === (values["expires-in"] === undefined)) {
    throw new UsageError("give exactly one of --expires-at or --expires-in");
  }
  return values["expires-at"] === undefined
    ? { expires_in: parseBounded(required(values, "expires-in"), "expires-in", MAX_EXPIRES_IN, MIN_EXPIRES_IN) }
    : { expires_at: timeOf(values, "expires-at") };
}

function partner(values: Values): ToolInput {
  if (values.partner === undefined && values["partner-bps"] === undefined) {
    return {};
  }
  return {
    partner: {
      account: key(values, "partner"),
      bps: parseBounded(required(values, "partner-bps"), "partner-bps", MAX_PARTNER_BPS),
    },
  };
}

export function terms(kind: string | undefined, values: Values): ToolInput {
  return {
    input_mint: key(values, "input-mint"),
    output_mint: key(values, "output-mint"),
    order: order(kind, values),
    ...expiry(values),
    ...optionalField(values, "nonce", "nonce", amountOf),
    ...partner(values),
  };
}

function grant(values: Values): ToolInput {
  const kinds = required(values, "kinds").split(",");
  for (const name of kinds) {
    if (!(MANDATE_KIND_NAMES as readonly string[]).includes(name)) {
      throw new UsageError(`--kinds takes a comma list of swap, limit, dutch; got ${name}`);
    }
  }
  return {
    agent: key(values, "agent"),
    input_mint: key(values, "input-mint"),
    output_mint: key(values, "output-mint"),
    kinds,
    per_intent: amountOf(values, "per-intent"),
    total: amountOf(values, "total"),
    max_intents: parseBounded(required(values, "max-intents"), "max-intents", 0xffff_ffff),
    max_ttl: parseBounded(required(values, "max-ttl"), "max-ttl", MAX_EXPIRES_IN, MIN_EXPIRES_IN),
    valid_for: parseBounded(required(values, "valid-for"), "valid-for", MAX_EXPIRES_IN, MIN_EXPIRES_IN),
    floor: { out: amountOf(values, "floor-out"), in: amountOf(values, "floor-in") },
    ...optionalField(values, "id", "id", amountOf),
    ...partner(values),
    ...optionalField(values, "agent-fee", "agent_fee", amountOf),
  };
}

export function mandate(sub: string | undefined, kind: string | undefined, remote: Remote, values: Values): Command {
  const flow = (name: FlowName, input: ToolInput): Command => ({
    name: "flow",
    ...remote,
    flow: name,
    keypair: required(values, "keypair"),
    yes: values.yes === true,
    input,
  });
  const ref = () => ({ agent: key(values, "agent"), ...optionalField(values, "id", "id", amountOf) });
  if (sub !== "use") {
    noSub(kind);
  }
  switch (sub) {
    case "grant":
      return flow("mandate-grant", grant(values));
    case "revoke":
      return flow("mandate-revoke", ref());
    case "show":
      return {
        name: "lookup",
        ...remote,
        lookup: "mandate-show",
        keypair: values.keypair,
        input: { ...ref(), ...optionalField(values, "owner", "owner", key) },
      };
    case "use":
      if (kind === "attested") {
        throw new UsageError(MANDATE_USE_KINDS);
      }
      return flow("mandate-use", {
        owner: key(values, "owner"),
        order: order(kind, values),
        ...expiry(values),
        ...optionalField(values, "id", "id", amountOf),
        ...optionalField(values, "nonce", "nonce", amountOf),
      });
    default:
      throw new UsageError("mandate needs grant, show, revoke or use");
  }
}

export const SPEC_HASH_FORMAT = "--spec-hash must be the spec's sha256 as 64 hex digits";
export const needsSpecHash = (option: string) => `--${option} needs --spec-hash, which makes the attested escrow a proof escrow`;

const PROOF_OPTIONS = ["spec-hash", "judge-fee", "spec-url"] as const;

export function createTerms(kind: string | undefined, values: Values): ToolInput {
  const base = terms(kind, values);
  const payTo = optionalField(values, "pay-to", "pay_to", key);
  if (kind !== "attested") {
    const given = PROOF_OPTIONS.find((name) => values[name] !== undefined);
    if (given !== undefined) {
      throw new UsageError(`a ${kind} order does not take --${given}`);
    }
    return { ...base, ...payTo };
  }
  const specHash = values["spec-hash"];
  if (specHash === undefined) {
    const given = PROOF_OPTIONS.find((name) => values[name] !== undefined);
    if (given !== undefined) {
      throw new UsageError(needsSpecHash(given));
    }
    return { ...base, ...payTo };
  }
  return {
    ...base,
    order: {
      ...(base["order"] as ToolInput),
      spec_hash: sha256Of(specHash, SPEC_HASH_FORMAT),
      ...optionalField(values, "judge-fee", "judge_fee", amountOf),
    },
    ...optionalField(values, "spec-url", "spec_url", (v, n) => memoUrlOf(required(v, n), "spec-url")),
    ...payTo,
  };
}
