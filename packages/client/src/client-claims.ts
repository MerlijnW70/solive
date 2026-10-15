import type { Address } from "@solana/kit";
import {
  CLAIM_BOARD_DISCRIMINATOR,
  claimBoardAddress,
  claimSlot,
  findIntentPda,
  getClaimBoardDecoder,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  PROFILE_DISCRIMINATOR,
  profileAddress,
  type ProfileView,
  profileView,
} from "@intent-engine/core";
import { chainTime, createdAccount } from "./accounts.js";
import type { Transport } from "./transport.js";

export type ClaimsView = {
  board: Address;
  state: "free" | "held" | "lapsed";
  worker: Address | null;
  until: bigint;
  secondsLeft: bigint;
  stake: bigint;
  maxSecs: number;
  owner: Address;
};

async function engineData(transport: Transport, address: Address, discriminator: ArrayLike<number>): Promise<Uint8Array | null> {
  const view = await createdAccount(transport, address);
  if (view === null) {
    return null;
  }
  if (view.owner !== INTENT_ENGINE_PROGRAM_ADDRESS || !Array.from(discriminator).every((b, i) => view.data[i] === b)) {
    throw new Error(`${address} is not the engine account it should be`);
  }
  return view.data;
}

export async function loadClaims(transport: Transport, owner: Address, nonce: bigint): Promise<ClaimsView | null> {
  const [intent] = await findIntentPda({ owner, nonce });
  const board = await claimBoardAddress(intent);
  const data = await engineData(transport, board, CLAIM_BOARD_DISCRIMINATOR);
  if (data === null) {
    return null;
  }
  const stored = getClaimBoardDecoder().decode(data);
  const now = await chainTime(transport);
  const slot = claimSlot(stored, now);
  return {
    board,
    state: slot.state,
    worker: slot.state === "free" ? null : slot.worker,
    until: stored.until,
    secondsLeft: slot.state === "held" ? stored.until - now : 0n,
    stake: stored.stake,
    maxSecs: stored.maxSecs,
    owner: stored.owner,
  };
}

export async function loadProfile(transport: Transport, wallet: Address): Promise<ProfileView | null> {
  const data = await engineData(transport, await profileAddress(wallet), PROFILE_DISCRIMINATOR);
  return data === null ? null : profileView(data);
}
