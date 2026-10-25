import type { Address } from "@solana/kit";
import { type Config, type IntentParams, Kind, NotAnEngineAccount } from "@intent-engine/core";
import {
  buildCreateCommittee,
  COMMITTEE_DISCRIMINATOR,
  committeeFloorOf,
  committeeOf,
  countsAsCommittee,
  decodeCommitteeAccount,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  needsCommittee,
} from "@intent-engine/core/internal";
import { createdAccount } from "./accounts.js";
import { CommitteeNeeded } from "./client-errors.js";
import type { ClientContext, CommitteeView, CreateCommitteeInput } from "./client-types.js";
import { type Plan, planOf } from "./plan.js";
import type { Transport } from "./transport.js";

export async function loadCommittee(transport: Transport, address: Address): Promise<CommitteeView | null> {
  const view = await createdAccount(transport, address);
  if (
    view === null ||
    view.owner !== INTENT_ENGINE_PROGRAM_ADDRESS ||
    !COMMITTEE_DISCRIMINATOR.every((b, i) => view.data[i] === b)
  ) {
    return null;
  }
  const stored = decodeCommitteeAccount(view.data);
  const members = stored.members.slice(0, stored.count);
  const terms = { members, threshold: stored.threshold, feeWallet: stored.feeWallet };
  const derived = await committeeOf(terms);
  if (derived.address !== address) {
    throw new NotAnEngineAccount(address, `${address} holds a committee whose contents address ${derived.address}`);
  }
  return { ...terms, address, id: derived.id, createdAt: stored.createdAt };
}

export type EscrowCommittee = { committee?: Address };

export async function escrowCommittee(
  transport: Transport,
  config: Pick<Config, "floorMints" | "floorAmounts">,
  inputMint: Address,
  params: IntentParams,
): Promise<EscrowCommittee> {
  if (params.kind !== Kind.AttestedResult) {
    return {};
  }
  const found = await loadCommittee(transport, params.attestor);
  const floor = committeeFloorOf(config, inputMint);
  if (needsCommittee(floor, params.amountIn) && !countsAsCommittee(found)) {
    throw new CommitteeNeeded(params.attestor, params.amountIn, floor);
  }
  return found === null ? {} : { committee: found.address };
}

export type CommitteeCreatePlan = Plan & { committee: Address };

export function committeePlans({ transport }: ClientContext) {
  const createCommittee = async (input: CreateCommitteeInput): Promise<CommitteeCreatePlan> => {
    const { committee, instruction } = await buildCreateCommittee({
      payer: input.payer,
      members: input.members,
      threshold: input.threshold,
      feeWallet: input.feeWallet,
    });
    const exists = (await loadCommittee(transport, committee.address)) !== null;
    return { ...planOf({ payer: input.payer.address, instructions: exists ? [] : [instruction] }), committee: committee.address };
  };
  return { createCommittee, committee: (address: Address) => loadCommittee(transport, address) };
}
