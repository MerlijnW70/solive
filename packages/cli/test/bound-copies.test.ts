import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const SOURCE_DIRS = readdirSync(join(ROOT, "packages")).map((name) => `packages/${name}/src`).concat(readdirSync(join(ROOT, "services")).map((name) => `services/${name}/src`));

const sourcesOf = (dir: string): { path: string; text: string }[] => {
  try {
    return readdirSync(join(ROOT, dir), { withFileTypes: true, recursive: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => ({ path: relative(ROOT, join(entry.parentPath, entry.name)).replaceAll("\\", "/"), text: readFileSync(join(entry.parentPath, entry.name), "utf8") }));
  } catch {
    return [];
  }
};

const SOURCES = SOURCE_DIRS.flatMap(sourcesOf);

const CONST = /^\s*(?:export )?const ([A-Z][A-Z0-9_]*)(?:: [^=]+)? = ([\d_n\s*+\-()<>]+);$/;

const valueOf = (expression: string): string | undefined => {
  try {
    return String(Function(`"use strict";return (${expression.replace(/(\d)_(?=\d)/g, "$1")})`)()).replace(/n$/, "");
  } catch {
    return undefined;
  }
};

const constantsWith = (value: string): string[] =>
  SOURCES.flatMap(({ path, text }) =>
    text.split("\n").flatMap((line) => {
      const found = CONST.exec(line);
      return found !== null && valueOf(found[2] ?? "") === value ? [`${found[1]} ${path}`] : [];
    }),
  ).sort();

const YEAR = "31536000";
const HOUR = "3600";
const U64 = String((1n << 64n) - 1n);

const OWNERS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  [YEAR]: {
    "MAX_EXPIRES_IN packages/client/src/client-types.ts": "the one bound on how long an intent may stay open; the CLI derives its own from it",
    "HELD_CLAIM_SECS packages/core/src/state.ts": "how long a held claim lasts, fixed by the program; not an expiry bound",
    "IMMUTABLE_SECS services/specs/src/limits.ts": "the cache max-age of an immutable spec; not an expiry bound",
  },
  [HOUR]: {
    "MAX_FOLLOW_INTERVAL packages/cli/src/arg-solve.ts": "the one bound on every watch and follow interval",
    "MAX_PATIENCE packages/cli/src/command-builders.ts": "the longest a claim waits for a job; not a poll interval",
    "HOUR packages/cli/src/faucet.ts": "the length of an hour in the faucet schedule",
    "BUDGET_WINDOW packages/cli/src/agent/budget.ts": "the hourly spend window",
    "RATE_WINDOW packages/cli/src/agent/relay.ts": "the hourly relay rate window",
    "DEFAULT_SUBMIT_WITHIN packages/cli/src/agent/signed-terms.ts": "the default time a signed order may be submitted in",
    "SALE_WINDOW packages/cli/src/agent/wallet/guard.ts": "the hourly sales limit window",
    "DEFAULT_EXPIRES_IN packages/cli/src/agent/wallet/guard.ts": "the default intent lifetime, one hour",
    "DEFAULT_EXPIRES_IN packages/client/src/client-types.ts": "the SDK default intent lifetime, one hour",
    "CHECK_WINDOW_SECS services/faucet/src/limits.ts": "the faucet's check window",
    "PUT_WINDOW_SECS services/specs/src/limits.ts": "the spec store's upload window",
    "UNPAID_GRACE_SECS services/specs/src/limits.ts": "how long an unpaid spec is kept",
    "MIN_REVIEW_SECS packages/core/src/claims.ts": "the shortest review window the program takes, from fair closing; not an expiry or poll bound",
  },
  [U64]: {
    "U64_MAX packages/core/src/math.ts": "the one 64-bit bound; every other 64-bit limit imports it",
  },
};

describe("a bound has one source", () => {
  it.each(Object.entries(OWNERS))("every constant equal to %s is the owner or an allowed unrelated one", (value, allowed) => {
    expect(constantsWith(value)).toEqual(Object.keys(allowed).sort());
  });

  it("a copy under another name is found by its value", () => {
    const copy = `const RELAY_TTL_CAP = ${YEAR};`;
    const copied = `const RELAY_TTL_CAP = 365 * 24 * 60 * 60;`;
    expect([copy, copied].map((line) => valueOf(CONST.exec(line)?.[2] ?? ""))).toEqual([YEAR, YEAR]);
  });

  it("the split recipient limit is defined in core, and once more in the feed, which may not import /internal", () => {
    const found = SOURCES.flatMap(({ path, text }) => text.split("\n").filter((line) => /^\s*(?:export )?const \w*SPLIT\w*RECIPIENTS\w* = \d+;$/.test(line)).map(() => path));
    expect(found).toEqual(["packages/core/src/bounty.ts", "services/live/src/payees.ts"]);
  });

  it("the token program addresses are written once and listed once", () => {
    const literal = (address: string) => SOURCES.filter(({ text }) => text.includes(`"${address}"`)).map(({ path }) => path);
    expect(literal("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb")).toEqual(["packages/core/src/mints.ts"]);
    const lists = SOURCES.filter(({ text }) => /^\s*(?:export )?const TOKEN_PROGRAMS\b/m.test(text)).map(({ path }) => path);
    expect(lists).toEqual(["packages/core/src/mints.ts"]);
  });
});
