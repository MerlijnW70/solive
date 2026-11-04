import { type Address, generateKeyPairSigner } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import { NATIVE_MINT } from "@intent-engine/core";
import {
  decodeIntentAccount,
  EVENT_IX_TAG,
  getAgentPaidEventEncoder,
  getFeeWithheldEventEncoder,
  getIntentCreatedEventEncoder,
  getIntentFilledEventEncoder,
  getRelayerPaidEventEncoder,
} from "@intent-engine/core/internal";
import { testSignature } from "@intent-engine/client/testing";
import type { EngineTransaction } from "@intent-engine/client";
import { historyIn, recentFills } from "../src/agent/wallet/fills.js";
import { fillsIn, payoutFields } from "../src/monitor-fills.js";
import { h } from "./harness.js";
import { approved } from "./approved.js";
import { createdFrom, fresh, markFilled, ok, preset } from "./agent-wallet-kit.js";
import { AGENT_FEE, AGENT_LANE, ESCROW, payoutChain, RELAYER_FEE } from "./payout-chain.js";

const WITHHELD_AGENT = 2;
const WITHHELD_TREASURY = 3;
const AMOUNT = 50_000_000n;
const SOL_AGENT_FEE = 10_000n;
const SOL_RELAYER_FEE = 5_000n;

const tagged = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);

describe("the fill readers show the payouts of a real fill", () => {
  it("shows the agent's fee on an agent-created fill, in the wallet reader and the monitor reader", async () => {
    const chain = await payoutChain();
    const { intent, agent, account } = await chain.byAgent(false);
    await chain.fill(AGENT_LANE);
    const transactions = await chain.transactions();
    const [seen] = historyIn(transactions).fills;
    expect(seen).toMatchObject({ intent, amountIn: ESCROW, payouts: { agentPaid: { agent, account, fee: AGENT_FEE }, relayerPaid: null, withheld: [], complete: true } });
    const [monitored] = fillsIn(transactions).fills;
    expect(monitored).toMatchObject({ intent, amountIn: ESCROW, payouts: { agentPaid: { agent, account, fee: AGENT_FEE }, relayerPaid: null, withheld: [], complete: true } });
    const [recent] = await recentFills(chain.test.transport, chain.inputMint, chain.outputMint);
    expect(recent?.payouts.agentPaid).toEqual({ agent, account, fee: AGENT_FEE });
    expect(payoutFields(monitored?.payouts ?? { agentPaid: null, relayerPaid: null, withheld: [], complete: false })).toEqual({
      agentPaid: { agent, account, fee: AGENT_FEE.toString() },
    });
  });

  it("shows the relayer's fee on a relayed fill, in the wallet reader and the monitor reader", async () => {
    const chain = await payoutChain();
    const { intent, relayer, account } = await chain.byRelayer();
    await chain.fill(4n);
    const transactions = await chain.transactions();
    const expected = { intent, payouts: { agentPaid: null, relayerPaid: { relayer, account, fee: RELAYER_FEE }, withheld: [], complete: true } };
    expect(historyIn(transactions).fills[0]).toMatchObject(expected);
    expect(fillsIn(transactions).fills[0]).toMatchObject(expected);
    expect(payoutFields(fillsIn(transactions).fills[0]?.payouts ?? { agentPaid: null, relayerPaid: null, withheld: [], complete: false })).toEqual({
      relayerPaid: { relayer, account, fee: RELAYER_FEE.toString() },
    });
  });

  it("shows an agent fee the program withheld", async () => {
    const chain = await payoutChain();
    const { intent, agent, account } = await chain.byAgent(true);
    await chain.fill(AGENT_LANE);
    const transactions = await chain.transactions();
    const withheld = [{ role: "agent", payee: agent, account, amount: AGENT_FEE }];
    expect(historyIn(transactions).fills[0]).toMatchObject({ intent, payouts: { agentPaid: null, withheld } });
    expect(fillsIn(transactions).fills[0]).toMatchObject({ intent, payouts: { agentPaid: null, withheld } });
    expect(payoutFields(fillsIn(transactions).fills[0]?.payouts ?? { agentPaid: null, relayerPaid: null, withheld: [], complete: false })).toEqual({
      withheld: [{ role: "agent", payee: agent, account, fee: AGENT_FEE.toString() }],
    });
  });

  it("marks the payouts incomplete when the intent's creation was not among the transactions read", async () => {
    const chain = await payoutChain();
    await chain.byRelayer();
    await chain.fill(4n);
    const read = (await chain.transactions()).filter((tx) => historyIn([tx]).created.size === 0);
    expect(historyIn(read).fills[0]?.payouts).toMatchObject({ relayerPaid: null, complete: false });
    expect(fillsIn(read).fills[0]?.payouts).toMatchObject({ relayerPaid: null, complete: false });
  });
});

