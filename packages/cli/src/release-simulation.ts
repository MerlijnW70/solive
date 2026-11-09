import type { Address, MessagePartialSigner, TransactionPartialSigner } from "@solana/kit";
import { INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core/internal";
import { isSdkError, type Simulation, type Transport } from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import { boundMembers, simulated } from "@intent-engine/client/internal";
import { ENGINE_ERROR_BASE, ENGINE_ERROR_NAMES, failureOf } from "./agent/problems.js";

export type SimulatedRelease = { ok: true; units_consumed: number; setup_first?: true } | { ok: false; error: string };

export type ReleaseInput = { url: string; owner: Address; nonce: bigint; announcement: Address; result: bigint; sha256: string; salt: string; payer?: TransactionPartialSigner | undefined };

class Simulated extends Error {
  readonly simulation: Simulation;

  constructor(simulation: Simulation) {
    super("the release was simulated, not sent");
    this.name = "Simulated";
    this.simulation = simulation;
  }
}

function engineErrorOf(logs: readonly string[]): string | undefined {
  const failure = failureOf(logs);
  return failure !== null && failure.program === INTENT_ENGINE_PROGRAM_ADDRESS ? ENGINE_ERROR_NAMES[failure.code - ENGINE_ERROR_BASE] : undefined;
}

export async function simulateRelease(transport: Transport, judge: TransactionPartialSigner & MessagePartialSigner, release: ReleaseInput): Promise<SimulatedRelease> {
  const probe: Transport = {
    ...boundMembers(transport),
    send: async (instructions, payer) => {
      throw new Simulated(await simulated(transport, instructions, payer.address));
    },
  };
  let setupFirst = false;
  try {
    const client = createClient({ url: release.url, transport: probe });
    const plan = await client.plan.settleProof({
      judge,
      intent: { owner: release.owner, nonce: release.nonce },
      announcement: release.announcement,
      opening: { sha256: release.sha256, salt: release.salt },
      result: release.result,
      ...(release.payer === undefined ? {} : { payer: release.payer }),
    });
    setupFirst = plan.setup.length > 0;
    await client.send(setupFirst ? plan.setup : plan.instructions, release.payer ?? judge);
  } catch (error) {
    if (error instanceof Simulated) {
      const { err, logs, unitsConsumed } = error.simulation;
      if (err !== null) {
        return { ok: false, error: engineErrorOf(logs) ?? err };
      }
      return { ok: true, units_consumed: Number(unitsConsumed ?? 0n), ...(setupFirst ? { setup_first: true as const } : {}) };
    }
    if (isSdkError(error, "intent-core-error")) {
      return { ok: false, error: error.engineError };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  return { ok: false, error: "the release was sent instead of simulated" };
}
