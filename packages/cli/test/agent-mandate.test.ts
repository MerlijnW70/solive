import {
  type Address,
  getBase64Encoder,
  getTransactionDecoder,
  type KeyPairSigner,
  partiallySignTransaction,
} from "@solana/kit";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { FailedTransactionMetadata } from "litesvm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildFillIntent,
  findAssociatedTokenAddress,
  findIntentPda,
  findMandatePda,
  findVaultPda,
  formatAmount,
  MANDATE_NONCE_BIT,
  mandateLane,
} from "@intent-engine/core";

const FIRST_LANE = MANDATE_NONCE_BIT | (1n << 32n);
import { getTokenDecoder, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { MAX_COMPUTE_UNITS } from "@intent-engine/solver";
import { createCost, rentFor, TOKEN_ACCOUNT_RENT_BYTES } from "../src/agent/budget.js";
import { AGENT_NONCE_PROBES, agentNonce, freeMandateId, MANDATE_ID_PROBES, NO_MANDATE_HINT, REVOKE_CANCELS } from "../src/agent/mandate.js";
import { callOf, claim, claimsOf } from "../src/agent/claims.js";
import { ENGINE_PROBLEMS, type Problem } from "../src/agent/problems.js";
import type { Transport } from "../src/transport.js";
import { EXIT_OK } from "../src/main.js";
import { ata, balance, cli, funded, h, NOW, send, setNow, transport, type World, world } from "./harness.js";
import { Charged } from "../src/transport.js";

type Json = Record<string, unknown> & { [key: string]: any };

async function serve(extra: string[], signers: Record<string, KeyPairSigner>) {
  h.served.length = 0;
  const started = await cli(["mcp", "--url", "http://agent", ...extra], signers);
  expect([started.code, started.out, started.err]).toEqual([EXIT_OK, "", ""]);
  const server = h.served[0];
  if (server === undefined) {
    throw new Error("no server was started");
  }
  const [near, far] = InMemoryTransport.createLinkedPair();
  await server.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return client;
}

async function call(client: Client, name: string, args: object): Promise<{ ok: boolean; value: Json }> {
  const result = await client.callTool({ name: `solive_${name}`, arguments: args as Record<string, unknown> });
  return { ok: result.isError !== true, value: result.structuredContent as Json };
}

async function ok(client: Client, name: string, args: object): Promise<Json> {
  const r = await call(client, name, args);
  expect(r.ok, JSON.stringify(r.value)).toBe(true);
  return r.value;
}

async function fail(client: Client, name: string, args: object): Promise<Problem> {
  const r = await call(client, name, args);
  expect(r.ok, JSON.stringify(r.value)).toBe(false);
  return r.value as Problem;
}

async function execute(prepared: { transaction: string }, signer: KeyPairSigner): Promise<void> {
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(prepared.transaction));
  const result = h.svm.sendTransaction(await partiallySignTransaction([signer.keyPair], tx));
  if (result instanceof FailedTransactionMetadata) {
    throw new Error(result.toString());
  }
}

function allowance(account: Address): bigint {
  const view = h.svm.getAccount(account);
  return view.exists ? getTokenDecoder().decode(view.data).delegatedAmount : -1n;
}

