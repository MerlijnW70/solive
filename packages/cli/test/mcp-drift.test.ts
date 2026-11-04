import { describe, expect, it } from "vitest";
import type { AnyAction } from "../src/agent/actions.js";
import { proseFor, rawUnitsLine, sendsAtOnceLine } from "../src/agent/mcp.js";
import { tool } from "../src/agent/names.js";
import { AMOUNT_PATTERN } from "../src/agent/schema.js";
import { EVERY } from "./served-texts.js";

const SENDS_NOTHING_OF_THE_WALLETS = [tool("wallet_setup")];
const SENDS_AT_ONCE = [tool("submit_signed_intent"), tool("agent_create")];
const RAW_IN_ALL_TOOLS = ["prepare_create", "prepare_signed_intent", "preview_signed_intent", "submit_signed_intent", "prepare_mandate", "prepare_agent_create", "agent_create"].map(tool);
const NOT_TOKENS: readonly string[] = [
  ...["agent_create", "prepare_agent_create"].flatMap((name) => [`${name}.id`, `${name}.nonce`, `${name}.min_result`, `${name}.max_result`]),
  ...["prepare_create", "prepare_signed_intent"].flatMap((name) => [`${name}.nonce`, `${name}.min_result`, `${name}.max_result`]),
  ...["preview_signed_intent", "submit_signed_intent"].flatMap((name) => [`${name}.epoch`, `${name}.nonce`, `${name}.min_result`, `${name}.max_result`]),
  ...["get_claims", "get_intent", "get_receipt", "prepare_cancel", "prepare_crank", "quote", "wallet_cancel", "wallet_claim", "wallet_receipt", "wallet_wait"].map((name) => `${name}.nonce`),
  ...["get_mandate", "prepare_mandate", "prepare_revoke_mandate"].map((name) => `${name}.id`),
  ...["wallet_attest", "wallet_attest_split", "wallet_committee_release", "wallet_committee_vote"].flatMap((name) => [`${name}.nonce`, `${name}.result`]),
  "wallet_escrow.min_result",
  "wallet_escrow.max_result",
];

type Node = { pattern?: unknown; description?: unknown; properties?: Record<string, Node>; oneOf?: Node[]; anyOf?: Node[]; items?: Node };

function amountFields(node: Node, key = ""): { key: string; description: string }[] {
  const own = node.pattern === AMOUNT_PATTERN ? [{ key, description: typeof node.description === "string" ? node.description : "" }] : [];
  return [
    ...own,
    ...Object.entries(node.properties ?? {}).flatMap(([name, child]) => amountFields(child, name)),
    ...[...(node.oneOf ?? []), ...(node.anyOf ?? [])].flatMap((child) => amountFields(child, key)),
    ...(node.items === undefined ? [] : amountFields(node.items, key)),
  ];
}

const hasSend = (action: AnyAction): boolean => "send" in ((action.input.json as Node).properties ?? {});

describe("served texts that cannot drift from the tools", () => {
  it("serves no submit tool that sends without a send field unless the instructions name it as sending at once", () => {
    const withoutSend = EVERY.filter((action) => action.effect === "submit" && !hasSend(action)).map((action) => action.name);
    expect([...withoutSend].sort()).toEqual([...SENDS_NOTHING_OF_THE_WALLETS, ...SENDS_AT_ONCE].sort());
    expect(proseFor(EVERY)).toContain(sendsAtOnceLine(SENDS_AT_ONCE));
    expect(SENDS_AT_ONCE.some((name) => name.includes("wallet_"))).toBe(false);
  });

  it("describes every amount a tool takes as raw units unless it counts no token", () => {
    const counts = EVERY.flatMap((action) =>
      amountFields(action.input.json as Node)
        .filter(({ description }) => !/\braw\b/.test(description))
        .map(({ key }) => `${action.name.replace(/^solive_/, "")}.${key}`),
    );
    expect([...new Set(counts)].sort()).toEqual([...NOT_TOKENS].sort());
    const wallet = EVERY.filter((action) => action.name.includes("wallet_")).flatMap((action) =>
      amountFields(action.input.json as Node)
        .filter(({ description }) => /\braw\b/.test(description))
        .map(({ key }) => `${action.name}.${key}`),
    );
    expect(wallet).toEqual([]);
  });

  it("names the raw-unit tools of --all-tools in its instructions", () => {
    expect(proseFor(EVERY)).toContain(rawUnitsLine(RAW_IN_ALL_TOOLS));
  });
});
