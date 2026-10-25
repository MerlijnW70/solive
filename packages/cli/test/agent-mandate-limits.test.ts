import { type Address, type KeyPairSigner, type Signature } from "@solana/kit";
import { Client } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it } from "vitest";
import { findIntentPda, findMandatePda, mandateLane } from "@intent-engine/core/internal";
import { MAX_COMPUTE_UNITS } from "@intent-engine/solver";
import { FailedOnChain, type Transport } from "@intent-engine/client";
import { failure } from "@intent-engine/client/internal";
import { createCost, rentRate } from "../src/agent/budget.js";
import { AGENT_NONCE_PROBES, agentNonce, freeMandateId, MANDATE_ID_PROBES } from "../src/agent/mandate.js";
import { callOf, claim, claimsOf } from "../src/agent/claims.js";
import { EXIT_OK } from "../src/main.js";
import { cli, funded, NOW, setNow, transport, type World } from "./harness.js";
import { execute, fail, FIRST_LANE, grantOf, mandateServed, ok, order, serve } from "./agent-mandate-kit.js";

describe("mandates through the agent server", () => {
  let w: World;
  let agent: KeyPairSigner;
  let client: Client;

  const grant = (over: object = {}) => grantOf(w, agent, over);

  beforeEach(async () => {
    ({ w, agent, client } = await mandateServed());
  });

  it("gives parallel agent creates distinct nonces and charges the budget once each", async () => {
    await execute((await ok(client, "prepare_mandate", grant({ max_intents: 4, total: "1000" })))["prepared"], w.owner);
    const cost = createCost({ createFee: 0, crankBounty: 0 }, await rentRate(transport));
    const exact = await serve(["--agent", "a.json", "--agent-owners", w.owner.address, "--agent-hourly-lamports", (2n * cost).toString()], { "a.json": agent });
    const made = await Promise.all(
      [0, 1].map(() => ok(exact, "agent_create", { owner: w.owner.address, order: order("100", "50"), expires_in: 600 })),
    );
    expect(new Set(made.map((m) => m["nonce"])).size).toBe(2);
    for (const m of made) {
      expect((await ok(client, "get_intent", { owner: w.owner.address, nonce: m["nonce"] }))["status"]).toBe("open");
    }
    expect(await ok(client, "get_mandate", { owner: w.owner.address, agent: agent.address })).toMatchObject({ intents: 2 });
    const prepared = await Promise.all(
      [0, 1].map(() =>
        ok(client, "prepare_agent_create", { agent: agent.address, owner: w.owner.address, order: order("10", "5"), expires_in: 600 }),
      ),
    );
    expect(new Set(prepared.map((m) => m["nonce"])).size).toBe(2);
    const chosen = { agent: agent.address, owner: w.owner.address, order: order("10", "5"), expires_in: 600, nonce: (FIRST_LANE | 40n).toString() };
    await ok(client, "prepare_agent_create", chosen);
    expect(await fail(client, "prepare_agent_create", chosen)).toMatchObject({ code: "NoncePromised", retryable: true });
  });

  it("acts only for the owners and within the budget the agent key was started with", async () => {
    await execute((await ok(client, "prepare_mandate", grant()))["prepared"], w.owner);
    const outsider = (await funded()).address;
    const picky = await serve(["--agent", "a.json", "--agent-owners", outsider], { "a.json": agent });
    expect(await fail(picky, "agent_create", { owner: w.owner.address, order: order("10", "5"), expires_in: 600 })).toEqual({
      code: "OwnerNotServed",
      retryable: false,
      hint: `this agent only acts for the owners it was started with; ${w.owner.address} is not one of them`,
    });
    const cost = createCost({ createFee: 0, crankBounty: 0 }, await rentRate(transport));
    const frugal = await serve(["--agent", "a.json", "--agent-owners", w.owner.address, "--agent-hourly-lamports", cost.toString()], { "a.json": agent });
    await ok(frugal, "agent_create", { owner: w.owner.address, order: order("10", "5"), expires_in: 600 });
    expect(await fail(frugal, "agent_create", { owner: w.owner.address, order: order("10", "5"), expires_in: 600 })).toMatchObject({
      code: "BudgetExhausted",
      retryable: true,
    });
    const spare = await serve(["--agent", "a.json", "--agent-owners", w.owner.address, "--agent-hourly-lamports", cost.toString()], { "a.json": agent });
    expect((await fail(spare, "agent_create", { owner: w.owner.address, order: order("10", "1"), expires_in: 600 }))["code"]).toBe(
      "MandatePrice",
    );
    const priced = ["--agent", "a.json", "--agent-owners", w.owner.address, "--priority-fee", "1000000", "--agent-hourly-lamports"];
    const short = await serve([...priced, cost.toString()], { "a.json": agent });
    const refused = await fail(short, "agent_create", { owner: w.owner.address, order: order("10", "5"), expires_in: 600 });
    expect(refused["code"]).toBe("BudgetExhausted");
    const needed = BigInt(/this needs (\d+)$/.exec(refused["hint"] as string)?.[1] ?? "0");
    expect(needed).toBeGreaterThan(cost);
    expect(needed).toBeLessThanOrEqual(cost + BigInt(MAX_COMPUTE_UNITS));
    const roomy = await serve([...priced, needed.toString()], { "a.json": agent });
    await ok(roomy, "agent_create", { owner: w.owner.address, order: order("10", "5"), expires_in: 600 });
  });

  it("keeps the agent's budget spent when a send may already have been paid for, and only then", async () => {
    await execute((await ok(client, "prepare_mandate", grant()))["prepared"], w.owner);
    const cost = createCost({ createFee: 0, crankBounty: 0 }, await rentRate(transport));
    const args = { owner: w.owner.address, order: order("10", "5"), expires_in: 600 };
    const dropped = await serve(["--agent", "a.json", "--agent-owners", w.owner.address, "--agent-hourly-lamports", cost.toString()], { "a.json": agent });
    const delivered = transport.send;
    transport.send = async () => {
      throw new Error("the node rejected the transaction");
    };
    try {
      expect((await fail(dropped, "agent_create", args))["code"]).toBe("Failed");
    } finally {
      transport.send = delivered;
    }
    await ok(dropped, "agent_create", args);
    const charged = await serve(["--agent", "a.json", "--agent-owners", w.owner.address, "--agent-hourly-lamports", cost.toString()], { "a.json": agent });
    transport.send = async () => {
      throw new FailedOnChain("transaction landed and failed", failure("1".repeat(64) as Signature, null));
    };
    try {
      expect((await fail(charged, "agent_create", args))["code"]).toBe("Failed");
    } finally {
      transport.send = delivered;
    }
    expect((await fail(charged, "agent_create", args))["code"]).toBe("BudgetExhausted");
  });

  it("reports and enforces expiry, epoch revocation and explicit revocation", async () => {
    await execute((await ok(client, "prepare_mandate", grant({ valid_for: 600 })))["prepared"], w.owner);
    const second = await ok(client, "prepare_mandate", grant({ total: "400", per_intent: "400" }));
    expect(second["id"]).toBe("1");
    await execute(second["prepared"], w.owner);
    const plain = await ok(client, "get_mandate", { owner: w.owner.address, agent: agent.address, id: "1" });
    expect(plain["partner"]).toBeNull();
    expect(plain["summary"].some((line: string) => line.startsWith("Partner fee"))).toBe(false);
    setNow(NOW + 600n);
    expect((await ok(client, "get_mandate", { owner: w.owner.address, agent: agent.address }))["status"]).toBe("expired");
    expect(await fail(client, "agent_create", { owner: w.owner.address, order: order("10", "5"), expires_in: 600 })).toMatchObject({
      code: "MandateExpired",
    });
    await ok(client, "agent_create", { owner: w.owner.address, id: "1", order: order("10", "5"), expires_in: 600 });
    expect((await cli(["advance-epoch", "--keypair", "o.json"], { "o.json": w.owner })).code).toBe(EXIT_OK);
    expect((await ok(client, "get_mandate", { owner: w.owner.address, agent: agent.address, id: "1" }))["status"]).toBe("revoked");
    expect(await fail(client, "agent_create", { owner: w.owner.address, id: "1", order: order("10", "5"), expires_in: 600 })).toMatchObject({
      code: "MandateRevoked",
    });
    const revoke = await ok(client, "prepare_revoke_mandate", { owner: w.owner.address, agent: agent.address, id: "1" });
    expect(revoke["prepared"]["signers"]).toEqual([w.owner.address]);
    await execute(revoke["prepared"], w.owner);
    expect(await fail(client, "get_mandate", { owner: w.owner.address, agent: agent.address, id: "1" })).toMatchObject({
      code: "NotFound",
    });
    expect((await fail(client, "prepare_revoke_mandate", { owner: w.owner.address, agent: agent.address, id: "1" }))["code"]).toBe(
      "NotFound",
    );
  });

  it("refuses unsound grants and agents the server does not hold", async () => {
    expect(await fail(client, "prepare_mandate", grant({ kinds: [] }))).toMatchObject({
      code: "InvalidInput",
      issues: [{ path: "kinds", message: "must hold 1 to 3 items" }],
    });
    expect((await fail(client, "prepare_mandate", grant({ total: "399" })))["code"]).toBe("MandateInvalid");
    for (const fee of ["400", "401"]) {
      expect(await fail(client, "prepare_mandate", grant({ agent_fee: fee }))).toMatchObject({
        code: "InvalidInput",
        issues: [{ path: "agent_fee", message: "must be less than per_intent, which includes it" }],
      });
    }
    expect(await fail(client, "prepare_mandate", grant({ per_intent: "0", total: "0" }))).toMatchObject({
      code: "InvalidInput",
      issues: [{ path: "per_intent", message: "must be more than 0" }],
    });
    expect((await fail(client, "prepare_mandate", grant({ per_intent: "1", total: "0" })))["code"]).toBe("MandateInvalid");
    expect((await ok(client, "prepare_mandate", grant({ agent_fee: "399" })))["summary"]).toContain(
      `Largest single sale: 0.000001 of ${w.inputMint}, the per-intent cap less the agent fee`,
    );
    expect((await fail(client, "prepare_mandate", grant({ agent: w.owner.address })))["code"]).toBe("MandateInvalid");
    expect((await fail(client, "prepare_mandate", grant({ output_mint: w.inputMint })))["code"]).toBe("SameMint");
    const keyless = await serve([], {});
    expect(await fail(keyless, "agent_create", { owner: w.owner.address, order: order("10", "5"), expires_in: 600 })).toEqual({
      code: "AgentNotConfigured",
      retryable: false,
      hint: "this server holds no agent key; start it with --agent to act under mandates",
    });
    expect((await fail(client, "agent_create", { owner: w.owner.address, order: order("10", "5"), expires_in: 600 }))["code"]).toBe(
      "NotFound",
    );
  });

  it("picks the next free mandate id and stops after a bounded search", async () => {
    expect(MANDATE_ID_PROBES).toBe(64);
    const existing = (ids: Set<string>): Transport => ({
      ...transport,
      getAccount: async (address: Address) => (ids.has(address) ? { owner: address, data: new Uint8Array(), lamports: 0n } : null),
    });
    const owner = w.owner.address;
    const at = async (id: bigint) => (await findMandatePda({ owner, agent: agent.address, id }))[0];
    expect(await freeMandateId(existing(new Set()), owner, agent.address)).toBe(0n);
    expect(await freeMandateId(existing(new Set([await at(0n), await at(1n)])), owner, agent.address)).toBe(2n);
    const ids = await Promise.all(Array.from({ length: 64 }, (_, i) => at(BigInt(i))));
    expect(await freeMandateId(existing(new Set(ids.slice(0, 63))), owner, agent.address)).toBe(63n);
    await expect(freeMandateId(existing(new Set(ids)), owner, agent.address)).rejects.toMatchObject({
      problem: { code: "NoFreeMandateId", retryable: false, hint: "this owner already granted 64 mandates to this agent; revoke one first" },
    });
  });

  it("refuses an agent nonce when the grant has no lane or every probed nonce in it is taken or promised", async () => {
    expect(AGENT_NONCE_PROBES).toBe(64n);
    const owner = w.owner.address;
    const hold = () => ({ claims: claimsOf(), call: callOf(), now: NOW });
    await expect(agentNonce(transport, owner, 0n, 0, hold())).rejects.toMatchObject({
      problem: { code: "NoFreeNonce", hint: "this mandate's grant serial has no nonce lane; the owner must grant a new mandate" },
    });
    const lane = mandateLane(1n) ?? 0n;
    const crowded: Transport = {
      ...transport,
      getAccount: async (address: Address) => ({ owner: address, data: new Uint8Array(), lamports: 0n }),
    };
    await expect(agentNonce(crowded, owner, 1n, 5, hold())).rejects.toMatchObject({
      problem: { code: "NoFreeNonce", hint: "this mandate's nonce lane is crowded; close some of its finished intents first" },
    });
    const lastFree: Transport = {
      ...transport,
      getAccount: async (address: Address) =>
        address === (await findIntentPda({ owner, nonce: lane | 68n }))[0] ? null : { owner: address, data: new Uint8Array(), lamports: 0n },
    };
    expect(await agentNonce(lastFree, owner, 1n, 5, hold())).toBe(lane | 68n);
    const promised = hold();
    claim(promised.claims, promised.call, owner, lane | 68n, NOW + 60n, NOW);
    await expect(agentNonce(lastFree, owner, 1n, 5, promised)).rejects.toMatchObject({ problem: { code: "NoFreeNonce" } });
  });
});