describe("mandates through the agent server", () => {
  let w: World;
  let agent: KeyPairSigner;
  let client: Client;

  const grant = (over: object = {}) => ({
    owner: w.owner.address,
    agent: agent.address,
    input_mint: w.inputMint,
    output_mint: w.outputMint,
    kinds: ["swap", "limit"],
    per_intent: "400",
    total: "600",
    max_intents: 2,
    max_ttl: 3_600,
    valid_for: 86_400,
    floor: { out: "1", in: "2" },
    ...over,
  });

  const order = (amountIn: string, minOut: string) => ({ kind: "swap", amount_in: amountIn, min_out: minOut });

  beforeEach(async () => {
    w = await world();
    h.watched.length = 0;
    h.watched.push(w.owner.address);
    agent = await funded();
    client = await serve(["--agent", "a.json", "--agent-owners", w.owner.address], { "a.json": agent });
  });

  it("lets an owner grant a mandate that the server's agent key then spends within", async () => {
    const granted = await ok(client, "prepare_mandate", grant({ partner: { account: w.feeRecipient.address, bps: 20 } }));
    const [address] = await findMandatePda({ owner: w.owner.address, agent: agent.address, id: 0n });
    expect(granted).toMatchObject({ mandate: address, id: "0", valid_until: (NOW + 86_400n).toString(), warnings: [] });
    expect(granted["summary"]).toContain(`Per intent: at most 0.0004 of ${w.inputMint}`);
    expect(granted["summary"]).toContain(`May sell: ${w.inputMint} for ${w.outputMint} only, as swap, limit intents`);
    expect(granted["prepared"]["signers"]).toEqual([w.owner.address]);
    await execute(granted["prepared"], w.owner);
    expect(await ok(client, "get_mandate", { owner: w.owner.address, agent: agent.address })).toMatchObject({
      mandate: address,
      owner: w.owner.address,
      agent: agent.address,
      id: "0",
      status: "active",
      input_mint: w.inputMint,
      output_mint: w.outputMint,
      kinds: ["swap", "limit"],
      per_intent: "400",
      total: "600",
      spent: "0",
      remaining: "600",
      max_intents: 2,
      intents: 0,
      max_ttl: "3600",
      floor: { out: "1", in: "2" },
      partner: { account: w.feeRecipient.address, bps: 20 },
    });
    const readBack = (await ok(client, "get_mandate", { owner: w.owner.address, agent: agent.address }))["summary"] as string[];
    expect(readBack).toContain(`Partner fee: 20 bps of the sold amount to ${w.feeRecipient.address}`);
    expect(readBack.join(" | ")).not.toContain("raw units");
    expect(readBack.join(" | ")).toContain(`0.0006 of ${w.inputMint}`);
    const ownerLamports = h.svm.getBalance(w.owner.address);
    const first = await ok(client, "agent_create", { owner: w.owner.address, order: order("400", "200"), expires_in: 600 });
    expect(first).toMatchObject({
      nonce: FIRST_LANE.toString(),
      escrow: "400",
      budget_remaining: "200",
      expires_at: (NOW + 600n).toString(),
    });
    expect(typeof first["signature"]).toBe("string");
    expect(first["summary"][0]).toBe(`Sell: exactly 0.0004 of ${w.inputMint}`);
    expect(balance(w.ownerInput)).toBe(600n);
    expect(h.svm.getBalance(w.owner.address)).toBe(ownerLamports);
    const viewed = await ok(client, "get_intent", { owner: w.owner.address, nonce: FIRST_LANE.toString() });
    expect(viewed["partner"]).toEqual({ account: w.feeRecipient.address, bps: 20 });
    expect(viewed["mandate"]).toBe((await findMandatePda({ owner: w.owner.address, agent: agent.address, id: 0n }))[0]);
    expect(await ok(client, "get_mandate", { owner: w.owner.address, agent: agent.address, id: "0" })).toMatchObject({
      spent: "400",
      remaining: "200",
      intents: 1,
    });
    const refused = async (args: object, code: string) => {
      const problem = await fail(client, "agent_create", { owner: w.owner.address, expires_in: 600, ...args });
      expect(problem.code).toBe(code);
      expect(problem.hint.startsWith(`${ENGINE_PROBLEMS[code as keyof typeof ENGINE_PROBLEMS].hint}; this mandate allows at most`)).toBe(true);
    };
    await refused({ order: order("300", "150") }, "MandateBudget");
    await refused({ order: order("200", "99") }, "MandatePrice");
    await refused({ order: order("200", "100"), expires_in: 3_601 }, "MandateTtl");
    const dutch = { kind: "dutch", amount_in: "10", start_out: "9", end_out: "5", start_time: NOW.toString(), end_time: (NOW + 60n).toString() };
    await refused({ order: dutch }, "MandateKind");
    const prepared = await ok(client, "prepare_agent_create", {
      agent: agent.address,
      owner: w.owner.address,
      order: { kind: "limit", make_amount: "200", take_amount: "100" },
      expires_in: 600,
    });
    expect(prepared).toMatchObject({ nonce: (FIRST_LANE | 1n).toString(), escrow: "200", budget_remaining: "0" });
    expect(prepared["prepared"]["signers"]).toEqual([agent.address]);
    await execute(prepared["prepared"], agent);
    expect(balance(w.ownerInput)).toBe(400n);
    await refused({ order: order("1", "1") }, "MandateBudget");
  });

  it("pins the owner's own accounts, discloses the setup and cancels the agent's open intents on revoke", async () => {
    const fresh = await funded();
    const serving = await serve(["--agent", "a.json", "--agent-owners", fresh.address], { "a.json": agent });
    const freshInput = await ata(w.authority, fresh.address, w.inputMint, 1_000n);
    const granted = await ok(client, "prepare_mandate", grant({ owner: fresh.address }));
    const proceeds = await findAssociatedTokenAddress({ owner: fresh.address, mint: w.outputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(granted["summary"].slice(-4)).toEqual([
      `Proceeds go to ${proceeds}; the agent spends only from ${freshInput}`,
      "Setup: registers you with the engine (a one-time account you pay rent for)",
      `Setup: creates your token account for ${w.outputMint} (you pay its rent)`,
      `Setup: sets the engine's spending allowance on ${freshInput} to 0.0006 (now 0)`,
    ]);
    await execute(granted["prepared"], fresh);
    const opened = [];
    for (const amount of ["300", "200"]) {
      opened.push(
        (await ok(serving, "agent_create", { owner: fresh.address, order: order(amount, "150"), expires_in: 600 }))["intent"],
      );
    }
    expect(balance(freshInput)).toBe(500n);
    const other = await ok(client, "prepare_mandate", grant({ owner: fresh.address }));
    expect(other["id"]).toBe("1");
    await execute(other["prepared"], fresh);
    const kept = await ok(serving, "agent_create", { owner: fresh.address, id: "1", order: order("100", "50"), expires_in: 600 });
    const revoke = await ok(client, "prepare_revoke_mandate", { owner: fresh.address, agent: agent.address });
    expect([revoke["cancelled"], revoke["still_open"], revoke["other_open"]]).toEqual([opened, 0, 1]);
    const [first] = await findMandatePda({ owner: fresh.address, agent: agent.address, id: 0n });
    expect(revoke["allowance"]).toBe("500");
    expect(revoke["warnings"]).toEqual([]);
    expect(revoke["summary"]).toEqual([
      `Revokes mandate ${first}: ${agent.address} can no longer create intents for you, and nobody can fill the ones it made`,
      `Cancels the agent's 2 open intent(s) and returns 0.0005 of ${w.inputMint} to you`,
      `Lowers the engine's spending allowance on ${freshInput} from 0.0006 to 0.0005, taking back the mandate's unused 0.0001`,
      `Leaves your 1 other open intent(s) untouched: ${kept["intent"]}`,
      "Returns the mandate's rent to you",
    ]);
    await execute(revoke["prepared"], fresh);
    expect(balance(freshInput)).toBe(900n);
    expect(allowance(freshInput)).toBe(500n);
    expect((await ok(client, "get_intent", { owner: fresh.address, nonce: kept["nonce"] }))["status"]).toBe("open");
    const gone = await fail(client, "get_mandate", { owner: fresh.address, agent: agent.address });
    expect(gone).toEqual({ code: "NotFound", retryable: false, hint: `mandate ${first} does not exist; ${NO_MANDATE_HINT}` });
    const second = await ok(client, "prepare_revoke_mandate", { owner: fresh.address, agent: agent.address, id: "1" });
    expect([second["cancelled"], second["still_open"], second["other_open"]]).toEqual([[kept["intent"]], 0, 0]);
    expect(second["allowance"]).toBe("0");
    expect(second["summary"]).toContain(
      `Lowers the engine's spending allowance on ${freshInput} from 0.0005 to 0, taking back the mandate's unused 0.0005`,
    );
    await execute(second["prepared"], fresh);
    expect(allowance(freshInput)).toBe(0n);
    expect(balance(freshInput)).toBe(1_000n);
    const idle = await ok(client, "prepare_mandate", grant({ owner: fresh.address }));
    await execute(idle["prepared"], fresh);
    const third = await ok(client, "prepare_revoke_mandate", { owner: fresh.address, agent: agent.address });
    expect(third["summary"]).toContain("None of the agent's intents under it are open");
    expect(third["allowance"]).toBe("0");
    expect(REVOKE_CANCELS).toBe(6);
  });

  it("lets the owner grant the agent a fee that the agent collects and the mandate counts", async () => {
    const granted = await ok(client, "prepare_mandate", grant({ agent_fee: "10" }));
    expect(granted["summary"]).toContain(
      `Agent fee: 0.00001 of ${w.inputMint} per intent, paid to the agent only when that intent fills (refunded if it is cancelled or expires) and counted in every limit above, the price floor included`,
    );
    await execute(granted["prepared"], w.owner);
    expect(await ok(client, "get_mandate", { owner: w.owner.address, agent: agent.address })).toMatchObject({ agent_fee: "10" });
    const capped = await fail(client, "agent_create", { owner: w.owner.address, order: order("391", "1000"), expires_in: 600 });
    expect(capped["hint"]).toContain(
      "; this mandate allows at most 400 raw input units per intent including the agent fee of 10, 600 more raw input units in total, 2 more intents, each expiring within 3600 seconds, and at least 1 raw output units for every 2 raw input units it draws",
    );
    expect(capped["code"], JSON.stringify(capped)).toBe(
      "MandateCap",
    );
    const opening = createCost({ createFee: 0, crankBounty: 0 }) + rentFor(TOKEN_ACCOUNT_RENT_BYTES);
    const tight = await serve(["--agent", "a.json", "--agent-owners", w.owner.address, "--agent-hourly-lamports", (opening - 1n).toString()], { "a.json": agent });
    expect(await fail(tight, "agent_create", { owner: w.owner.address, order: order("390", "200"), expires_in: 600 })).toMatchObject({
      code: "BudgetExhausted",
    });
    const exact = await serve(["--agent", "a.json", "--agent-owners", w.owner.address, "--agent-hourly-lamports", opening.toString()], { "a.json": agent });
    const delivered = transport.send;
    transport.send = async () => {
      throw new Error("the node dropped the transaction");
    };
    try {
      expect(await fail(exact, "agent_create", { owner: w.owner.address, order: order("390", "200"), expires_in: 600 })).toEqual({
        code: "Failed",
        retryable: false,
        hint: "the node dropped the transaction",
      });
    } finally {
      transport.send = delivered;
    }
    const before = balance(w.ownerInput);
    const made = await ok(exact, "agent_create", { owner: w.owner.address, order: order("390", "200"), expires_in: 600 });
    expect(made).toMatchObject({ escrow: "390", agent_fee: "10", budget_remaining: "200" });
    expect(made["summary"]).toContain(
      `Agent fee: 0.00001 of ${w.inputMint}, held with the escrow and paid to the agent only if this intent fills; refunded to the owner if it is cancelled or expires`,
    );
    const earned = await findAssociatedTokenAddress({ owner: agent.address, mint: w.inputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(balance(earned)).toBe(0n);
    expect(before - balance(w.ownerInput)).toBe(400n);
    expect(await ok(client, "get_intent", { owner: w.owner.address, nonce: made["nonce"] })).toMatchObject({ agent_fee: "10" });
    expect(await ok(client, "get_mandate", { owner: w.owner.address, agent: agent.address })).toMatchObject({
      spent: "400",
      remaining: "200",
    });
    const solver = await funded();
    const solverOutput = await ata(w.authority, solver.address, w.outputMint, 1_000n);
    const solverInput = await ata(w.authority, solver.address, w.inputMint);
    await ata(w.authority, w.feeRecipient.address, w.inputMint);
    const [mandate] = await findMandatePda({ owner: w.owner.address, agent: agent.address, id: 0n });
    await send(solver, [
      await buildFillIntent({
        solver,
        owner: w.owner.address,
        nonce: BigInt(made["nonce"]),
        inputMint: w.inputMint,
        outputMint: w.outputMint,
        inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
        receiver: await findAssociatedTokenAddress({ owner: w.owner.address, mint: w.outputMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }),
        solverOutput,
        solverInput,
        feeRecipient: w.feeRecipient.address,
        mandate,
        agent: agent.address,
        amountIn: 390n,
        amountOut: 200n,
        maxFeeBps: 100,
      }),
    ]);
    expect(balance(earned)).toBe(10n);
    expect(await ok(client, "get_intent", { owner: w.owner.address, nonce: made["nonce"] })).toMatchObject({
      status: "filled",
      agent_fee: "0",
    });
    const second = await ok(client, "agent_create", { owner: w.owner.address, order: order("190", "100"), expires_in: 600 });
    expect(await fail(client, "prepare_cancel", { owner: w.owner.address, nonce: second["nonce"], close: true })).toEqual({
      code: "NotRentPayer",
      retryable: false,
      hint: `${agent.address} paid this intent's rent and bounty, so only it can close the intent; cancel without close`,
    });
    const cancel = await ok(client, "prepare_cancel", { owner: w.owner.address, nonce: second["nonce"] });
    const [vault] = await findVaultPda({ intent: second["intent"] });
    const held = (h.svm.getBalance(second["intent"]) ?? 0n) + (h.svm.getBalance(vault) ?? 0n);
    expect(cancel["summary"].at(-1)).toBe(
      `The intent and its escrow account stay until ${agent.address}, who paid for them, closes them; that returns their ${held} lamports (${formatAmount(held, 9)} SOL) to them`,
    );
    await execute(cancel["prepared"], w.owner);
    expect(balance(earned)).toBe(10n);
    expect(before - balance(w.ownerInput)).toBe(400n);
  });

  it("gives parallel agent creates distinct nonces and charges the budget once each", async () => {
    await execute((await ok(client, "prepare_mandate", grant({ max_intents: 4, total: "1000" })))["prepared"], w.owner);
    const cost = createCost({ createFee: 0, crankBounty: 0 });
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
    const cost = createCost({ createFee: 0, crankBounty: 0 });
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
    const cost = createCost({ createFee: 0, crankBounty: 0 });
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
      throw new Charged("transaction landed and failed");
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
