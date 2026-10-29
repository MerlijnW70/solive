import { type Address, generateKeyPairSigner } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import { IntentCoreError, IntentStatus } from "@intent-engine/core";
import { stakeReceiverOnSettle } from "@intent-engine/core/internal";
import type { ClaimsView, Client, Transport } from "@intent-engine/client";
import { settleStep } from "../src/agent/claim-line.js";
import { AgentRefusal } from "../src/agent/problems.js";

vi.mock("@intent-engine/core/internal", async (original) => {
  const actual = await original<typeof import("@intent-engine/core/internal")>();
  return { ...actual, stakeReceiverOnSettle: vi.fn(actual.stakeReceiverOnSettle) };
});

const client = {
  intent: async () => ({ intent: { status: IntentStatus.Open, expiresAt: 10_000n } }),
  chainTime: async () => 1_000n,
} as unknown as Client;

const transport = {} as unknown as Transport;

async function setup(worker: Address | null) {
  const owner = (await generateKeyPairSigner()).address;
  const intent = (await generateKeyPairSigner()).address;
  const view = { board: owner, state: "held", worker, until: 1_600n, secondsLeft: 600n, stake: 5n, owner, list: null } as unknown as ClaimsView;
  return { escrow: { owner, nonce: 0n, intent }, view, owner };
}

describe("settleStep on an open escrow", () => {
  it("names the holder and the seconds left while a claim still holds", async () => {
    const holder = (await generateKeyPairSigner()).address;
    const { escrow, view, owner } = await setup(holder);
    const refused = await settleStep(client, transport, escrow, view, owner).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AgentRefusal);
    expect(refused).toMatchObject({
      problem: { code: "ClaimHeld" },
      message: `${holder} holds the claim on escrow ${escrow.intent} for 600 more seconds, so there is nothing to settle; nothing was sent`,
    });
  });

  it("passes a failure that is not the program's own through untouched", async () => {
    const holder = (await generateKeyPairSigner()).address;
    const { escrow, view, owner } = await setup(holder);
    const failure = new Error("the read broke");
    vi.mocked(stakeReceiverOnSettle).mockImplementationOnce(() => {
      throw failure;
    });
    await expect(settleStep(client, transport, escrow, view, owner)).rejects.toBe(failure);
  });

  it("passes the program's failure through when no worker holds the claim", async () => {
    const { escrow, view, owner } = await setup(null);
    const failure = new IntentCoreError("ClaimHeld");
    vi.mocked(stakeReceiverOnSettle).mockImplementationOnce(() => {
      throw failure;
    });
    await expect(settleStep(client, transport, escrow, view, owner)).rejects.toBe(failure);
  });
});
