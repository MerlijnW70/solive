import type { Address, TransactionPartialSigner } from "@solana/kit";
import { formatAmount, IntentStatus } from "@intent-engine/core";
import {
  buildAdvance,
  buildClaimJob,
  buildCloseProfile,
  buildCreateProfile,
  buildDropClaim,
  buildLeave,
  buildOpenClaims,
  buildSettleClaims,
  buildStandBy,
  buildUpdateProfile,
  claimBoardAddress,
  claimUntil,
  findIntentPda,
  formatTime,
  kindBit,
  type LineHandover,
  PAUSE_FILL,
  profileAddress,
  stakeReceiverOnSettle,
} from "@intent-engine/core/internal";
import { type ClaimsView, type Client, isSdkError, type Transport } from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import { escrowsJudgedBy, isDevice, keepsKey, type LineEntry, lineHandover, loadLine } from "@intent-engine/client/internal";
import { previewed } from "./admin-commands.js";
import { finishList, listAccount, listRefusal, listShown, openListed } from "./claim-lists.js";
import type { Command } from "./command-types.js";
import { FlowRefused } from "./flows.js";
import { claimNotInvited, sealedInvites } from "./invites.js";
import { transactionSigner } from "./ledger-keys.js";
import { encryptionKeyLines } from "./sealed-commands.js";
import type { Runtime } from "./runtime.js";

type ClaimCommand = Extract<
  Command,
  {
    name:
      | "claims-show"
      | "claims-open"
      | "claims-take"
      | "claims-drop"
      | "claims-settle"
      | "claims-standby"
      | "claims-leave"
      | "claims-advance"
      | "profile-show"
      | "profile-set"
      | "profile-close";
  }
>;

const NONE = "11111111111111111111111111111111" as Address;

const sol = (lamports: bigint) => `${formatAmount(lamports, 9)} SOL`;

export const noClaims = (intent: Address) => `escrow ${intent} takes no claims; its owner opens them with claims open`;

export const heldBy = (intent: Address, worker: Address, secondsLeft: bigint) =>
  `${worker} holds the claim on escrow ${intent} for ${secondsLeft} more seconds; nothing was sent`;

export const coolingDown = (intent: Address, worker: Address, until: bigint) =>
  `${worker} dropped its claim on escrow ${intent} and may claim it again from ${until}, when that claim would have ended; nothing was sent`;

export const lineWaiting = (intent: Address, waiting: number) =>
  `${waiting} ${waiting === 1 ? "worker stands" : "workers stand"} by for escrow ${intent}, so it is handed over in line order; join the line with claims standby; nothing was sent`;

export const NO_PROFILE = "has published no profile";

const claimsShown = (intent: Address, view: ClaimsView) => ({
  intent,
  board: view.board,
  state: view.state,
  worker: view.worker,
  until: view.until,
  seconds_left: view.secondsLeft,
  stake: view.stake,
  max_secs: view.maxSecs,
  owner: view.owner,
  cooldown: view.cooldown,
  line: view.line,
  claim_list: listShown(view.list),
});

async function claimsOf(client: Client, owner: Address, nonce: bigint) {
  const [intent] = await findIntentPda({ owner, nonce });
  const view = await client.claims({ owner, nonce });
  if (view === null) {
    throw new FlowRefused(noClaims(intent));
  }
  return { intent, view };
}

async function escrowOpen(client: Client, owner: Address, nonce: bigint, now: bigint) {
  const found = await client.intent({ owner, nonce });
  return found !== null && found.intent.status === IntentStatus.Open && now < found.intent.expiresAt ? found.intent.expiresAt : null;
}

async function fillsStopped(client: Client, owner: Address, nonce: bigint, intent: Address) {
  const [config, found] = await Promise.all([client.config(), client.intent({ owner, nonce })]);
  if ((config.paused & PAUSE_FILL) !== 0) {
    throw new FlowRefused(`fills are paused by the guardian or admin, and with them new claims and stand-by joins on escrow ${intent}; try again once the pause is lowered; nothing was sent`);
  }
  if (found !== null && (config.fillDisabledKinds & kindBit(found.intent.kind)) !== 0n) {
    throw new FlowRefused(`the admin stopped fills of the kind of escrow ${intent}, and with them new claims and stand-by joins on it; nothing was sent`);
  }
}

