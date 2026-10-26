import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import {
  findClaimListPda,
  getExtendClaimantsInstructionAsync,
  getListClaimantsInstructionAsync,
  getOpenClaimsListedInstructionAsync,
} from "../generated/client/index.js";
import { events } from "./builder-accounts.js";
import { checkClaimStake, checkClaimTerms } from "./claims.js";
import { IntentCoreError } from "./errors.js";

export const MAX_CLAIMANTS = 32;
export const CLAIM_LIST_CHUNK = 24;

const NONE = "11111111111111111111111111111111" as Address;

export type ClaimantList = { size: number; workers: readonly Address[] };

export function checkClaimants(size: number, workers: readonly Address[]): void {
  const valid =
    Number.isInteger(size) &&
    size >= 1 &&
    size <= MAX_CLAIMANTS &&
    workers.length <= size &&
    new Set(workers).size === workers.length &&
    !workers.includes(NONE);
  if (!valid) {
    throw new IntentCoreError("ClaimListInvalid");
  }
}

export function checkListed(list: ClaimantList, worker: Address): void {
  if (list.workers.length !== list.size) {
    throw new IntentCoreError("ClaimListIncomplete");
  }
  if (!list.workers.includes(worker)) {
    throw new IntentCoreError("NotListed");
  }
}

export async function claimListAddress(intent: Address): Promise<Address> {
  return (await findClaimListPda({ intent }))[0];
}

export function claimantChunks(workers: readonly Address[], chunk = CLAIM_LIST_CHUNK): Address[][] {
  const chunks: Address[][] = [];
  for (let at = 0; at < workers.length; at += chunk) {
    chunks.push(workers.slice(at, at + chunk));
  }
  return chunks.length === 0 ? [[]] : chunks;
}

export async function buildOpenClaimsListed(input: { owner: TransactionSigner; intent: Address; maxSecs: number; stake: bigint; size: number; workers: readonly Address[] }) {
  checkClaimTerms(input.maxSecs, input.stake);
  checkClaimStake(input.stake);
  checkClaimants(input.size, input.workers);
  return getOpenClaimsListedInstructionAsync({ ...input, workers: [...input.workers], ...(await events()) });
}

export async function buildListClaimants(input: { owner: TransactionSigner; intent: Address; size: number; workers: readonly Address[] }) {
  checkClaimants(input.size, input.workers);
  return getListClaimantsInstructionAsync({ ...input, workers: [...input.workers], ...(await events()) });
}

export async function buildExtendClaimants(input: { owner: TransactionSigner; intent: Address; workers: readonly Address[] }) {
  if (input.workers.length === 0 || input.workers.length > MAX_CLAIMANTS) {
    throw new IntentCoreError("ClaimListInvalid");
  }
  return getExtendClaimantsInstructionAsync({ ...input, workers: [...input.workers], ...(await events()) });
}

export async function buildClaimsWithList(input: { owner: TransactionSigner; intent: Address; maxSecs: number; stake: bigint; workers: readonly Address[] }): Promise<Instruction[][]> {
  checkClaimants(input.workers.length, input.workers);
  const [first = [], ...rest] = claimantChunks(input.workers);
  const open = await buildOpenClaimsListed({ ...input, size: input.workers.length, workers: first });
  const extend = await Promise.all(rest.map((workers) => buildExtendClaimants({ owner: input.owner, intent: input.intent, workers })));
  return [[open], ...extend.map((ix) => [ix])];
}
