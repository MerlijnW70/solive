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
import { chainTime, CLOCK_SYSVAR, clockTime, createdAccount, createdView } from "./accounts.js";
import type { AccountView, Transport } from "./transport.js";

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

export type JobClaim = { claimedBy: Address | null; claimEnds: bigint | null };

async function engineData(transport: Transport, address: Address, discriminator: ArrayLike<number>): Promise<Uint8Array | null> {
  return engineDataOf(address, await createdAccount(transport, address), discriminator);
}

function engineDataOf(address: Address, view: AccountView | null, discriminator: ArrayLike<number>): Uint8Array | null {
  if (view === null) {
    return null;
  }
  if (view.owner !== INTENT_ENGINE_PROGRAM_ADDRESS || !Array.from(discriminator).every((b, i) => view.data[i] === b)) {
    throw new Error(`${address} is not the engine account it should be`);
  }
  return view.data;
}

function claimsViewOf(board: Address, data: Uint8Array, now: bigint): ClaimsView {
  const stored = getClaimBoardDecoder().decode(data);
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

export async function loadClaims(transport: Transport, owner: Address, nonce: bigint): Promise<ClaimsView | null> {
  const [intent] = await findIntentPda({ owner, nonce });
  const board = await claimBoardAddress(intent);
  const data = await engineData(transport, board, CLAIM_BOARD_DISCRIMINATOR);
  return data === null ? null : claimsViewOf(board, data, await chainTime(transport));
}

export async function loadClaimsOf(transport: Transport, intents: readonly Address[]): Promise<(ClaimsView | null)[]> {
  if (intents.length === 0) {
    return [];
  }
  const boards = await Promise.all(intents.map(claimBoardAddress));
  const views = await transport.getAccounts([...boards, CLOCK_SYSVAR]);
  const now = clockTime(views[boards.length] ?? null);
  return boards.map((board, i) => {
    const data = engineDataOf(board, createdView(views[i] ?? null), CLAIM_BOARD_DISCRIMINATOR);
    return data === null ? null : claimsViewOf(board, data, now);
  });
}

export function jobClaimOf(claims: ClaimsView | null): JobClaim {
  return claims?.state === "held" ? { claimedBy: claims.worker, claimEnds: claims.until } : { claimedBy: null, claimEnds: null };
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