async function claimCommand(command: Extract<ClaimCommand, { name: `claims-${string}` }>, runtime: Runtime, transport: Transport, client: Client): Promise<object> {
  if (command.name === "claims-show") {
    const { intent, view } = await claimsOf(client, command.owner, command.nonce);
    return claimsShown(intent, view);
  }
  const signer = await transactionSigner(runtime, command.keypair);
  if (command.name === "claims-open") {
    const [intent] = await findIntentPda({ owner: signer.address, nonce: command.nonce });
    const board = await claimBoardAddress(intent);
    const existing = await client.claims({ owner: signer.address, nonce: command.nonce });
    if (existing !== null) {
      if (command.workers !== undefined && existing.list !== null && !existing.list.complete) {
        return finishList(command.workers, signer, transport, intent, existing.list, command.yes);
      }
      throw new FlowRefused(`escrow ${intent} already takes claims on board ${board}`);
    }
    const opens = `Opens: claims on escrow ${intent}; a worker holds the job for up to ${command.maxSecs} seconds by staking ${sol(command.stake)}`;
    if (command.workers !== undefined) {
      return openListed({ ...command, workers: command.workers }, signer, transport, intent, board, opens);
    }
    const instruction = await buildOpenClaims({ owner: signer, intent, maxSecs: command.maxSecs, stake: command.stake });
    const summary = [opens, `Pays rent: ${signer.address}, for the claims board ${board}`];
    return previewed(transport, [instruction], signer, { intent, board, summary }, command.yes);
  }
  if (command.name === "claims-leave") {
    return leaveLine(command, signer, transport, client);
  }
  const { intent, view } = await claimsOf(client, command.owner, command.nonce);
  const shown = claimsShown(intent, view);
  if (command.name === "claims-take" || command.name === "claims-standby") {
    const invited = await sealedInvites(transport, runtime.specFetch, intent, { lookup: runtime.lookup, rpcUrl: command.url });
    if (invited !== undefined && !invited.includes(signer.address)) {
      throw new FlowRefused(claimNotInvited(signer.address, intent));
    }
    const unlisted = listRefusal(view.list, signer.address, intent);
    if (unlisted !== undefined) {
      throw new FlowRefused(unlisted);
    }
  }
  switch (command.name) {
    case "claims-take":
      return takeClaim(command, signer, transport, client, intent, view, shown);
    case "claims-drop": {
      if (view.state !== "held" || view.worker !== signer.address) {
        throw new FlowRefused(`${signer.address} holds no claim on escrow ${intent}; nothing was sent`);
      }
      const handover = await dropHandover(client, transport, command.owner, command.nonce, intent, view);
      const summary = [`Drops: this worker's claim on escrow ${intent}`, `Returns: its stake of ${sol(view.stake)} to ${signer.address}`, ...handedTo(handover)];
      return previewed(transport, [await buildDropClaim({ worker: signer, intent, ...handover })], signer, { ...shown, summary }, command.yes);
    }
    case "claims-standby":
      return standBy(command, signer, transport, client, intent, view, shown);
    case "claims-advance":
      return advanceLine(command, signer, transport, client, intent, view, shown);
    case "claims-settle":
      return settleClaims(command, signer, transport, client, intent, view, shown);
  }
}

export async function dropHandover(client: Client, transport: Transport, owner: Address, nonce: bigint, intent: Address, view: ClaimsView): Promise<LineHandover> {
  if (view.line.waiting === 0 || (await escrowOpen(client, owner, nonce, await client.chainTime())) === null) {
    return { entries: [] };
  }
  return lineHandover(transport, intent, view.line);
}

