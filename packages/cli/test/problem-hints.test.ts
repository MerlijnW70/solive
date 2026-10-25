import { describe, expect, it } from "vitest";
import { PRODUCT_SLUG } from "@intent-engine/core/internal";
import { AGENT_TOOLS, RELAY_TOOLS, servedActions } from "../src/agent/everyday.js";
import { ENGINE_PROBLEMS, SERVER_PROBLEMS, TOKEN_PROBLEMS } from "../src/agent/problems.js";

const NAMED = new RegExp(`\\b${PRODUCT_SLUG}_\\w+`, "g");
const name = (short: string) => `${PRODUCT_SLUG}_${short}`;
const WALLET_SERVED = new Set(servedActions({ wallet: true, allTools: false, relay: false, agent: false }).map((action) => action.name));

const servingFlag = (tool: string): string | null => (RELAY_TOOLS.has(tool) ? "--relayer" : AGENT_TOOLS.has(tool) ? "--agent" : null);

const namesFlag = (hint: string, flag: string): boolean => new RegExp(`${flag}(?![\\w-])`).test(hint);

const HINTS: readonly (readonly [string, string])[] = [
  ...Object.entries(ENGINE_PROBLEMS).map(([code, { hint }]) => [code, hint] as const),
  ...Object.entries(SERVER_PROBLEMS).map(([code, { hint }]) => [code, hint] as const),
  ...Object.values(TOKEN_PROBLEMS).map(({ code, hint }) => [code, hint] as const),
];

function unservedNames(hints: readonly (readonly [string, string])[]): string[] {
  return hints.flatMap(([code, hint]) =>
    [...hint.matchAll(NAMED)]
      .map(([found]) => found)
      .filter((found) => {
        const flag = servingFlag(found);
        return !WALLET_SERVED.has(found) && (flag === null || !namesFlag(hint, flag));
      })
      .map((found) => `${code} names ${found}`),
  );
}

describe("problem hints", () => {
  it("name only tools the --wallet server serves, or the flag that starts a server serving them", () => {
    expect(unservedNames(HINTS)).toEqual([]);
  });

  it("are caught naming a tool the --wallet server does not serve", () => {
    expect(WALLET_SERVED.has(name("get_intent"))).toBe(false);
    expect(unservedNames([["InvalidTransition", `read it with ${name("get_intent")}`]])).toEqual([`InvalidTransition names ${name("get_intent")}`]);
    expect(unservedNames([["MandateBudget", `check with ${name("get_mandate")}`]])).toEqual([`MandateBudget names ${name("get_mandate")}`]);
    expect(unservedNames([["MandateBudget", `check with ${name("get_mandate")}, served with --agent-owners`]])).toEqual([`MandateBudget names ${name("get_mandate")}`]);
    expect(unservedNames([["MandateBudget", `check with ${name("get_mandate")}, served with --agent`]])).toEqual([]);
  });

  it("include hints that name served tools, so the check reads real names", () => {
    expect(HINTS.filter(([, hint]) => hint.includes(name("wallet_setup"))).map(([code]) => code)).toEqual(["NoWallet"]);
  });
});
