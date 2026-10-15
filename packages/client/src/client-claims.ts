import type { Address } from "@solana/kit";
import {
  CLAIM_BOARD_DISCRIMINATOR,
  claimBoardAddress,
  CLAIMS_OPEN,
  claimSlot,
  findIntentPda,
  getClaimBoardDecoder,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  PROFILE_DISCRIMINATOR,
  profileAddress,
  type ProfileView,
  profileView,
  stakeReceiverOnCancel,
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
  cooldown: { worker: Address; until: bigint } | null;
};

const NONE = "11111111111111111111111111111111" as Address;

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
    until: slot.state === "free" ? 0n : stored.until,
    secondsLeft: slot.state === "held" ? stored.until - now : 0n,
    stake: stored.stake,
    maxSecs: stored.maxSecs,
    owner: stored.owner,
    cooldown: slot.state === "free" && stored.droppedBy !== NONE && now < stored.until ? { worker: stored.droppedBy, until: stored.until } : null,
  };
}

export async function cancelClaims(transport: Transport, intent: Address, claims: number): Promise<{ board: Address; stakeTo: Address | null } | undefined> {
  if (claims !== CLAIMS_OPEN) {
    return undefined;
  }
  const board = await claimBoardAddress(intent);
  const data = await engineData(transport, board, CLAIM_BOARD_DISCRIMINATOR);
  if (data === null) {
    throw new Error(`${intent} takes claims but its claims board ${board} is missing`);
  }
  return { board, stakeTo: stakeReceiverOnCancel(getClaimBoardDecoder().decode(data), await chainTime(transport)) };
}

export async function loadProfile(transport: Transport, wallet: Address): Promise<ProfileView | null> {
  const data = await engineData(transport, await profileAddress(wallet), PROFILE_DISCRIMINATOR);
  return data === null ? null : profileView(data);
}