export function handedTo(handover: LineHandover): string[] {
  const skipped = handover.entries.length - (handover.nextWorker === undefined ? 0 : 1);
  return [
    ...(handover.nextWorker === undefined ? [] : [`Hands: the job to ${handover.nextWorker}, first in the line`]),
    ...(skipped > 0 ? [`Skips: ${skipped} line ${skipped === 1 ? "entry" : "entries"} whose worker left`] : []),
  ];
}

async function standBy(
  command: Extract<ClaimCommand, { name: "claims-standby" }>,
  worker: TransactionPartialSigner,
  transport: Transport,
  client: Client,
  intent: Address,
  view: ClaimsView,
  shown: object,
) {
  if (view.state !== "held" && view.line.waiting === 0) {
    throw new FlowRefused(`nobody holds escrow ${intent} and nobody stands by, so claim it with claims take; nothing was sent`);
  }
  if (command.secs > view.maxSecs) {
    throw new FlowRefused(`escrow ${intent} lets a worker hold its claim for at most ${view.maxSecs} seconds; pass a lower --secs`);
  }
  if ((await escrowOpen(client, command.owner, command.nonce, await client.chainTime())) === null) {
    throw new FlowRefused(`escrow ${intent} is no longer open, so nobody can stand by for it`);
  }
  await fillsStopped(client, command.owner, command.nonce, intent);
  const seq = view.line.tail;
  const summary = [
    `Stands by: for escrow ${intent} as entry ${seq}, place ${view.line.waiting + 1} in its line; when the job reaches this worker it holds it for ${command.secs} seconds`,
    `Locks: a stake of ${sol(view.stake)} and the entry's rent, moved onto the claim when the job reaches this worker, or returned when it leaves the line`,
  ];
  const instruction = await buildStandBy({ worker, intent, seq, secs: command.secs, ...listAccount(view.list) });
  return previewed(transport, [instruction], worker, { ...shown, seq, summary }, command.yes);
}

async function advanceLine(
  command: Extract<ClaimCommand, { name: "claims-advance" }>,
  payer: TransactionPartialSigner,
  transport: Transport,
  client: Client,
  intent: Address,
  view: ClaimsView,
  shown: object,
) {
  if (view.line.waiting === 0) {
    throw new FlowRefused(`nobody stands by for escrow ${intent}; nothing was sent`);
  }
  if (view.state === "held" && view.worker !== null) {
    throw new FlowRefused(heldBy(intent, view.worker, view.secondsLeft));
  }
  if ((await escrowOpen(client, command.owner, command.nonce, await client.chainTime())) === null) {
    throw new FlowRefused(`escrow ${intent} is no longer open, so its line is not advanced; each waiter gets its stake back with claims leave`);
  }
  const handover = await lineHandover(transport, intent, view.line);
  const summary = [
    ...(view.state === "lapsed" ? [`Ends: the lapsed claim of ${view.worker}, whose stake of ${sol(view.stake)} goes to the owner ${view.owner}`] : []),
    ...handedTo(handover),
    `Pays the fee: ${payer.address}`,
  ];
  const instruction = await buildAdvance({ intent, owner: view.owner, ...handover });
  return previewed(transport, [instruction], payer, { ...shown, summary }, command.yes);
}

