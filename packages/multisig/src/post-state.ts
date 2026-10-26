import { createHash } from "node:crypto";
import {
  type Address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  type Instruction,
  pipe,
  type ReadonlyUint8Array,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Transaction,
} from "@solana/kit";
import type { Account, Chain } from "./chain.js";
import { contentHash, metadataAccount } from "./program-metadata-layout.js";
import { Refusal } from "./multisig-state.js";
import type { SetTarget } from "./proposal-effects.js";
import { loaderState, PROGRAM_DATA_HEADER } from "./review.js";

export type SetHash = SetTarget & { hash: string | null; why?: string };

export type PostState = { err: string | null; logs: string[]; sets: SetHash[] };

export function executableHash(data: ReadonlyUint8Array): string {
  let end = data.length;
  while (end > PROGRAM_DATA_HEADER && data[end - 1] === 0) {
    end -= 1;
  }
  return createHash("sha256").update(data.subarray(PROGRAM_DATA_HEADER, end)).digest("hex");
}

export function setHash(target: SetTarget, after: Account | null): SetHash {
  if (target.sets === "code") {
    const state = loaderState(after);
    return state.kind === "program data"
      ? { ...target, hash: executableHash(state.data) }
      : { ...target, hash: null, why: `${target.account} is not program data after the transaction` };
  }
  const state = metadataAccount(after);
  if (state.kind !== "metadata") {
    return { ...target, hash: null, why: `${target.account} is ${state.kind === "missing" ? "closed" : "not a metadata account"} after the transaction` };
  }
  const content = contentHash(state.data, state.compression, state.encoding);
  return "error" in content
    ? { ...target, hash: null, why: `the data set on ${target.account} does not decode through ${state.compression} and ${state.encoding}: ${content.error}` }
    : { ...target, hash: content.hash };
}

export async function simulateSets(chain: Chain, tx: Transaction, targets: readonly SetTarget[]): Promise<PostState> {
  const simulated = await chain.simulate(tx, targets.map((t) => t.account));
  return {
    err: simulated.err,
    logs: simulated.logs,
    sets: simulated.err === null ? targets.map((t, i) => setHash(t, simulated.accounts[i] ?? null)) : [],
  };
}

export async function simulateAsVault(chain: Chain, payer: Address, instructions: readonly Instruction[], targets: readonly SetTarget[]): Promise<PostState> {
  const latest = await chain.blockhash();
  const tx = compileTransaction(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    ),
  );
  return simulateSets(chain, tx, targets);
}

const what = (set: SetTarget) => (set.sets === "idl" ? `the IDL account ${set.account}` : `the program data ${set.account}`);

export const setText = (set: SetHash): string =>
  set.hash === null
    ? `Simulated, the proposal leaves ${what(set)} with nothing to hash: ${set.why ?? "it does not decode"}`
    : `Simulated, the proposal sets ${what(set)} to ${set.sets === "idl" ? "IDL bytes" : "code"} with sha256 ${set.hash}`;

export const postStateText = (post: PostState): string[] =>
  post.err === null ? post.sets.map(setText) : [`Simulating the proposal's instructions as the vault fails with ${post.err}, so this preview cannot show what it sets`];

export const postStateView = (post: PostState) => ({ simulation: post.err ?? "ok", sets: post.sets });

export function requireSets(post: PostState, expected: readonly string[], shown: object): void {
  if (post.err !== null) {
    throw new Refusal(`simulating the execute transaction fails with ${post.err}, so it cannot show what the transaction sets; nothing was sent`, { ...shown, logs: post.logs.slice(-20) });
  }
  for (const set of post.sets) {
    if (set.hash === null || !expected.includes(set.hash)) {
      throw new Refusal(
        `simulated, the execute transaction sets ${what(set)} to ${set.hash === null ? `nothing that hashes (${set.why ?? "it does not decode"})` : `${set.sets === "idl" ? "IDL bytes" : "code"} with sha256 ${set.hash}`}, not the approved ${expected.join(", ")}; do not execute it`,
        { ...shown, post_state: postStateView(post) },
      );
    }
  }
}
