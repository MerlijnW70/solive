import type { Address } from "@solana/kit";
import {
  CLAIM_BOARD_DISCRIMINATOR,
  CLAIM_LIST_DISCRIMINATOR,
  checkAccountVersion,
  claimListAddress,
  claimBoardAddress,
  CLAIMS_OPEN,
  claimSlot,
  findIntentPda,
  getClaimBoardDecoder,
  getClaimListDecoder,
  getStandbyDecoder,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  IntentCoreError,
  type LineHandover,
  lineLength,
  lineSeqs,
  MAX_LINE_ENTRIES,
  PROFILE_DISCRIMINATOR,
  profileAddress,
  type ProfileView,
  profileView,
  STANDBY_DISCRIMINATOR,
  stakeReceiverOnCancel,
  stakeReceiverOnRelease,
  standbyAddress,
} from "@intent-engine/core";
import { chainTime, CLOCK_SYSVAR, clockTime, createdAccount, createdView, engineAccount } from "./accounts.js";
import { ClaimHeldBy } from "./client-errors.js";
import type { AccountView, Transport } from "./transport.js";

export type ClaimListView = { address: Address; size: number; workers: Address[]; complete: boolean };

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
  line: { head: number; tail: number; waiting: number };
  list: ClaimListView | null;
};

export type LineEntry = { seq: number; entry: Address; worker: Address | null; secs: number | null };

const NONE = "11111111111111111111111111111111" as Address;

export type JobClaim = { takesClaims: boolean; claimedBy: Address | null; claimEnds: bigint | null; waiting: number };

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
  return checkAccountVersion(view.data);
}

function claimListOf(address: Address, view: AccountView | null): ClaimListView {
  const data = engineDataOf(address, view, CLAIM_LIST_DISCRIMINATOR);
  if (data === null) {
    throw new Error(`the claim list ${address} its board records is missing`);
  }
  const stored = getClaimListDecoder().decode(data);
  return { address, size: stored.size, workers: stored.workers.slice(0, stored.count), complete: stored.count === stored.size };
}

const listedIntent = (data: Uint8Array | null): Address | null => {
  const stored = data === null ? null : getClaimBoardDecoder().decode(data);
  return stored === null || stored.listed === 0 ? null : stored.intent;
};

async function withLists(transport: Transport, views: (ClaimsView | null)[], datas: (Uint8Array | null)[]): Promise<(ClaimsView | null)[]> {
  const wanted = datas.flatMap((data, i) => {
    const intent = listedIntent(data);
    return intent === null ? [] : [{ i, intent }];
  });
  if (wanted.length === 0) {
    return views;
  }
  const addresses = await Promise.all(wanted.map(({ intent }) => claimListAddress(intent)));
  const found = await transport.getAccounts(addresses);
  const lists = new Map(wanted.map(({ i }, at) => [i, claimListOf(addresses[at] as Address, createdView(found[at] ?? null))]));
  return views.map((view, i) => (view === null ? null : { ...view, list: lists.get(i) ?? null }));
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
    line: { head: stored.head, tail: stored.tail, waiting: lineLength(stored) },
    list: null,
  };
}

export async function loadClaims(transport: Transport, owner: Address, nonce: bigint): Promise<ClaimsView | null> {
  const [intent] = await findIntentPda({ owner, nonce });
  const board = await claimBoardAddress(intent);
  const data = await engineData(transport, board, CLAIM_BOARD_DISCRIMINATOR);
  const view = data === null ? null : claimsViewOf(board, data, await chainTime(transport));
  return (await withLists(transport, [view], [data]))[0] ?? null;
}

export async function loadClaimsOf(transport: Transport, intents: readonly Address[]): Promise<(ClaimsView | null)[]> {
  if (intents.length === 0) {
    return [];
  }
  const boards = await Promise.all(intents.map(claimBoardAddress));
  const views = await transport.getAccounts([...boards, CLOCK_SYSVAR]);
  const now = clockTime(views[boards.length] ?? null);
  const datas = boards.map((board, i) => engineDataOf(board, createdView(views[i] ?? null), CLAIM_BOARD_DISCRIMINATOR));
  const shown = datas.map((data, i) => (data === null ? null : claimsViewOf(boards[i] as Address, data, now)));
  return withLists(transport, shown, datas);
}

export function jobClaimOf(claims: ClaimsView | null): JobClaim {
  const waiting = claims?.line.waiting ?? 0;
  const takesClaims = claims !== null;
  return claims?.state === "held" ? { takesClaims, claimedBy: claims.worker, claimEnds: claims.until, waiting } : { takesClaims, claimedBy: null, claimEnds: null, waiting };
}

export async function loadLine(transport: Transport, intent: Address, line: { head: number; tail: number }, max = MAX_LINE_ENTRIES): Promise<LineEntry[]> {
  const seqs = lineSeqs(line, max);
  if (seqs.length === 0) {
    return [];
  }
  const entries = await Promise.all(seqs.map((seq) => standbyAddress(intent, seq)));
  const views = await transport.getAccounts(entries);
  return seqs.map((seq, i) => {
    const entry = entries[i] as Address;
    const data = engineDataOf(entry, createdView(views[i] ?? null), STANDBY_DISCRIMINATOR);
    if (data === null) {
      return { seq, entry, worker: null, secs: null };
    }
    const stored = getStandbyDecoder().decode(data);
    return { seq, entry, worker: stored.worker, secs: stored.secs };
  });
}

export async function lineHandover(transport: Transport, intent: Address, line: { head: number; tail: number }): Promise<LineHandover> {
  const entries = await loadLine(transport, intent, line);
  const live = entries.findIndex(({ worker }) => worker !== null);
  if (live < 0) {
    return { entries: entries.map(({ entry }) => entry) };
  }
  const next = entries[live] as LineEntry;
  return { entries: entries.slice(0, live + 1).map(({ entry }) => entry), nextWorker: next.worker as Address };
}

export async function cancelClaims(transport: Transport, intent: Address, claims: number): Promise<{ board: Address; stakeTo: Address | null } | undefined> {
  if (claims !== CLAIMS_OPEN) {
    return undefined;
  }
  const board = await claimBoardAddress(intent);
  const data = await engineData(transport, board, CLAIM_BOARD_DISCRIMINATOR);
  if (data === null) {
    return { board, stakeTo: null };
  }
  return { board, stakeTo: stakeReceiverOnCancel(getClaimBoardDecoder().decode(data), await chainTime(transport)) };
}

export type ReleaseClaims = { accounts: { claims?: Address; stakeTo?: Address }; stake: bigint };

export async function releaseClaims(transport: Transport, intent: Address, claims: number, payees: readonly Address[]): Promise<ReleaseClaims> {
  if (claims !== CLAIMS_OPEN) {
    return { accounts: {}, stake: 0n };
  }
  const board = await claimBoardAddress(intent);
  const view = getClaimBoardDecoder().decode(await engineAccount(transport, board, CLAIM_BOARD_DISCRIMINATOR, "claim board"));
  try {
    const stakeTo = stakeReceiverOnRelease(view, await chainTime(transport), payees);
    return stakeTo === null ? { accounts: { claims: board }, stake: 0n } : { accounts: { claims: board, stakeTo }, stake: view.held };
  } catch (error) {
    if (error instanceof IntentCoreError) {
      throw new ClaimHeldBy(intent, view.worker, view.until);
    }
    throw error;
  }
}

export async function loadProfile(transport: Transport, wallet: Address): Promise<ProfileView | null> {
  const data = await engineData(transport, await profileAddress(wallet), PROFILE_DISCRIMINATOR);
  return data === null ? null : profileView(data);
}