async function leaveLine(command: Extract<ClaimCommand, { name: "claims-leave" }>, caller: TransactionPartialSigner, transport: Transport, client: Client) {
  const [intent] = await findIntentPda({ owner: command.owner, nonce: command.nonce });
  const view = await client.claims({ owner: command.owner, nonce: command.nonce });
  let entries: LineEntry[];
  if (command.seq !== undefined) {
    entries = await loadLine(transport, intent, { head: command.seq, tail: command.seq + 1 });
  } else if (view === null) {
    throw new FlowRefused(`the claims board of escrow ${intent} is closed; pass --seq with the entry to return; nothing was sent`);
  } else {
    entries = (await loadLine(transport, intent, view.line, view.line.waiting)).filter(({ worker }) => worker === caller.address);
  }
  const found = entries.find(({ worker }) => worker !== null);
  if (found === undefined || found.worker === null) {
    const who = command.seq === undefined ? `${caller.address} stands by` : `entry ${command.seq} stands`;
    throw new FlowRefused(`${who} nowhere in the line of escrow ${intent}; nothing was sent`);
  }
  const open = (await escrowOpen(client, command.owner, command.nonce, await client.chainTime())) !== null;
  if (open && found.worker !== caller.address) {
    throw new FlowRefused(`escrow ${intent} is still open, so only ${found.worker} can take entry ${found.seq} out of its line; nothing was sent`);
  }
  const summary = [`Leaves: entry ${found.seq} in the line of escrow ${intent}`, `Returns: the entry's stake and rent to ${found.worker}`];
  const instruction = await buildLeave({ caller, intent, seq: found.seq, worker: found.worker });
  return previewed(transport, [instruction], caller, { intent, seq: found.seq, entry: found.entry, worker: found.worker, summary }, command.yes);
}

async function takeClaim(
  command: Extract<ClaimCommand, { name: "claims-take" }>,
  worker: TransactionPartialSigner,
  transport: Transport,
  client: Client,
  intent: Address,
  view: ClaimsView,
  shown: object,
) {
  if (view.state === "held" && view.worker !== null) {
    throw new FlowRefused(heldBy(intent, view.worker, view.secondsLeft));
  }
  if (view.line.waiting > 0) {
    throw new FlowRefused(lineWaiting(intent, view.line.waiting));
  }
  if (view.cooldown !== null && view.cooldown.worker === worker.address) {
    throw new FlowRefused(coolingDown(intent, worker.address, view.cooldown.until));
  }
  if (command.secs > view.maxSecs) {
    throw new FlowRefused(`escrow ${intent} lets a worker hold its claim for at most ${view.maxSecs} seconds; pass a lower --secs`);
  }
  const now = await client.chainTime();
  const expiresAt = await escrowOpen(client, command.owner, command.nonce, now);
  if (expiresAt === null) {
    throw new FlowRefused(`escrow ${intent} is no longer open, so its job cannot be claimed`);
  }
  await fillsStopped(client, command.owner, command.nonce, intent);
  let until: bigint;
  try {
    until = claimUntil(view.maxSecs, now, command.secs, expiresAt);
  } catch (error) {
    throw isSdkError(error, "intent-core-error") ? new FlowRefused(`a claim of ${command.secs} seconds would outlive escrow ${intent}, which expires at ${expiresAt}`) : error;
  }
  const summary = [
    `Claims: escrow ${intent} until ${formatTime(until)}, ${until - now} seconds from now; until then only ${worker.address} can be paid`,
    `Stakes: ${sol(view.stake)}, returned when a release pays this worker or it drops the claim, and lost to the owner if the claim lapses first`,
    ...(view.state === "lapsed" ? [`Ends: the lapsed claim of ${view.worker}, whose stake goes to the owner ${view.owner}`] : []),
  ];
  const instruction = await buildClaimJob({ worker, intent, owner: view.owner, secs: command.secs, ...listAccount(view.list) });
  return previewed(transport, [instruction], worker, { ...shown, summary }, command.yes);
}

