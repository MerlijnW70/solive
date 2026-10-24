import type { Address, MessagePartialSigner, TransactionPartialSigner } from "@solana/kit";
import { INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core";
import { boundMembers, createClient, isSdkError, type Simulation, simulated, type Transport } from "@intent-engine/client";
import { ENGINE_ERROR_BASE, ENGINE_ERROR_NAMES, failureOf } from "./agent/problems.js";

export type SimulatedRelease = { ok: true; units_consumed: number } | { ok: false; error: string };

export type ReleaseInput = { url: string; owner: Address; nonce: bigint; announcement: Address; result: bigint; sha256: string; salt: string };

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
  try {
    await createClient({ url: release.url, transport: probe }).settleProof({
      judge,
      intent: { owner: release.owner, nonce: release.nonce },
      announcement: release.announcement,
      opening: { sha256: release.sha256, salt: release.salt },
      result: release.result,
    });
  } catch (error) {
    if (error instanceof Simulated) {
      const { err, logs, unitsConsumed } = error.simulation;
      return err === null ? { ok: true, units_consumed: Number(unitsConsumed ?? 0n) } : { ok: false, error: engineErrorOf(logs) ?? err };
    }
    if (isSdkError(error, "intent-core-error")) {
      return { ok: false, error: error.engineError };
    }
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  return { ok: false, error: "the release was sent instead of simulated" };
}
