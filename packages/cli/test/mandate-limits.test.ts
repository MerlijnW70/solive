import { type Address, generateKeyPairSigner } from "@solana/kit";
import { beforeEach, describe, expect, it } from "vitest";
import { findIntentPda, type Mandate, mandateLane } from "@intent-engine/core/internal";
import { type Transport } from "@intent-engine/client";
import { initUserIfMissing, loadUser } from "@intent-engine/client/internal";
import { WARN_SCALED } from "../src/agent/create.js";
import { callOf, claimsOf } from "../src/agent/claims.js";
import { prepareMandate } from "../src/agent/mandate.js";
import { agentNonce, AGENT_NONCE_PROBES, explained } from "../src/agent/mandate-state.js";
import { SimulationFailed } from "../src/agent/problems.js";
import { ata, funded, h, NOW, send, transport, type World, world } from "./harness.js";

type Granted = { summary: string[]; warnings: string[] };

const REGISTERS = "Setup: registers you with the engine (a one-time account you pay rent for)";

const createsFor = (mint: Address) => `Setup: creates your token account for ${mint} (you pay its rent)`;

function scaledMint(address: Address): Uint8Array {
  const account = h.svm.getAccount(address);
  if (!account.exists) {
    throw new Error("mint missing");
  }
  const data = new Uint8Array(178);
  data.set(account.data);
  data[165] = 1;
  data.set([18, 0, 4, 0, 0, 0, 0, 0, 10, 0, 0, 0], 166);
  return data;
}

const scaling = (mint: Address): Transport => ({
  ...transport,
  getAccount: async (address: Address) => {
    const view = await transport.getAccount(address);
    return address === mint && view !== null ? { ...view, data: scaledMint(mint) } : view;
  },
});

describe("the limits a mandate explains and enforces", () => {
  let w: World;
  let agent: Address;

  const grant = async (owner: Address, over: { transport?: Transport } = {}) =>
    (await prepareMandate.run(
      { transport: over.transport ?? transport, relay: undefined, agent: undefined, claims: claimsOf() },
      {
        owner,
        agent,
        input_mint: w.inputMint,
        output_mint: w.outputMint,
        kinds: ["swap"],
        per_intent: 400n,
        total: 600n,
        max_intents: 2,
        max_ttl: 3_600,
        valid_for: 86_400,
        floor: { out: 1n, in: 2n },
      } as never,
      callOf(),
    )) as unknown as Granted;

  beforeEach(async () => {
    w = await world();
    agent = (await generateKeyPairSigner()).address;
  });

  it("explains what is left of the budget and the intent count", () => {
    const mandate = {
      perIntent: 400n,
      agentFee: 10n,
      total: 600n,
      spent: 150n,
      maxIntents: 5,
      intents: 2,
      maxTtl: 3_600n,
      floorOut: 1n,
      floorIn: 2n,
    } as unknown as Mandate;
    const failed = new SimulationFailed({ code: "MandateExhausted", retryable: false, hint: "the mandate is spent" });
    let thrown: unknown;
    try {
      explained(mandate)(failed);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SimulationFailed);
    expect((thrown as SimulationFailed).problem.hint).toBe(
      "the mandate is spent; this mandate allows at most 400 raw input units per intent including the agent fee of 10, 450 more raw input units in total, 3 more intents, each expiring within 3600 seconds, and at least 1 raw output units for every 2 raw input units it draws",
    );
  });

  it("probes exactly the agent nonce probe count and no further", async () => {
    expect(AGENT_NONCE_PROBES).toBe(64n);
    const owner = w.owner.address;
    const lane = mandateLane(1n) ?? 0n;
    const [beyond] = await findIntentPda({ owner, nonce: lane | 69n });
    const onlyBeyond: Transport = {
      ...transport,
      getAccount: async (address: Address) => (address === beyond ? null : { owner: address, data: new Uint8Array(), lamports: 0n }),
    };
    await expect(agentNonce(onlyBeyond, owner, 1n, 5, { claims: claimsOf(), call: callOf(), now: NOW })).rejects.toMatchObject({
      problem: { code: "NoFreeNonce" },
    });
  });

  it("names only the setup steps the owner still needs", async () => {
    const fresh = await funded();
    await ata(w.authority, fresh.address, w.inputMint, 1_000n);
    const first = await grant(fresh.address);
    expect(first.summary).toContain(REGISTERS);
    expect(first.summary).toContain(createsFor(w.outputMint));
    const unregistered = await grant(w.owner.address);
    expect(unregistered.summary).toContain(REGISTERS);
    expect(unregistered.summary).not.toContain(createsFor(w.outputMint));
    await send(w.owner, await initUserIfMissing(await loadUser(transport, w.owner.address), w.owner));
    const ready = await grant(w.owner.address);
    expect(ready.summary).not.toContain(REGISTERS);
    expect(ready.summary.filter((line) => line.startsWith("Setup: creates"))).toEqual([]);
    expect(ready.warnings).toEqual([]);
  });

  it("warns when either token scales its displayed amounts", async () => {
    expect((await grant(w.owner.address, { transport: scaling(w.outputMint) })).warnings).toContain(WARN_SCALED);
    expect((await grant(w.owner.address, { transport: scaling(w.inputMint) })).warnings).toContain(WARN_SCALED);
    expect((await grant(w.owner.address)).warnings).not.toContain(WARN_SCALED);
  });
});
