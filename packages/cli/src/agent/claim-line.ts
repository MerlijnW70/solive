import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import { formatAmount, IntentStatus } from "@intent-engine/core";
import {
  buildAdvance,
  buildLeave,
  buildSettleClaims,
  buildStandBy,
  claimBoardAddress,
  claimListAddress,
  getClaimBoardSize,
  getClaimListSize,
  getStandbySize,
  stakeReceiverOnSettle,
} from "@intent-engine/core/internal";
import { type ClaimsView, type Client, isSdkError, type Transport } from "@intent-engine/client";
import { type LineEntry, lineHandover, loadLine } from "@intent-engine/client/internal";
import { handedTo } from "../claim-commands.js";
import { listAccount } from "../claim-lists.js";
import { rentFor, rentRate, SIGNATURE_FEE } from "./budget.js";
import { tool } from "./names.js";
import { AgentRefusal } from "./problems.js";

export type EscrowState = "open" | "released" | "gone";

export type LineStep = { instruction: Instruction; summary: string[]; key: string; done: string };

type Escrow = { owner: Address; nonce: bigint; intent: Address };

const NONE = "11111111111111111111111111111111" as Address;

const sol = (lamports: bigint) => `${formatAmount(lamports, 9)} SOL`;

const feeLine = (payer: Address) => `Costs: ${sol(SIGNATURE_FEE)} network fee, paid by this wallet ${payer}`;

export const settleCall = (owner: Address, nonce: bigint) => `${tool("wallet_claim")} with owner ${owner}, nonce ${nonce} and action settle`;

export const lineWaitingHere = (intent: Address, waiting: number) =>
  `${waiting} ${waiting === 1 ? "worker stands" : "workers stand"} by for escrow ${intent}, so it is handed over in line order; nothing was sent; join the line with ${tool("wallet_claim")} action standby`;

export const closedEscrow = (intent: Address, state: EscrowState) =>
  `escrow ${intent} was ${state === "released" ? "released" : "cancelled, expired or closed"}, so its job can no longer be paid; stop working on it`;

export async function escrowState(client: Client, owner: Address, nonce: bigint): Promise<EscrowState> {
  const [found, now] = await Promise.all([client.intent({ owner, nonce }), client.chainTime()]);
  if (found === null) {
    return "gone";
  }
  if (found.intent.status === IntentStatus.Filled) {
    return "released";
  }
  return found.intent.status === IntentStatus.Open && now < found.intent.expiresAt ? "open" : "gone";
}

export async function boardRent(transport: Transport): Promise<bigint> {
  return rentFor(getClaimBoardSize(), await rentRate(transport));
}

export async function boardLeft(transport: Transport, owner: Address, nonce: bigint, intent: Address): Promise<string | undefined> {
  const board = await claimBoardAddress(intent);
  if ((await transport.getAccount(board)) === null) {
    return undefined;
  }
  const list = await claimListAddress(intent);
  if ((await transport.getAccount(list)) === null) {
    return `the claims board ${board} stays open afterwards, holding ${sol(await boardRent(transport))} of rent that ${owner} paid; ${settleCall(owner, nonce)} closes it and returns that rent to ${owner}`;
  }
  const rent = (await boardRent(transport)) + rentFor(getClaimListSize(), await rentRate(transport));
  return `the claims board ${board} and its claim list ${list} stay open afterwards, holding ${sol(rent)} of rent that ${owner} paid; ${settleCall(owner, nonce)} closes them and returns that rent to ${owner}`;
}

export const leavesBoard = (left: string | undefined): string[] => (left === undefined ? [] : [`Leaves: ${left}`]);

export const thenSettle = (done: string, left: string | undefined): string => (left === undefined ? done : `${done}; ${left}`);

export async function settleStep(client: Client, transport: Transport, escrow: Escrow, view: ClaimsView, payer: Address): Promise<LineStep> {
  const [state, now] = await Promise.all([escrowState(client, escrow.owner, escrow.nonce), client.chainTime()]);
  const open = state === "open";
  const board = { owner: view.owner, worker: view.worker ?? NONE, until: view.until, held: view.stake };
  let receiver: Address | null;
  try {
    receiver = stakeReceiverOnSettle(board, now, open);
  } catch (error) {
    if (isSdkError(error, "intent-core-error") && view.worker !== null) {
      throw new AgentRefusal("ClaimHeld", `${view.worker} holds the claim on escrow ${escrow.intent} for ${view.secondsLeft} more seconds, so there is nothing to settle; nothing was sent`);
    }
    throw error;
  }
  if (open && receiver === null) {
    throw new AgentRefusal("InvalidTransition", `escrow ${escrow.intent} is open and nobody holds its claim, so there is nothing to settle; nothing was sent`);
  }
  const rent = (await boardRent(transport)) + (view.list === null ? 0n : rentFor(getClaimListSize(), await rentRate(transport)));
  const closed = view.list === null ? `the claims board ${view.board}` : `the claims board ${view.board} and its claim list ${view.list.address}`;
  const summary = [
    receiver === null ? "Moves: no stake; nobody holds the claim" : `Moves: the claim stake of ${sol(view.stake)} to ${receiver}`,
    ...(open ? [] : [`Closes: ${closed}, returning ${view.list === null ? "its " : ""}${sol(rent)} of rent to the owner ${view.owner}`]),
    feeLine(payer),
  ];
  const instruction = await buildSettleClaims({ intent: escrow.intent, owner: view.owner, ...(view.worker === null ? {} : { worker: view.worker }), ...listAccount(view.list) });
  const done = open ? `settled; the lapsed claim's stake went to ${receiver}` : `settled; the claims board is closed and its rent returned to ${view.owner}`;
  return { instruction, summary, key: `settle:${open}:${receiver}:${view.stake}`, done };
}

