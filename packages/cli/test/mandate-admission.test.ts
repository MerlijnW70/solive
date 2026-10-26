import { type Address, createNoopSigner, type KeyPairSigner } from "@solana/kit";
import { Client } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it } from "vitest";
import { TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import { buildCreateIntentByAgent, findIntentPda, mandateLane, validate } from "@intent-engine/core/internal";
import { loadConfig } from "@intent-engine/client/internal";
import { loadMandate, mandateRefusal } from "../src/agent/mandate-state.js";
import { prepare } from "../src/agent/prepare.js";
import { ENGINE_PROBLEMS, SimulationFailed } from "../src/agent/problems.js";
import { paramsOf } from "../src/agent/shapes.js";
import { EXIT_OK } from "../src/main.js";
import { ata, balance, cli, h, NOW, setNow, transport, type World } from "./harness.js";
import { call, execute, FIRST_LANE, grantOf, mandateServed, ok, order } from "./agent-mandate-kit.js";

const U64_MAX = (1n << 64n) - 1n;

type Order = Record<string, string>;

const limit = (make: string, take: string) => ({ kind: "limit", make_amount: make, take_amount: take });
const dutch = (amountIn: string, endOut: string) => ({
  kind: "dutch",
  amount_in: amountIn,
  start_out: (BigInt(endOut) * 2n).toString(),
  end_out: endOut,
  start_time: NOW.toString(),
  end_time: (NOW + 60n).toString(),
});
const typed = (o: Order) =>
  validate(paramsOf(Object.fromEntries(Object.entries(o).map(([key, value]) => [key, key === "kind" || key === "attestor" ? value : BigInt(value)])) as never));
const attested = (attestor: Address) => ({ kind: "attested", amount_in: "10", min_result: "1", max_result: "2", attestor });

describe("the mandate tools agree with the program on every limit", () => {
  let w: World;
  let agent: KeyPairSigner;
  let client: Client;
  let probe = 200n;

  const grant = async (over: object, id = "0") => {
    const granted = await ok(client, "prepare_mandate", grantOf(w, agent, { id, ...over }));
    await execute(granted["prepared"], w.owner);
  };

  const program = async (id: string, o: Order, expiresAt: bigint): Promise<string> => {
    const { mandate } = await loadMandate(transport, w.owner.address, agent.address, BigInt(id));
    const { config } = await loadConfig(transport);
    probe += 1n;
    const create = await buildCreateIntentByAgent({
      agent: createNoopSigner(agent.address),
      owner: w.owner.address,
      mandateId: BigInt(id),
      treasury: config.feeRecipient,
      maxCreateFee: config.createFee,
      maxBounty: config.crankBounty,
      nonce: (mandateLane(mandate.serial) ?? 0n) | probe,
      params: typed(o),
      expiresAt,
      ...(mandate.partnerBps === 0 ? {} : { partner: { key: mandate.partner, bps: mandate.partnerBps } }),
      inputMint: mandate.inputMint,
      outputMint: mandate.outputMint,
      inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
      ownerInput: mandate.inputAccount,
      receiver: mandate.outputAccount,
    });
    try {
      await prepare(transport, [create], agent.address);
      return "ok";
    } catch (error) {
      if (error instanceof SimulationFailed) {
        return error.problem.code;
      }
      throw error;
    }
  };

  const tool = async (id: string, o: Order, expiresAt: bigint): Promise<{ code: string; simulated: number; hint: string }> => {
    const before = h.simulated.length;
    const r = await call(client, "prepare_agent_create", {
      agent: agent.address,
      owner: w.owner.address,
      id,
      order: o,
      expires_at: expiresAt.toString(),
    });
    return { code: r.ok ? "ok" : (r.value["code"] as string), simulated: h.simulated.length - before, hint: r.ok ? "" : (r.value["hint"] as string) };
  };

  const agree = async (id: string, o: Order, expected: string, expiresAt = NOW + 600n) => {
    const verdict = await program(id, o, expiresAt);
    const said = await tool(id, o, expiresAt);
    expect([verdict, said.code], JSON.stringify(o)).toEqual([expected, expected]);
    if (expected === "ok") {
      expect(said.simulated).toBeGreaterThan(0);
    } else {
      expect(said.simulated, `${expected} must be refused before anything is simulated or signed`).toBe(0);
      expect(said.hint.startsWith(`${ENGINE_PROBLEMS[expected as keyof typeof ENGINE_PROBLEMS].hint}; this mandate allows at most`)).toBe(true);
    }
  };

  const create = async (id: string, o: Order) =>
    ok(client, "agent_create", { owner: w.owner.address, id, order: o, expires_at: (NOW + 600n).toString() });

  beforeEach(async () => {
    ({ w, agent, client } = await mandateServed());
    await ata(w.authority, w.owner.address, w.inputMint, 9_000n);
    probe = 200n;
  });

  it("agrees on the per-intent cap with the agent fee, the price floor of every kind and every kind bit", async () => {
    await grant({ kinds: ["swap", "limit"], per_intent: "400", total: "1000", max_intents: 3, agent_fee: "10", floor: { out: "3", in: "7" } });
    await agree("0", order("391", "1000"), "MandateCap");
    await agree("0", order("390", "172"), "ok");
    await agree("0", order("390", "171"), "MandatePrice");
    await agree("0", limit("390", "172"), "ok");
    await agree("0", limit("390", "171"), "MandatePrice");
    await agree("0", dutch("390", "172"), "MandateKind");
    await agree("0", attested(agent.address), "MandateKind");
    await grant({ kinds: ["dutch"], per_intent: "400", total: "1000", max_intents: 3, floor: { out: "1", in: "2" } }, "1");
    await agree("1", dutch("10", "5"), "ok");
    await agree("1", dutch("10", "4"), "MandatePrice");
    await agree("1", order("10", "5"), "MandateKind");
    await agree("1", limit("10", "5"), "MandateKind");
  });

  it("agrees on the total over several intents and on the intent count", async () => {
    await grant({ per_intent: "400", total: "1000", max_intents: 4, agent_fee: "10" });
    await create("0", order("390", "200"));
    await create("0", order("390", "200"));
    await agree("0", order("191", "101"), "MandateBudget");
    await agree("0", order("190", "100"), "ok");
    await create("0", order("190", "100"));
    await agree("0", order("1", "6"), "MandateBudget");
    expect(await ok(client, "get_mandate", { owner: w.owner.address, agent: agent.address })).toMatchObject({ spent: "1000", intents: 3 });
    await grant({ per_intent: "400", total: "1000", max_intents: 2 }, "1");
    await create("1", order("10", "5"));
    await agree("1", order("10", "5"), "ok");
    await create("1", order("10", "5"));
    await agree("1", order("10", "5"), "MandateCount");
  });

  it("agrees on the longest lifetime and on the end of the mandate", async () => {
    await grant({ max_ttl: 3_600, valid_for: 7_200 });
    await agree("0", order("10", "5"), "ok", NOW + 3_600n);
    await agree("0", order("10", "5"), "MandateTtl", NOW + 3_601n);
    setNow(NOW + 7_199n);
    await agree("0", order("10", "5"), "ok", NOW + 7_199n + 3_600n);
    await agree("0", order("10", "5"), "MandateTtl", NOW + 7_199n + 3_601n);
    setNow(NOW + 7_200n);
    await agree("0", order("10", "5"), "MandateExpired", NOW + 7_300n);
  });

  it("agrees on the price floor at the largest values the types allow", async () => {
    await grant({ per_intent: "400", total: "1000", max_intents: 4, floor: { out: U64_MAX.toString(), in: U64_MAX.toString() } });
    await agree("0", order("400", "400"), "ok");
    await agree("0", order("400", "399"), "MandatePrice");
    await grant({ per_intent: "400", total: "1000", max_intents: 4, floor: { out: U64_MAX.toString(), in: "1" } }, "1");
    await agree("1", order("1", U64_MAX.toString()), "ok");
    await agree("1", order("1", (U64_MAX - 1n).toString()), "MandatePrice");
    await agree("1", order("2", U64_MAX.toString()), "MandatePrice");
    await grant({ per_intent: "400", total: "1000", max_intents: 4, floor: { out: "1", in: U64_MAX.toString() } }, "2");
    await agree("2", order("400", "1"), "ok");
  });

  it("agrees that a revoked or re-epoched mandate opens nothing", async () => {
    await grant({});
    await grant({}, "1");
    await agree("0", order("10", "5"), "ok");
    expect((await cli(["advance-epoch", "--keypair", "o.json"], { "o.json": w.owner })).code).toBe(EXIT_OK);
    await agree("0", order("10", "5"), "MandateRevoked");
    await agree("1", order("10", "5"), "MandateRevoked");
  });

  it("always names the mandate's partner, accounts and mints, so the program admits what the tool builds", async () => {
    const partner = w.feeRecipient.address;
    await grant({ partner: { account: partner, bps: 100 }, per_intent: "400", total: "1000" });
    await agree("0", order("10", "5"), "ok");
    const before = balance(w.ownerInput);
    const made = await create("0", order("10", "5"));
    const viewed = await ok(client, "get_intent", { owner: w.owner.address, nonce: made["nonce"] });
    const { mandate } = await loadMandate(transport, w.owner.address, agent.address, 0n);
    expect(viewed).toMatchObject({
      partner: { account: partner, bps: 100 },
      input_mint: mandate.inputMint,
      output_mint: mandate.outputMint,
      receiver: mandate.outputAccount,
    });
    expect(mandate.inputAccount).toBe(w.ownerInput);
    expect(before - balance(w.ownerInput)).toBe(10n);
  });

  it("refuses an intent that would stay open past the mandate's longest lifetime before simulating or sending it", async () => {
    await grant({ max_ttl: 3_600 });
    const before = { simulated: h.simulated.length, balance: balance(w.ownerInput) };
    const refused = await call(client, "agent_create", {
      owner: w.owner.address,
      order: order("10", "5"),
      expires_at: (NOW + 3_601n).toString(),
    });
    expect(refused.ok).toBe(false);
    expect(refused.value).toMatchObject({ code: "MandateTtl", retryable: false });
    expect(h.simulated.length).toBe(before.simulated);
    expect(balance(w.ownerInput)).toBe(before.balance);
    const [intent] = await findIntentPda({ owner: w.owner.address, nonce: FIRST_LANE });
    expect(h.svm.getAccount(intent).exists).toBe(false);
    const { mandate } = await loadMandate(transport, w.owner.address, agent.address, 0n);
    const admission = { params: typed(order("10", "5")), now: NOW, ownerEpoch: mandate.epoch };
    expect(mandateRefusal(mandate, { ...admission, expiresAt: NOW + 3_601n })).toBe("MandateTtl");
    expect(mandateRefusal(mandate, { ...admission, expiresAt: NOW + 3_600n })).toBeNull();
    expect((await ok(client, "agent_create", { owner: w.owner.address, order: order("10", "5"), expires_at: (NOW + 3_600n).toString() }))["nonce"]).toBe(
      FIRST_LANE.toString(),
    );
  });
});
