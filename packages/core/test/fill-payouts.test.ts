import { getAddressDecoder } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { decodeEvent, EVENT_IX_TAG } from "../src/events.js";
import { fillPayoutsOf, relayerPaidOf } from "../src/fill-payouts.js";
import { getAgentPaidEventEncoder, getFeeWithheldEventEncoder, getRelayerPaidEventEncoder } from "../generated/client/index.js";

const address = (seed: number) => getAddressDecoder().decode(new Uint8Array(32).fill(seed));
const INTENT = address(1);
const OTHER = address(2);
const AGENT = address(3);
const ACCOUNT = address(4);

const event = (body: ArrayLike<number>) => {
  const decoded = decodeEvent(new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]));
  if (decoded === null) {
    throw new Error("the event did not decode");
  }
  return decoded;
};

const paid = (intent = INTENT) => event(getAgentPaidEventEncoder().encode({ intent, agent: AGENT, account: ACCOUNT, fee: 7n }));

const withheld = (role: number, intent = INTENT) => event(getFeeWithheldEventEncoder().encode({ intent, payee: AGENT, account: ACCOUNT, fee: 9n, role }));

const relayer = (intent = INTENT) => event(getRelayerPaidEventEncoder().encode({ intent, relayer: AGENT, account: ACCOUNT, fee: 3n }));

describe("the payouts a fill's events name", () => {
  it("names the agent's fee and every withheld fee of the intent", () => {
    expect(fillPayoutsOf([paid(), withheld(1), withheld(2)], INTENT)).toEqual({
      agentPaid: { agent: AGENT, account: ACCOUNT, fee: 7n },
      withheld: [
        { role: "partner", payee: AGENT, account: ACCOUNT, amount: 9n },
        { role: "agent", payee: AGENT, account: ACCOUNT, amount: 9n },
      ],
    });
  });

  it("leaves out the creation-time treasury fee, which no fill pays", () => {
    expect(fillPayoutsOf([withheld(3), withheld(5)], INTENT).withheld).toEqual([{ role: "protocol", payee: AGENT, account: ACCOUNT, amount: 9n }]);
  });

  it("names a role it does not know as unknown", () => {
    expect(fillPayoutsOf([withheld(99)], INTENT).withheld).toEqual([{ role: "unknown", payee: AGENT, account: ACCOUNT, amount: 9n }]);
  });

  it("leaves out the payouts of other intents", () => {
    expect(fillPayoutsOf([paid(OTHER), withheld(2, OTHER)], INTENT)).toEqual({ agentPaid: null, withheld: [] });
  });

  it("names the relayer's fee of the intent, and null when there is none", () => {
    expect(relayerPaidOf([relayer()], INTENT)).toEqual({ relayer: AGENT, account: ACCOUNT, fee: 3n });
    expect(relayerPaidOf([relayer(OTHER), paid()], INTENT)).toBeNull();
  });
});
