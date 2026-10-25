import { claimsOf } from "../src/agent/claims.js";
import { getBase58Decoder } from "@solana/kit";
import { Client } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it } from "vitest";
import { Kind } from "@intent-engine/core";
import { findConfigPda, getConfigDecoder, getConfigEncoder, kindBit } from "@intent-engine/core/internal";
import { define, invoke, OutputMismatch, toJson } from "../src/agent/actions.js";
import { ANNOTATIONS, annotationsOf } from "../src/agent/mcp.js";
import { VERSION } from "../src/version.js";
import { ACTIONS } from "../src/agent/registry.js";
import { amount, InvalidInput, object } from "../src/agent/schema.js";
import { cli, FEE_BPS, h, transport, type World } from "./harness.js";
import { ok, served } from "./agent-kit.js";
import { WALLET_ACTIONS } from "../src/agent/wallet.js";

describe("agent server against the deployed engine", () => {
  let w: World;
  let client: Client;

  beforeEach(async () => {
    ({ w, client } = await served());
  });

  it("starts from the cli, lists every tool with its schemas and declares what each one touches", async () => {
    expect(client.getServerVersion()).toMatchObject({ name: "solive", version: VERSION });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "solive_get_config",
      "solive_get_intent",
      "solive_list_intents",
      "solive_get_balances",
      "solive_quote",
      "solive_prepare_create",
      "solive_prepare_cancel",
      "solive_find_crank_work",
      "solive_find_jobs",
      "solive_get_spec",
      "solive_hash",
      "solive_prepare_deliver",
      "solive_check_delivery",
      "solive_get_receipt",
      "solive_get_reputation",
      "solive_get_claims",
      "solive_get_profile",
      "solive_prepare_crank",
      "solive_prepare_signed_intent",
      "solive_preview_signed_intent",
      "solive_submit_signed_intent",
      "solive_prepare_mandate",
      "solive_get_mandate",
      "solive_prepare_revoke_mandate",
      "solive_prepare_agent_create",
      "solive_agent_create",
    ]);
    for (const [i, tool] of tools.entries()) {
      const action = ACTIONS[i];
      expect(tool.inputSchema).toEqual(action?.input.json);
      expect(tool.outputSchema).toEqual(action?.output.json);
      expect(tool.title).toBe(action?.title);
      expect(tool.description).toBe(action?.description);
      expect(tool.annotations).toEqual(action === undefined ? undefined : annotationsOf(action));
    }
    expect(tools.filter((t) => t.annotations?.idempotentHint === false && t.annotations.destructiveHint === true).map((t) => t.name)).toEqual([
      "solive_agent_create",
    ]);
    expect(ACTIONS.map((a) => a.effect)).toEqual([
      "read",
      "read",
      "read",
      "read",
      "read",
      "prepare",
      "prepare",
      "read",
      "read",
      "read",
      "read",
      "prepare",
      "read",
      "read",
      "read",
      "read",
      "read",
      "prepare",
      "prepare",
      "read",
      "submit",
      "prepare",
      "read",
      "prepare",
      "prepare",
      "submit",
    ]);
    expect(ANNOTATIONS).toEqual({
      read: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      prepare: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      submit: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    });
    expect(tools.find((t) => t.name === "solive_prepare_signed_intent")?.description).toContain(
      "solive_submit_signed_intent",
    );
  });

  it("reads the live engine settings", async () => {
    const config = await ok(client, "get_config");
    const [address] = await findConfigPda();
    expect(config).toEqual({
      address,
      admin: w.authority.address,
      guardian: w.authority.address,
      fee_recipient: w.feeRecipient.address,
      paused: { create: false, fill: false },
      kinds: ["swap", "limit", "dutch", "attested"].map((kind) => ({
        kind,
        enabled: true,
        fills_stopped: false,
        fee_bps: FEE_BPS,
      })),
      partner_cut_bps: 0,
      crank_bounty: "0",
      create_fee: "0",
      domain_matches_cluster: true,
    });
    const economics = ["set-economics", "--keypair", "a.json", "--yes", "--bounty", "7000", "--create-fee", "9000"];
    await cli([...economics, "--kind-fees", "limit=3", "--partner-cut", "2500"], { "a.json": w.authority });
    await cli(["raise-pause", "--keypair", "a.json", "--yes", "--flags", "create"], { "a.json": w.authority });
    const view = h.svm.getAccount(address);
    if (!view.exists) {
      throw new Error("config missing");
    }
    const decoded = getConfigDecoder().decode(view.data);
    const data = Uint8Array.from(
      getConfigEncoder().encode({
        ...decoded,
        enabledKinds: decoded.enabledKinds & ~kindBit(Kind.DutchAuction),
        fillDisabledKinds: kindBit(Kind.AttestedResult),
      }),
    );
    h.svm.setAccount({ ...view, data });
    h.genesis = getBase58Decoder().decode(new Uint8Array(32).fill(0x12));
    expect(await ok(client, "get_config")).toMatchObject({
      paused: { create: true, fill: false },
      kinds: [
        { kind: "swap", enabled: true, fills_stopped: false, fee_bps: FEE_BPS },
        { kind: "limit", enabled: true, fills_stopped: false, fee_bps: 3 },
        { kind: "dutch", enabled: false, fills_stopped: false, fee_bps: FEE_BPS },
        { kind: "attested", enabled: true, fills_stopped: true, fee_bps: FEE_BPS },
      ],
      partner_cut_bps: 2_500,
      crank_bounty: "7000",
      create_fee: "9000",
      domain_matches_cluster: false,
    });
    await cli(["raise-pause", "--keypair", "a.json", "--yes", "--flags", "fill"], { "a.json": w.authority });
    expect((await ok(client, "get_config"))["paused"]).toEqual({ create: true, fill: true });
    await cli(["lower-pause", "--keypair", "a.json", "--yes", "--flags", "create"], { "a.json": w.authority });
    expect((await ok(client, "get_config"))["paused"]).toEqual({ create: false, fill: true });
  });

  it("checks every result against its declared schema and turns bugs into problems", async () => {
    const lying = define({
      name: "lying",
      title: "t",
      description: "d",
      effect: "read",
      input: object({}),
      output: object({ n: amount() }),
      run: async () => ({ n: 5 }),
    });
    const ctx = { transport, relay: undefined, agent: undefined, claims: claimsOf() };
    const outcome = await invoke(lying, ctx, undefined);
    expect(outcome).toEqual({
      ok: false,
      problem: {
        code: "Failed",
        retryable: false,
        hint: "lying produced output outside its schema: n: must be a whole number of raw token units written as a decimal string",
      },
    });
    expect(new OutputMismatch("x", new InvalidInput([])).name).toBe("OutputMismatch");
    const exploding = define({ ...lying, output: object({}), run: async () => Promise.reject(new TypeError("boom")) });
    expect(await invoke(exploding, ctx, {})).toEqual({ ok: false, problem: { code: "Failed", retryable: false, hint: "boom" } });
    const throwingSchema = define({
      ...lying,
      output: { json: {}, read: () => { throw new RangeError("schema bug"); } },
      run: async () => ({}),
    });
    expect(await invoke(throwingSchema, ctx, {})).toEqual({ ok: false, problem: { code: "Failed", retryable: false, hint: "schema bug" } });
    expect(toJson({ a: [1n, { b: 2n }], c: null, d: "x", e: true })).toEqual({ a: ["1", { b: "2" }], c: null, d: "x", e: true });
  });
});

