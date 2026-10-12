import { type Address, isAddress } from "@solana/kit";
import { I64_MAX, I64_MIN, U64_MAX } from "@intent-engine/core";

export type Issue = { path: string; message: string };

export class InvalidInput extends Error {
  readonly issues: Issue[];

  constructor(issues: Issue[]) {
    super(issues.map((i) => (i.path === "" ? i.message : `${i.path}: ${i.message}`)).join("; "));
    this.name = "InvalidInput";
    this.issues = issues;
  }
}

export type Json = Record<string, unknown>;

export type Schema<T> = { json: Json; read(value: unknown, path: string): T };

export type Infer<S> = S extends Schema<infer T> ? T : never;

const fail = (path: string, message: string): never => {
  throw new InvalidInput([{ path, message }]);
};

const at = (path: string, key: string | number) => (path === "" ? String(key) : `${path}.${key}`);

const described = (json: Json, description: string | undefined): Json =>
  description === undefined ? json : { ...json, description };

export function text(description?: string): Schema<string> {
  return {
    json: described({ type: "string" }, description),
    read: (value, path) => (typeof value === "string" ? value : fail(path, "must be a string")),
  };
}

export function flag(description?: string): Schema<boolean> {
  return {
    json: described({ type: "boolean" }, description),
    read: (value, path) => (typeof value === "boolean" ? value : fail(path, "must be true or false")),
  };
}

export const ADDRESS_PATTERN = "^[1-9A-HJ-NP-Za-km-z]{32,44}$";

export function account(description?: string): Schema<Address> {
  return {
    json: described({ type: "string", pattern: ADDRESS_PATTERN }, description),
    read: (value, path) =>
      typeof value === "string" && isAddress(value) ? value : fail(path, "must be a base58 Solana address"),
  };
}

export const AMOUNT_PATTERN = "^(0|[1-9][0-9]{0,19})$";

export function amount(description?: string): Schema<bigint> {
  return {
    json: described({ type: "string", pattern: AMOUNT_PATTERN }, description),
    read: (value, path) => {
      if (typeof value !== "string" || !new RegExp(AMOUNT_PATTERN).test(value)) {
        return fail(path, "must be a whole number of raw token units written as a decimal string");
      }
      const parsed = BigInt(value);
      return parsed <= U64_MAX ? parsed : fail(path, `must be at most ${U64_MAX}`);
    },
  };
}

export const HEX32_PATTERN = "^[0-9a-fA-F]{64}$";

export function hex32(description?: string): Schema<string> {
  return {
    json: described({ type: "string", pattern: HEX32_PATTERN }, description),
    read: (value, path) =>
      typeof value === "string" && new RegExp(HEX32_PATTERN).test(value) ? value : fail(path, "must be 64 hex digits (32 bytes)"),
  };
}

export const TIME_PATTERN = "^-?(0|[1-9][0-9]{0,18})$";

export function time(description?: string): Schema<bigint> {
  return {
    json: described({ type: "string", pattern: TIME_PATTERN }, description),
    read: (value, path) => {
      if (typeof value !== "string" || !new RegExp(TIME_PATTERN).test(value)) {
        return fail(path, "must be whole unix seconds written as a decimal string");
      }
      const parsed = BigInt(value);
      return parsed >= I64_MIN && parsed <= I64_MAX ? parsed : fail(path, `must be from ${I64_MIN} to ${I64_MAX}`);
    },
  };
}

export function integer(min: number, max: number, description?: string): Schema<number> {
  return {
    json: described({ type: "integer", minimum: min, maximum: max }, description),
    read: (value, path) =>
      typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
        ? value
        : fail(path, `must be an integer from ${min} to ${max}`),
  };
}

export function choice<const T extends string>(values: readonly T[], description?: string): Schema<T> {
  return {
    json: described({ type: "string", enum: [...values] }, description),
    read: (value, path) =>
      typeof value === "string" && (values as readonly string[]).includes(value)
        ? (value as T)
        : fail(path, `must be one of ${values.join(", ")}`),
  };
}

export function list<T>(item: Schema<T>, maxItems: number, description?: string, minItems = 0): Schema<T[]> {
  return {
    json: described({ type: "array", items: item.json, minItems, maxItems }, description),
    read: (value, path) => {
      if (!Array.isArray(value)) {
        return fail(path, "must be a list");
      }
      if (value.length > maxItems || value.length < minItems) {
        return fail(path, `must hold ${minItems} to ${maxItems} items`);
      }
      return value.map((v, i) => item.read(v, at(path, i)));
    },
  };
}