describe("a creation-time treasury fee is not a fill payout", () => {
  it("leaves it out of fills.ts and monitor-fills for a transaction that creates and fills", async () => {
    const intent = (await generateKeyPairSigner()).address;
    const payee = (await generateKeyPairSigner()).address;
    const created = getIntentCreatedEventEncoder().encode({
      intent,
      owner: payee,
      nonce: 0n,
      kind: 1,
      inputMint: payee,
      outputMint: payee,
      receiver: payee,
      escrowed: 0n,
      expiresAt: 0n,
      rentPayer: payee,
      flags: 0,
      bounty: 0,
      createFee: 0,
    });
    const filled = getIntentFilledEventEncoder().encode({
      intent,
      owner: payee,
      solver: payee,
      receiver: payee,
      solverInput: payee,
      amountIn: 1n,
      delivered: 1n,
      required: 1n,
      fee: 0n,
      net: 1n,
      filled: 1n,
      remaining: 0n,
      partnerFee: 0n,
    });
    const treasury = getFeeWithheldEventEncoder().encode({ intent, payee, account: payee, fee: 4n, role: WITHHELD_TREASURY });
    const tx: EngineTransaction = { signature: testSignature("both"), slot: 1n, blockTime: null, failed: false, emitted: [tagged(created), tagged(treasury), tagged(filled)] };
    expect(historyIn([tx]).fills[0]?.payouts).toMatchObject({ withheld: [], complete: true });
    expect(fillsIn([tx]).fills[0]?.payouts).toMatchObject({ withheld: [], complete: true });
  });
});

