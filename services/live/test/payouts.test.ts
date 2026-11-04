import { type Address } from "@solana/kit";
import { Kind, NATIVE_MINT } from "@intent-engine/core";
import {
  EVENT_IX_TAG,
  getAgentPaidEventEncoder,
  getFeeWithheldEventEncoder,
  getIntentCreatedEventEncoder,
  getRelayerPaidEventEncoder,
  WITHHELD_ROLES,
} from "@intent-engine/core/internal";
import { describe, expect, it } from "vitest";
import { addressOf, filled, OWNER, signatureOf, SOLVER, type Tx } from "./chain.js";
import { nowSecs, rig } from "./harness.js";

const SWAP = addressOf(4);
const AGENT = addressOf(21);
const RELAYER = addressOf(22);
const AGENT_ACCOUNT = addressOf(23);
const RELAYER_ACCOUNT = addressOf(24);
const AGENT_FEE = 10_000_000n;
const RELAYER_FEE = 2_000_000n;
const WITHHELD_AGENT = Number(Object.entries(WITHHELD_ROLES).find(([, role]) => role === "agent")?.[0]);

const tagged = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);

const at = (n: number, events: Uint8Array[]): Tx => ({ signature: signatureOf(100 + n), slot: 1000 + n, blockTime: nowSecs(-3600 + n * 60), events, mints: [NATIVE_MINT] });

const swapCreated = (intent: Address) =>
  tagged(
    getIntentCreatedEventEncoder().encode({
      intent,
      owner: OWNER,
      nonce: 0n,
      kind: Kind.SwapExactIn,
      inputMint: NATIVE_MINT,
      outputMint: NATIVE_MINT,
      receiver: OWNER,
      escrowed: 5_000_000_000n,
      expiresAt: 0n,
      rentPayer: OWNER,
      flags: 0,
      bounty: 0,
      createFee: 0,
    }),
  );

const agentPaid = (intent: Address) => tagged(getAgentPaidEventEncoder().encode({ intent, agent: AGENT, account: AGENT_ACCOUNT, fee: AGENT_FEE }));

const relayerPaid = (intent: Address) => tagged(getRelayerPaidEventEncoder().encode({ intent, relayer: RELAYER, account: RELAYER_ACCOUNT, fee: RELAYER_FEE }));

const agentWithheld = (intent: Address) =>
  tagged(getFeeWithheldEventEncoder().encode({ intent, payee: AGENT, account: AGENT_ACCOUNT, fee: AGENT_FEE, role: WITHHELD_AGENT }));

async function swapEvent(created: Uint8Array[], fill: Uint8Array[]) {
  const { node, feed } = rig();
  node.add(at(1, created), at(2, [filled(SWAP, OWNER, SOLVER, 5_000_000_000n), ...fill]));
  const body = await feed.read();
  const swap = body.events.find(({ kind }) => kind === "swap");
  if (swap === undefined) {
    throw new Error("the feed shows no swap");
  }
  return swap;
}

describe("a swap on the feed shows every payout the program made for its fill", () => {
  it("shows the agent's fee on a fill of an agent-created intent", async () => {
    const swap = await swapEvent([swapCreated(SWAP)], [agentPaid(SWAP)]);
    expect(swap).toMatchObject({ kind: "swap", amount: "5", payouts: { agent_paid: { wallet: AGENT, account: AGENT_ACCOUNT, amount: "0.01" } } });
    expect(swap.payouts).not.toHaveProperty("relayer_paid");
  });

  it("shows the relayer's fee on a fill of an intent a relayer submitted", async () => {
    const swap = await swapEvent([swapCreated(SWAP), relayerPaid(SWAP)], []);
    expect(swap.payouts).toEqual({ relayer_paid: { wallet: RELAYER, account: RELAYER_ACCOUNT, amount: "0.002" } });
  });

  it("shows an agent fee the program withheld, with its role", async () => {
    const swap = await swapEvent([swapCreated(SWAP)], [agentWithheld(SWAP)]);
    expect(swap.payouts).toEqual({ withheld: [{ role: "agent", wallet: AGENT, account: AGENT_ACCOUNT, amount: "0.01" }] });
  });

  it("shows no payouts on a fill that paid none, and ignores payouts of other intents", async () => {
    const quiet = await swapEvent([swapCreated(SWAP)], [agentPaid(addressOf(5))]);
    expect(quiet).not.toHaveProperty("payouts");
  });
});