export function nullable<T>(inner: Schema<T>): Schema<T | null> {
  return {
    json: { anyOf: [inner.json, { type: "null" }] },
    read: (value, path) => (value === null ? null : inner.read(value, path)),
  };
}

type Optional<T> = { optional: Schema<T> };

export function optional<T>(inner: Schema<T>): Optional<T> {
  return { optional: inner };
}

type Field = Schema<unknown> | Optional<unknown>;

type Shape = Record<string, Field>;

type Parsed<S extends Shape> = {
  [K in keyof S as S[K] extends Optional<unknown> ? never : K]: S[K] extends Schema<infer T> ? T : never;
} & {
  [K in keyof S as S[K] extends Optional<unknown> ? K : never]?: S[K] extends Optional<infer T> ? T : never;
};

const isOptional = (field: Field): field is Optional<unknown> => "optional" in field;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function object<S extends Shape>(shape: S, description?: string): Schema<Parsed<S>> {
  const keys = Object.keys(shape);
  const required = keys.filter((k) => !isOptional(shape[k] as Field));
  return {
    json: described(
      {
        type: "object",
        properties: Object.fromEntries(
          keys.map((k) => {
            const field = shape[k] as Field;
            return [k, isOptional(field) ? field.optional.json : field.json];
          }),
        ),
        required,
        additionalProperties: false,
      },
      description,
    ),
    read: (value, path) => {
      if (!isRecord(value)) {
        return fail(path, "must be an object");
      }
      const issues: Issue[] = Object.keys(value)
        .filter((k) => !keys.includes(k))
        .map((k) => ({ path: at(path, k), message: "is not a known field" }));
      const out: Record<string, unknown> = {};
      for (const k of keys) {
        const field = shape[k] as Field;
        const present = value[k] !== undefined;
        try {
          if (present) {
            out[k] = (isOptional(field) ? field.optional : field).read(value[k], at(path, k));
          } else if (!isOptional(field)) {
            issues.push({ path: at(path, k), message: "is required" });
          }
        } catch (error) {
          if (!(error instanceof InvalidInput)) {
            throw error;
          }
          issues.push(...error.issues);
        }
      }
      if (issues.length > 0) {
        throw new InvalidInput(issues);
      }
      return out as Parsed<S>;
    },
  };
}

export function variants<const K extends string, V extends Record<string, Schema<object>>>(
  tag: K,
  options: V,
  description?: string,
): Schema<{ [N in keyof V]: { [T in K]: N } & Infer<V[N]> }[keyof V]> {
  const names = Object.keys(options);
  return {
    json: described(
      {
        oneOf: names.map((name) => {
          const json = (options[name] as Schema<object>).json;
          const properties = json["properties"] as Json;
          const required = json["required"] as string[];
          return {
            ...json,
            properties: { [tag]: { const: name }, ...properties },
            required: [tag, ...required],
          };
        }),
      },
      description,
    ),
    read: (value, path) => {
      if (!isRecord(value)) {
        return fail(path, "must be an object");
      }
      const name = value[tag];
      const option = typeof name === "string" && names.includes(name) ? options[name] : undefined;
      if (option === undefined) {
        return fail(at(path, tag), `must be one of ${names.join(", ")}`);
      }
      const { [tag]: _, ...rest } = value;
      return { [tag]: name, ...option.read(rest, path) } as never;
    },
  };
}

type StandardIssue = { message: string; path?: PropertyKey[] };

export type Standard<T> = {
  "~standard": {
    version: 1;
    vendor: string;
    validate(value: unknown): { value: T; issues?: undefined } | { issues: StandardIssue[] };
    jsonSchema: { input(options: unknown): Json; output(options: unknown): Json };
  };
};

export const VENDOR = "intent-engine";

export function passThrough(json: Json): Standard<unknown> {
  return {
    "~standard": {
      version: 1,
      vendor: VENDOR,
      validate: (value) => ({ value }),
      jsonSchema: { input: () => json, output: () => json },
    },
  };
}

export function checked<T>(schema: Schema<T>): Standard<T> {
  return {
    "~standard": {
      version: 1,
      vendor: VENDOR,
      validate: (value) => {
        try {
          return { value: schema.read(value, "") };
        } catch (error) {
          if (!(error instanceof InvalidInput)) {
            throw error;
          }
          return {
            issues: error.issues.map((i) => ({ message: i.message, ...(i.path === "" ? {} : { path: i.path.split(".") }) })),
          };
        }
      },
      jsonSchema: { input: () => schema.json, output: () => schema.json },
    },
  };
}
