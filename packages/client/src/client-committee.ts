import type { Address } from "@solana/kit";
import {
  buildCreateCommittee,
  COMMITTEE_DISCRIMINATOR,
  committeeFloorOf,
  committeeOf,
  type Config,
  countsAsCommittee,
  getCommitteeDecoder,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  type IntentParams,
  Kind,
  needsCommittee,
} from "@intent-engine/core";
import { createdAccount } from "./accounts.js";
import { CommitteeNeeded } from "./client-errors.js";
import type { ClientContext, CommitteeView, CreateCommitteeInput, CreatedCommittee } from "./client-types.js";
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
  const stored = getCommitteeDecoder().decode(view.data);
  const members = stored.members.slice(0, stored.count);
  const terms = { members, threshold: stored.threshold, feeWallet: stored.feeWallet };
  const derived = await committeeOf(terms);
  if (derived.address !== address) {
    throw new Error(`${address} holds a committee whose contents address ${derived.address}`);
  }
  return { ...terms, address, id: derived.id, createdAt: stored.createdAt };
}

export async function escrowCommittee(
  transport: Transport,
  config: Pick<Config, "floorMints" | "floorAmounts">,
  inputMint: Address,
  params: IntentParams,
): Promise<{ committee?: Address }> {
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

export function committeeSends({ transport, send }: ClientContext) {
  const createCommittee = async (input: CreateCommitteeInput): Promise<CreatedCommittee> => {
    const { committee, instruction } = await buildCreateCommittee({
      payer: input.payer,
      members: input.members,
      threshold: input.threshold,
      feeWallet: input.feeWallet,
    });
    if ((await loadCommittee(transport, committee.address)) !== null) {
      return { committee: committee.address, signature: null };
    }
    return { committee: committee.address, signature: await send([instruction], input.payer) };
  };
  return { createCommittee, committee: (address: Address) => loadCommittee(transport, address) };
}