async function settleClaims(
  command: Extract<ClaimCommand, { name: "claims-settle" }>,
  payer: TransactionPartialSigner,
  transport: Transport,
  client: Client,
  intent: Address,
  view: ClaimsView,
  shown: object,
) {
  const now = await client.chainTime();
  const open = (await escrowOpen(client, command.owner, command.nonce, now)) !== null;
  const board = { owner: view.owner, worker: view.worker ?? NONE, until: view.until, held: view.stake };
  let receiver: Address | null;
  try {
    receiver = stakeReceiverOnSettle(board, now, open);
  } catch (error) {
    if (isSdkError(error, "intent-core-error") && view.worker !== null) {
      throw new FlowRefused(`${heldBy(intent, view.worker, view.secondsLeft)}; settle once it lapses or the escrow closes`);
    }
    throw error;
  }
  if (open && receiver === null) {
    throw new FlowRefused(`escrow ${intent} is open and nobody holds its claim, so there is nothing to settle; nothing was sent`);
  }
  const summary = [
    receiver === null ? "Moves: no stake; nobody holds the claim" : `Moves: the stake of ${sol(view.stake)} to ${receiver}`,
    ...(open ? [] : [`Closes: the claims board ${view.board}${view.list === null ? "" : ` and its claim list ${view.list.address}`}, returning ${view.list === null ? "its" : "their"} rent to the owner ${view.owner}`]),
    `Pays the fee: ${payer.address}`,
  ];
  const instruction = await buildSettleClaims({ intent, owner: view.owner, ...(view.worker === null ? {} : { worker: view.worker }), ...listAccount(view.list) });
  return previewed(transport, [instruction], payer, { ...shown, summary }, command.yes);
}

async function profileCommand(command: Extract<ClaimCommand, { name: `profile-${string}` }>, runtime: Runtime, transport: Transport, client: Client): Promise<object> {
  if (command.name === "profile-show") {
    const found = await client.profile(command.wallet);
    if (found === null) {
      throw new FlowRefused(`${command.wallet} ${NO_PROFILE}`);
    }
    return {
      wallet: found.wallet,
      profile: await profileAddress(found.wallet),
      skills: found.skills,
      endpoint: found.endpoint,
      doc_url: found.docUrl,
      doc_sha256: found.docSha256,
      encryption_key: found.encryptionKey,
      updated_at: found.updatedAt,
    };
  }
  const wallet = await transactionSigner(runtime, command.keypair);
  const profile = await profileAddress(wallet.address);
  const existing = await client.profile(wallet.address);
  const dropsKey = (existing?.encryptionKey ?? null) !== null && (command.name === "profile-close" || command.encryptionKey === null);
  const judging = dropsKey && isDevice(wallet) ? await escrowsJudgedBy(transport, wallet.address) : [];
  if (judging.length > 0) {
    throw new FlowRefused(keepsKey(wallet.address, judging));
  }
  if (command.name === "profile-close") {
    if (existing === null) {
      throw new FlowRefused(`${wallet.address} ${NO_PROFILE}; nothing was sent`);
    }
    const summary = [`Closes: the profile of ${wallet.address} and returns its rent to it`];
    return previewed(transport, [await buildCloseProfile({ wallet })], wallet, { wallet: wallet.address, profile, summary }, command.yes);
  }
  const encryptionKey = command.encryptionKey === undefined ? (existing?.encryptionKey ?? null) : command.encryptionKey;
  const input = { wallet, ...command.profile, ...(encryptionKey === null ? {} : { encryptionKey }) };
  const instruction = existing === null ? await buildCreateProfile(input) : await buildUpdateProfile(input);
  const { docUrl, docSha256 } = command.profile;
  const summary = [
    `${existing === null ? "Creates" : "Updates"}: the profile of ${wallet.address} at ${profile}`,
    `Skills: ${command.profile.skills.join(", ")}`,
    `Endpoint: ${command.profile.endpoint}`,
    docUrl === undefined ? "Document: none" : `Document: ${docUrl} with sha256 ${docSha256}`,
    ...encryptionKeyLines(encryptionKey, command.encryptionKey === null),
    ...(existing === null ? [`Pays rent: ${wallet.address}`] : []),
  ];
  const shown = { wallet: wallet.address, profile, action: existing === null ? "create" : "update", summary };
  return previewed(transport, [instruction], wallet, shown, command.yes);
}

export async function claimsCommand(command: ClaimCommand, runtime: Runtime, transport: Transport): Promise<object> {
  const client = createClient({ url: command.url, transport });
  switch (command.name) {
    case "profile-show":
    case "profile-set":
    case "profile-close":
      return profileCommand(command, runtime, transport, client);
    default:
      return claimCommand(command, runtime, transport, client);
  }
}
