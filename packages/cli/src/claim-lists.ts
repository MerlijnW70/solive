import { isSdkError } from "@intent-engine/client";
import type { Address, Instruction, TransactionPartialSigner } from "@solana/kit";
import { buildClaimsWithList, buildExtendClaimants, checkListed, claimantChunks, claimListAddress } from "@intent-engine/core";
import type { ClaimListView, Transport } from "@intent-engine/client";
import { previewed } from "./admin-commands.js";
import { FlowRefused } from "./flows.js";

export const notListed = (worker: Address, intent: Address): string =>
  `${worker} is not on the claim list of escrow ${intent}, so the program refuses its claim; nothing was sent`;

export const listIncomplete = (intent: Address, list: ClaimListView): string =>
  `the claim list of escrow ${intent} holds ${list.workers.length} of its ${list.size} workers, so it takes no claim until its owner adds the rest; nothing was sent`;

export const listDiffers = (intent: Address, list: ClaimListView): string =>
  `escrow ${intent} already takes claims, and its unfinished claim list starts with ${list.workers.join(", ")} of ${list.size} wallets; pass --workers with those ${list.size} wallets in the same order to finish it; nothing was sent`;

export const limitsLine = (workers: readonly Address[]): string =>
  `Limits: claims to ${workers.length === 1 ? "the 1 listed wallet" : `the ${workers.length} listed wallets`} ${workers.join(", ")}; the program refuses any other`;

export function listRefusal(list: ClaimListView | null, worker: Address, intent: Address): string | undefined {
  if (list === null) {
    return undefined;
  }
  try {
    checkListed(list, worker);
    return undefined;
  } catch (error) {
    if (!isSdkError(error, "intent-core-error")) {
      throw error;
    }
    return error.engineError === "NotListed" ? notListed(worker, intent) : listIncomplete(intent, list);
  }
}

export const listShown = (list: ClaimListView | null) =>
  list === null ? null : { address: list.address, size: list.size, workers: list.workers, complete: list.complete };

export const listAccount = (list: ClaimListView | null): { claimList?: Address } => (list === null ? {} : { claimList: list.address });

const partsLine = (sends: number) => (sends > 1 ? [`Sends: ${sends} transactions, the list in parts; the escrow takes no claim until the last lands`] : []);

async function inParts(transport: Transport, sends: Instruction[][], signer: TransactionPartialSigner, shown: object, yes: boolean): Promise<object> {
  const [first = [], ...rest] = sends;
  if (!yes) {
    return previewed(transport, first, signer, shown, false);
  }
  const signatures = [await transport.send(first, signer)];
  for (const instructions of rest) {
    signatures.push(await transport.send(instructions, signer));
  }
  return { ...shown, sent: true, signature: signatures[0], signatures };
}

export async function openListed(
  claims: { maxSecs: number; stake: bigint; workers: readonly Address[]; yes: boolean },
  signer: TransactionPartialSigner,
  transport: Transport,
  intent: Address,
  board: Address,
  opens: string,
): Promise<object> {
  const claimList = await claimListAddress(intent);
  const sends = await buildClaimsWithList({ owner: signer, intent, ...claims });
  const summary = [opens, limitsLine(claims.workers), ...partsLine(sends.length), `Pays rent: ${signer.address}, for the claims board ${board} and the claim list ${claimList}`];
  return inParts(transport, sends, signer, { intent, board, claim_list: claimList, summary }, claims.yes);
}

export async function finishList(workers: readonly Address[], signer: TransactionPartialSigner, transport: Transport, intent: Address, list: ClaimListView, yes: boolean): Promise<object> {
  const listed = workers.slice(0, list.workers.length);
  if (workers.length !== list.size || listed.some((worker, i) => worker !== list.workers[i])) {
    throw new FlowRefused(listDiffers(intent, list));
  }
  const rest = workers.slice(list.workers.length);
  const sends = await Promise.all(claimantChunks(rest).map(async (part) => [await buildExtendClaimants({ owner: signer, intent, workers: part })]));
  const summary = [`Finishes: the claim list ${list.address} of escrow ${intent}, adding ${rest.length} of its ${list.size} wallets`, limitsLine(workers), ...partsLine(sends.length)];
  return inParts(transport, sends, signer, { intent, claim_list: list.address, summary }, yes);
}
