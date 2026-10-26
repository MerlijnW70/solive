import { type KeyPairSigner } from "@solana/kit";
import { Client } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it } from "vitest";
import { findAssociatedTokenAddress, formatAmount } from "@intent-engine/core";
import { buildFillIntent, findMandatePda, findVaultPda } from "@intent-engine/core/internal";
import { getCloseAccountInstruction, getTransferInstruction, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { createCost, rentFor, rentRate, TOKEN_ACCOUNT_RENT_BYTES } from "../src/agent/budget.js";
import { NO_MANDATE_HINT, REVOKE_CANCELS } from "../src/agent/mandate.js";
import { ENGINE_PROBLEMS, SERVER_PROBLEMS } from "../src/agent/problems.js";
import { ata, balance, funded, h, NOW, send, transport, type World } from "./harness.js";
import { allowance, execute, fail, FIRST_LANE, grantOf, mandateServed, ok, order, serve } from "./agent-mandate-kit.js";

describe("mandates through the agent server", () => {
  let w: World;
  let agent: KeyPairSigner;
  let client: Client;

  const grant = (over: object = {}) => grantOf(w, agent, over);

  beforeEach(async () => {
    ({ w, agent, client } = await mandateServed());
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
    expect(readBack).toContain(`Partner fee: 20 bps of the sold amount, rounded up, to ${w.feeRecipient.address}, less the protocol's partner cut fixed when the intent is created`);
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
      `Cancels the agent's 2 open intent(s) and returns 0.0005 of ${w.inputMint} to you, one transaction each after the revocation`,
      `Lowers the engine's spending allowance on ${freshInput} from 0.0006 to 0.0005, taking back the mandate's unused 0.0001`,
      `Leaves your 1 other open intent(s) untouched: ${kept["intent"]}`,
      "Returns the mandate's rent to you",
    ]);
    expect([revoke["skipped"], revoke["cancels"].length]).toEqual([[], 2]);
    await execute(revoke["prepared"], fresh);
    expect(balance(freshInput)).toBe(400n);
    for (const cancel of revoke["cancels"]) {
      await execute(cancel, fresh);
    }
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
    await execute(second["cancels"][0], fresh);
    expect(allowance(freshInput)).toBe(0n);
    expect(balance(freshInput)).toBe(1_000n);
    const idle = await ok(client, "prepare_mandate", grant({ owner: fresh.address }));
    await execute(idle["prepared"], fresh);
    const third = await ok(client, "prepare_revoke_mandate", { owner: fresh.address, agent: agent.address });
    expect(third["summary"]).toContain("None of the agent's intents under it are open");
    expect(third["allowance"]).toBe("0");
    expect(REVOKE_CANCELS).toBe(6);
  });

  it("revoke succeeds when a cancel cannot refund", async () => {
    await execute((await ok(client, "prepare_mandate", grant()))["prepared"], w.owner);
    const opened = [];
    for (const amount of ["300", "200"]) {
      opened.push((await ok(client, "agent_create", { owner: w.owner.address, order: order(amount, "150"), expires_in: 600 }))["intent"]);
    }
    const elsewhere = await ata(w.authority, w.feeRecipient.address, w.inputMint);
    await send(w.owner, [
      getTransferInstruction({ source: w.ownerInput, destination: elsewhere, authority: w.owner, amount: balance(w.ownerInput) }),
      getCloseAccountInstruction({ account: w.ownerInput, destination: w.owner.address, owner: w.owner }),
    ]);
    expect(h.svm.getAccount(w.ownerInput).exists).toBe(false);
    const revoke = await ok(client, "prepare_revoke_mandate", { owner: w.owner.address, agent: agent.address });
    expect([revoke["cancelled"], revoke["cancels"], revoke["still_open"]]).toEqual([[], [], 2]);
    const reason = `the refund to your token account ${w.ownerInput} would fail: it does not exist; fix it, then cancel with solive_prepare_cancel`;
    expect(revoke["skipped"]).toEqual(opened.map((intent) => ({ intent, reason })));
    expect(revoke["summary"]).toContain(`Does not cancel ${opened[0]}: ${reason}`);
    expect(revoke["warnings"]).toHaveLength(1);
    await execute(revoke["prepared"], w.owner);
    const [address] = await findMandatePda({ owner: w.owner.address, agent: agent.address, id: 0n });
    expect(h.svm.getAccount(address).exists).toBe(false);
    for (const intent of opened) {
      expect(balance((await findVaultPda({ intent }))[0])).toBeGreaterThan(0n);
    }
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
    const rate = await rentRate(transport);
    const opening = createCost({ createFee: 0, crankBounty: 0 }, rate) + rentFor(TOKEN_ACCOUNT_RENT_BYTES, rate);
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
        hint: SERVER_PROBLEMS.Failed.hint,
        untrustedDetail: "the node dropped the transaction",
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
});