describe("the wallet's readers show the payouts of a fill of its own intent", () => {
  let client: Awaited<ReturnType<typeof fresh>>;
  let owner: Address;
  let intent: Address;
  let agent: Address;
  let account: Address;
  let relayer: Address;
  let relayerAccount: Address;

  beforeEach(async () => {
    client = await fresh();
    owner = (await ok(client, "wallet_setup"))["address"] as Address;
    intent = (await ok(client, "wallet_escrow", await approved(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: owner })))["intent"] as Address;
    agent = (await generateKeyPairSigner()).address;
    account = (await generateKeyPairSigner()).address;
    relayer = (await generateKeyPairSigner()).address;
    relayerAccount = (await generateKeyPairSigner()).address;
  });

  const filledTx = (events: Uint8Array[]): EngineTransaction => ({
    signature: testSignature("fill"),
    slot: 9n,
    blockTime: 1_700_000_900n,
    failed: false,
    emitted: [
      tagged(
        getIntentFilledEventEncoder().encode({
          intent,
          owner,
          solver: agent,
          receiver: owner,
          solverInput: agent,
          amountIn: AMOUNT,
          delivered: 6_000_000n,
          required: 5_000_000n,
          fee: 0n,
          net: AMOUNT,
          filled: AMOUNT,
          remaining: 0n,
          partnerFee: 0n,
        }),
      ),
      ...events,
    ],
  });

  const agentPaid = () => tagged(getAgentPaidEventEncoder().encode({ intent, agent, account, fee: SOL_AGENT_FEE }));

  const relayed = () => {
    const made = createdFrom(intent);
    return { ...made, emitted: [...made.emitted, tagged(getRelayerPaidEventEncoder().encode({ intent, relayer, account: relayerAccount, fee: SOL_RELAYER_FEE }))] };
  };

  const shownPaid = () => ({
    agent_paid: { agent, account, amount: "0.00001" },
    relayer_paid: { relayer, account: relayerAccount, amount: "0.000005" },
  });

  it("wallet_history shows the agent's and the relayer's fee", async () => {
    h.engineLog = [filledTx([agentPaid()]), relayed()];
    const shown = await ok(client, "wallet_history");
    expect((shown["activity"] as Record<string, unknown>[])[0]).toMatchObject({ intent, outcome: "filled", ...shownPaid() });
  });

  it("wallet_history shows a withheld agent fee and no payout that was not made", async () => {
    const withheld = tagged(getFeeWithheldEventEncoder().encode({ intent, payee: agent, account, fee: SOL_AGENT_FEE, role: WITHHELD_AGENT }));
    h.engineLog = [filledTx([withheld]), createdFrom(intent)];
    const shown = await ok(client, "wallet_history");
    const [item] = shown["activity"] as Record<string, unknown>[];
    expect(item).toMatchObject({ intent, outcome: "filled", withheld: [{ role: "agent", payee: agent, account, amount: "0.00001" }] });
    expect(item).not.toHaveProperty("agent_paid");
    expect(item).not.toHaveProperty("relayer_paid");
  });

  it("wallet_history counts each fill's own payouts once and leaves out the creation's treasury fee", async () => {
    const treasury = tagged(getFeeWithheldEventEncoder().encode({ intent, payee: relayer, account: relayerAccount, fee: 4n, role: WITHHELD_TREASURY }));
    const made = relayed();
    const second = { ...filledTx([]), signature: testSignature("fill-2"), slot: 10n };
    h.engineLog = [second, filledTx([agentPaid()]), { ...made, emitted: [...made.emitted, treasury] }];
    const shown = await ok(client, "wallet_history");
    const [item] = shown["activity"] as Record<string, unknown>[];
    expect(item).toMatchObject({ intent, outcome: "filled", ...shownPaid() });
    expect(item).not.toHaveProperty("withheld");
  });

  it("wallet_wait shows the agent's and the relayer's fee", async () => {
    markFilled(intent);
    h.engineLog = [filledTx([agentPaid()]), relayed()];
    const waited = await ok(client, "wallet_wait", { nonce: "0" });
    expect(waited).toMatchObject({ intent, status: "filled", ...shownPaid() });
    expect(waited).not.toHaveProperty("payouts_incomplete");
  });

  it("wallet_wait says the relayer fee may be missing when the creation was not read", async () => {
    markFilled(intent);
    h.engineLog = [filledTx([agentPaid()])];
    const waited = await ok(client, "wallet_wait", { nonce: "0" });
    expect(waited).toMatchObject({ intent, status: "filled", agent_paid: { agent }, payouts_incomplete: true });
    expect(waited).not.toHaveProperty("relayer_paid");
  });

  it("wallet_estimate shows the agent's and the relayer's fee on each fill it lists", async () => {
    const decoded = decodeIntentAccount((h.svm.getAccount(intent) as { data: Uint8Array }).data);
    preset(decoded.outputMint);
    h.engineLog = [filledTx([agentPaid()]), relayed()];
    const estimate = await ok(client, "wallet_estimate", { sell: decoded.inputMint === NATIVE_MINT ? "SOL" : decoded.inputMint, buy: decoded.outputMint, amount: "0.05" });
    expect((estimate["fills"] as Record<string, unknown>[])[0]).toMatchObject(shownPaid());
  });
});