export async function standbyStep(client: Client, transport: Transport, escrow: Escrow, view: ClaimsView, worker: TransactionSigner, secs: number): Promise<LineStep> {
  if (view.state !== "held" && view.line.waiting === 0) {
    throw new AgentRefusal("JobNotHeld", `nobody holds escrow ${escrow.intent} and nobody stands by; nothing was sent; claim it with ${tool("wallet_claim")} action take`);
  }
  if (view.worker === worker.address && view.state === "held") {
    throw new AgentRefusal("HolderStandsBy", `this wallet ${worker.address} already holds the claim on escrow ${escrow.intent}, and the holder cannot stand by for its own job; nothing was sent`);
  }
  if (secs > view.maxSecs) {
    throw new AgentRefusal("ClaimTerms", `escrow ${escrow.intent} lets a worker hold its claim for at most ${view.maxSecs} seconds; give a lower secs`);
  }
  if ((await escrowState(client, escrow.owner, escrow.nonce)) !== "open") {
    throw new AgentRefusal("InvalidTransition", `escrow ${escrow.intent} is no longer open, so nobody can stand by for it`);
  }
  const seq = view.line.tail;
  const rent = rentFor(getStandbySize(), await rentRate(transport));
  const summary = [
    `Stands by: for escrow ${escrow.intent} as entry ${seq}, place ${view.line.waiting + 1} in its line; when the job reaches this wallet ${worker.address} it holds the claim for ${secs} seconds`,
    `Locks: a stake of ${sol(view.stake)} and ${sol(rent)} of the entry's rent from this wallet; the stake moves onto the claim when the job reaches it, the rent returns then, and both return when it leaves the line`,
    feeLine(worker.address),
  ];
  const instruction = await buildStandBy({ worker, intent: escrow.intent, seq, secs, ...listAccount(view.list) });
  const done = `you stand by for ${escrow.intent} as entry ${seq}; ${tool("get_claims")} shows this wallet as worker once the job reaches it`;
  return { instruction, summary, key: `standby:${secs}:${seq}:${view.stake}`, done };
}

export async function leaveStep(client: Client, transport: Transport, escrow: Escrow, view: ClaimsView | null, caller: TransactionSigner, seq: number | undefined): Promise<LineStep> {
  let entries: LineEntry[];
  if (seq !== undefined) {
    entries = await loadLine(transport, escrow.intent, { head: seq, tail: seq + 1 });
  } else if (view === null) {
    throw new AgentRefusal("ClaimsMissing", `the claims board of escrow ${escrow.intent} is closed; give seq with the line entry to return; nothing was sent`);
  } else {
    entries = (await loadLine(transport, escrow.intent, view.line, view.line.waiting)).filter(({ worker }) => worker === caller.address);
  }
  const found = entries.find(({ worker }) => worker !== null);
  if (found === undefined || found.worker === null) {
    const who = seq === undefined ? `this wallet ${caller.address} stands by` : `entry ${seq} stands`;
    throw new AgentRefusal("NotFound", `${who} nowhere in the line of escrow ${escrow.intent}; nothing was sent`);
  }
  const open = (await escrowState(client, escrow.owner, escrow.nonce)) === "open";
  if (open && found.worker !== caller.address) {
    throw new AgentRefusal("Unauthorized", `escrow ${escrow.intent} is still open, so only ${found.worker} can take entry ${found.seq} out of its line; nothing was sent`);
  }
  const held = (await transport.getAccount(found.entry))?.lamports ?? 0n;
  const summary = [`Leaves: entry ${found.seq} in the line of escrow ${escrow.intent}`, `Returns: the entry's stake and rent, ${sol(held)} in all, to ${found.worker}`, feeLine(caller.address)];
  const instruction = await buildLeave({ caller, intent: escrow.intent, seq: found.seq, worker: found.worker });
  return { instruction, summary, key: `leave:${found.seq}:${found.worker}`, done: `left the line; entry ${found.seq}'s stake and rent returned to ${found.worker}` };
}

export async function advanceStep(client: Client, transport: Transport, escrow: Escrow, view: ClaimsView, payer: Address): Promise<LineStep> {
  if (view.line.waiting === 0) {
    throw new AgentRefusal("LineEmpty", `nobody stands by for escrow ${escrow.intent}; nothing was sent`);
  }
  if (view.state === "held" && view.worker !== null) {
    throw new AgentRefusal("ClaimHeld", `${view.worker} holds the claim on escrow ${escrow.intent} for ${view.secondsLeft} more seconds, so the line waits; nothing was sent`);
  }
  if ((await escrowState(client, escrow.owner, escrow.nonce)) !== "open") {
    throw new AgentRefusal("InvalidTransition", `escrow ${escrow.intent} is no longer open, so its line is not advanced; each waiter gets its stake back with ${tool("wallet_claim")} action leave`);
  }
  const handover = await lineHandover(transport, escrow.intent, view.line, view.cooldown?.worker);
  const summary = [
    ...(view.state === "lapsed" ? [`Ends: the lapsed claim of ${view.worker}, whose stake of ${sol(view.stake)} goes to the owner ${view.owner}`] : []),
    ...handedTo(handover),
    feeLine(payer),
  ];
  const instruction = await buildAdvance({ intent: escrow.intent, owner: view.owner, ...handover });
  const done = handover.nextWorker === undefined ? "advanced; nobody was left in the line" : `advanced; ${handover.nextWorker} now holds the claim`;
  return { instruction, summary, key: `advance:${view.state}:${handover.nextWorker ?? ""}:${handover.entries.length}`, done };
}