describe("tool annotations", () => {
  it("submit tools that move value are destructive", () => {
    const hinted = [...WALLET_ACTIONS, ...ACTIONS].map((action) => ({ name: action.name, effect: action.effect, ...annotationsOf(action) }));
    expect(hinted.filter((a) => a.destructiveHint).map((a) => a.name).sort()).toEqual(
      [
        "solive_agent_create",
        "solive_submit_signed_intent",
        "solive_wallet_attest",
        "solive_wallet_attest_split",
        "solive_wallet_auction",
        "solive_wallet_cancel",
        "solive_wallet_claim",
        "solive_wallet_profile",
        "solive_wallet_committee_create",
        "solive_wallet_committee_release",
        "solive_wallet_committee_vote",
        "solive_wallet_deliver",
        "solive_wallet_reclaim",
        "solive_wallet_refute",
        "solive_wallet_escrow",
        "solive_wallet_escrow_plan",
        "solive_wallet_recurring",
        "solive_wallet_swap",
      ].sort(),
    );
    expect(hinted.filter((a) => a.effect === "prepare").every((a) => !a.readOnlyHint && !a.destructiveHint)).toBe(true);
    expect(hinted.filter((a) => a.effect === "read").every((a) => a.readOnlyHint && !a.destructiveHint)).toBe(true);
    expect(hinted.find((a) => a.name === "solive_wallet_setup")).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });
});
