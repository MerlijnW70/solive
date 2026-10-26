import { type Address, address, type Instruction, type TransactionPartialSigner } from "@solana/kit";
import { MAINNET_GENESIS_HASH } from "@intent-engine/client/internal";
import type { Chain } from "./chain.js";
import {
  configTransactionExecute,
  decodeAccount,
  multisigCreateV2,
  multisigPda,
  programConfigCodec,
  programConfigPda,
  proposalApprove,
  proposalCancelV2,
  proposalPda,
  proposalReject,
  SQUADS_PROGRAM,
  transactionPda,
  type VaultTransaction,
  vaultTransactionExecute,
  type Multisig,
  type Proposal,
} from "./layout.js";
import {
  owned,
  permissionNames,
  type Plan,
  readMultisig,
  readProposal,
  readVaultTransaction,
  Refusal,
  requireMember,
  statusOf,
  VAULT_INDEX,
  vaultOf,
} from "./multisig-state.js";
import { type BufferCheck, named, type Review, review, reviewView, SQUADS_APP, SYSVAR_CLOCK } from "./review.js";

export { SQUADS_PROGRAM, type Multisig, type Proposal, type VaultTransaction };
export {
  type BufferCheck,
  bufferHash,
  decodeMessage,
  type Decoded,
  CLOSE_TAG,
  DEFAULT_ADDRESS,
  ENGINE_CLOSE,
  ENGINE_PROGRAM,
  type InstructionView,
  instructionView,
  LOADER,
  messageInstructions,
  programDataOf,
  type Review,
  review,
  SET_AUTHORITY_TAG,
  SYSVAR_CLOCK,
  SYSVAR_RENT,
  UPGRADE_TAG,
} from "./review.js";
export {
  permissionNames,
  type Plan,
  readMultisig,
  readProposal,
  readVaultTransaction,
  Refusal,
  statusOf,
  VAULT_INDEX,
  vaultOf,
} from "./multisig-state.js";
export {
  printedSummary,
  proposeAuthority,
  proposeInstructions,
  proposeTimeLock,
  proposeUpgrade,
  setAuthorityInstruction,
  upgradeInstruction,
  wrapPrinted,
} from "./proposals.js";
export const COMPUTE_BUDGET = address("ComputeBudget111111111111111111111111111111");
export const EXECUTE_UNITS = 1_400_000;
const SET_COMPUTE_UNIT_LIMIT = 2;

export async function createMultisig(
  chain: Chain,
  input: { creator: Address; createKey: TransactionPartialSigner; members: Address[]; threshold: number; timeLock: number },
): Promise<Plan> {
  const keys = input.members;
  if (new Set(keys).size !== keys.length) {
    throw new Refusal("--members names the same key twice");
  }
  if (!Number.isInteger(input.threshold) || input.threshold < 1 || input.threshold > keys.length) {
    throw new Refusal(`--threshold must be between 1 and the ${keys.length} members`);
  }
  const multisig = await multisigPda(input.createKey.address);
  if ((await chain.account(multisig)) !== null) {
    throw new Refusal(`create key ${input.createKey.address} already made multisig ${multisig}; pass another --create-key`);
  }
  const programConfig = await programConfigPda();
  const info = await chain.account(programConfig);
  const config = owned(info, SQUADS_PROGRAM) ? decodeAccount("ProgramConfig", programConfigCodec, info.data) : null;
  if (config === null) {
    throw new Refusal(`the Squads v4 program config ${programConfig} is missing on this cluster`);
  }
  const vault = await vaultOf(multisig);
  return {
    summary: [
      `Creates a ${input.threshold}-of-${keys.length} Squads v4 multisig ${multisig} with no config authority`,
      `Members, each allowed to initiate, vote and execute: ${keys.join(", ")}`,
      input.timeLock === 0 ? "No time lock: an approved proposal executes at once" : `Time lock: an approved proposal waits ${input.timeLock} seconds`,
      `Vault ${VAULT_INDEX}: ${vault}`,
    ],
    instructions: [
      multisigCreateV2({
        programConfig,
        treasury: config.treasury,
        multisig,
        createKey: input.createKey.address,
        creator: input.creator,
        threshold: input.threshold,
        members: keys,
        timeLock: input.timeLock,
      }),
    ],
    signers: [input.createKey],
    details: {
      multisig,
      vault,
      create_key: input.createKey.address,
      members: keys,
      threshold: input.threshold,
      time_lock: input.timeLock,
    },
  };
}

async function activeProposal(chain: Chain, at: Address, index: bigint): Promise<Proposal> {
  const proposal = await readProposal(chain, at, index);
  if (proposal === null) {
    throw new Refusal(`multisig ${at} has no proposal ${index}`);
  }
  return proposal;
}

const INSPECT = `inspect it in the Squads app at ${SQUADS_APP} and do not approve it blindly`;

export type Allowed = { allowConfig?: boolean; allowEngineClose?: boolean; allowUndecodedVaultSigner?: boolean };

async function requireReviewed(chain: Chain, seen: Review, index: bigint, allowed: Allowed): Promise<void> {
  const shown = { proposal: reviewView(seen) };
  if (seen.kind === "config") {
    if (allowed.allowConfig !== true) {
      throw new Refusal(
        `proposal ${index} is a config transaction that changes the multisig itself; read the changes in the summary, ${INSPECT}, and pass --allow-config only if every change is expected`,
        shown,
      );
    }
    return;
  }
  if (seen.kind !== "vault" || seen.problems.length > 0) {
    throw new Refusal(`refusing to sign proposal ${index}: ${[...seen.problems, ...seen.relayed].join("; ")}; ${INSPECT}`, shown);
  }
  if (seen.relayed.length > 0 && allowed.allowUndecodedVaultSigner !== true) {
    throw new Refusal(
      `refusing to sign proposal ${index}: ${seen.relayed.join("; ")}; ${INSPECT}, and pass --allow-undecoded-vault-signer only if you trust every such program with everything the vault holds and controls`,
      shown,
    );
  }
  if (seen.engineClose !== null && allowed.allowEngineClose !== true && (await chain.genesisHash()) === MAINNET_GENESIS_HASH) {
    throw new Refusal(
      `refusing to sign proposal ${index} on mainnet-beta: ${seen.engineClose}; ${INSPECT}, and pass --allow-engine-close only if the engine is meant to end for good`,
      shown,
    );
  }
}

const reviewed = async (chain: Chain, at: Address, index: bigint, multisig: Multisig, allowed: Allowed): Promise<Review> => {
  const seen = await review(chain, at, index, multisig);
  await requireReviewed(chain, seen, index, allowed);
  return seen;
};

const warned = (seen: Review): string[] => [...(seen.engineClose === null ? [] : [seen.engineClose]), ...seen.relayed].map((text) => `Warning: ${text}`);

const singleHash = (buffers: BufferCheck[]) => (buffers.length === 1 && buffers[0] !== undefined ? { buffer_hash: buffers[0].hash } : {});

export async function approve(chain: Chain, input: { multisig: Address; member: Address; index: bigint } & Allowed): Promise<Plan> {
  const multisig = await readMultisig(chain, input.multisig);
  requireMember(multisig, input.multisig, input.member, "vote", "approve");
  const proposal = await activeProposal(chain, input.multisig, input.index);
  if (proposal.status.__kind !== "Active") {
    throw new Refusal(`proposal ${input.index} is ${statusOf(proposal)}, so it takes no more approvals`);
  }
  if (proposal.approved.includes(input.member)) {
    throw new Refusal(`${input.member} already approved proposal ${input.index}`);
  }
  const seen = await reviewed(chain, input.multisig, input.index, multisig, input);
  const after = proposal.approved.length + 1;
  return {
    summary: [
      ...warned(seen),
      `Approves proposal ${input.index} on multisig ${input.multisig} as ${input.member}`,
      after >= multisig.threshold ? `This is approval ${after} of ${multisig.threshold}; the proposal can then execute` : `This is approval ${after} of ${multisig.threshold}`,
      ...seen.summary,
    ],
    instructions: [proposalApprove({ multisig: input.multisig, proposal: await proposalPda(input.multisig, input.index), member: input.member })],
    signers: [],
    details: {
      multisig: input.multisig,
      index: input.index.toString(),
      approvals: after,
      threshold: multisig.threshold,
      ...singleHash(seen.buffers),
      proposal: reviewView(seen),
    },
  };
}

export async function reject(chain: Chain, input: { multisig: Address; member: Address; index: bigint }): Promise<Plan> {
  const multisig = await readMultisig(chain, input.multisig);
  requireMember(multisig, input.multisig, input.member, "vote", "reject");
  const proposal = await activeProposal(chain, input.multisig, input.index);
  const seen = await review(chain, input.multisig, input.index, multisig);
  const target = { multisig: input.multisig, proposal: await proposalPda(input.multisig, input.index), member: input.member };
  const details = { multisig: input.multisig, index: input.index.toString(), proposal: reviewView(seen) };
  const voters = multisig.members.filter((m) => permissionNames(m.permissions.mask).includes("vote")).length;
  if (proposal.status.__kind === "Active") {
    if (proposal.rejected.includes(input.member)) {
      throw new Refusal(`${input.member} already rejected proposal ${input.index}`);
    }
    const after = proposal.rejected.length + 1;
    const cutoff = voters - multisig.threshold + 1;
    return {
      summary: [
        `Rejects proposal ${input.index} on multisig ${input.multisig} as ${input.member}`,
        after >= cutoff ? `This is rejection ${after} of ${cutoff}; the proposal is then rejected and can never execute` : `This is rejection ${after} of ${cutoff}`,
        ...seen.summary,
      ],
      instructions: [proposalReject(target)],
      signers: [],
      details: { ...details, rejections: after, cutoff },
    };
  }
  if (proposal.status.__kind === "Approved") {
    if (proposal.cancelled.includes(input.member)) {
      throw new Refusal(`${input.member} already cancelled proposal ${input.index}`);
    }
    const after = proposal.cancelled.length + 1;
    return {
      summary: [
        `Cancels approved proposal ${input.index} on multisig ${input.multisig} as ${input.member}, before it executes`,
        after >= multisig.threshold
          ? `This is cancellation ${after} of ${multisig.threshold}; the proposal is then cancelled and can never execute`
          : `This is cancellation ${after} of ${multisig.threshold}`,
        ...seen.summary,
      ],
      instructions: [proposalCancelV2(target)],
      signers: [],
      details: { ...details, cancellations: after, threshold: multisig.threshold },
    };
  }
  throw new Refusal(`proposal ${input.index} is ${statusOf(proposal)}, so there is nothing to reject`);
}

async function clockSeconds(chain: Chain): Promise<bigint> {
  const clock = await chain.account(SYSVAR_CLOCK);
  if (clock === null) {
    throw new Error("the cluster returned no clock");
  }
  return new DataView(clock.data.buffer, clock.data.byteOffset, clock.data.byteLength).getBigInt64(32, true);
}

export function computeUnitLimit(units: number): Instruction {
  const data = new Uint8Array(5);
  data[0] = SET_COMPUTE_UNIT_LIMIT;
  new DataView(data.buffer).setUint32(1, units, true);
  return { programAddress: COMPUTE_BUDGET, data };
}

export async function executeInstruction(chain: Chain, input: { multisig: Address; member: Address; index: bigint }): Promise<Instruction> {
  const transaction = await transactionPda(input.multisig, input.index);
  const stored = await readVaultTransaction(chain, input.multisig, input.index);
  if (stored === null) {
    throw new Refusal(`proposal ${input.index} has no vault transaction to execute`);
  }
  return vaultTransactionExecute({
    multisig: input.multisig,
    proposal: await proposalPda(input.multisig, input.index),
    transaction,
    member: input.member,
    stored,
  });
}

function requireBuffers(seen: Review, index: bigint, vault: Address, expected: readonly string[]): void {
  const shown = { proposal: reviewView(seen) };
  if (seen.buffers.length === 0) {
    if (expected.length > 0) {
      throw new Refusal(`proposal ${index} upgrades nothing, so --expect-buffer-hash does not apply`, shown);
    }
    return;
  }
  if (expected.length === 0) {
    throw new Refusal(
      seen.buffers.some((check) => check.sets !== "idl")
        ? `proposal ${index} upgrades a program; pass --expect-buffer-hash with the buffer hash approve printed, so the code that runs is the code that was approved`
        : `proposal ${index} sets the IDL from a buffer; pass --expect-buffer-hash with the buffer hash approve printed, which equals the sha256 idl.sh printed for the local IDL file, so the IDL that is set is the IDL that was approved`,
      shown,
    );
  }
  for (const check of seen.buffers) {
    if (check.authority !== vault) {
      throw new Refusal(`buffer ${check.buffer} is controlled by ${named(check.authority)}, not the vault ${vault}`, shown);
    }
    if (check.hash === null || !expected.includes(check.hash)) {
      throw new Refusal(
        `buffer ${check.buffer} hashes to ${check.hash ?? "nothing"}, not the approved ${expected.join(", ")}; ${check.sets === "idl" ? "the IDL it sets" : "its code"} changed since approval, so do not execute it`,
        shown,
      );
    }
  }
}

export async function execute(
  chain: Chain,
  input: { multisig: Address; member: Address; index: bigint; expectBufferHashes?: readonly string[] } & Allowed,
): Promise<Plan> {
  const multisig = await readMultisig(chain, input.multisig);
  requireMember(multisig, input.multisig, input.member, "execute", "execute");
  const proposal = await activeProposal(chain, input.multisig, input.index);
  const status = proposal.status;
  if (status.__kind === "Active" || status.__kind === "Draft") {
    const missing = multisig.threshold - proposal.approved.length;
    throw new Refusal(`proposal ${input.index} has ${proposal.approved.length} of ${multisig.threshold} approvals; it needs ${missing} more before it can execute`);
  }
  if (status.__kind !== "Approved") {
    throw new Refusal(`proposal ${input.index} is ${statusOf(proposal)}, so it cannot execute`);
  }
  const ready = status.timestamp + BigInt(multisig.timeLock);
  const now = await clockSeconds(chain);
  if (now < ready) {
    throw new Refusal(`proposal ${input.index} is time locked for ${ready - now} more seconds, until ${new Date(Number(ready) * 1000).toISOString()}`);
  }
  const seen = await reviewed(chain, input.multisig, input.index, multisig, input);
  const proposalAt = await proposalPda(input.multisig, input.index);
  const details = { multisig: input.multisig, index: input.index.toString(), proposal: reviewView(seen) };
  const summary = [...warned(seen), `Executes proposal ${input.index} on multisig ${input.multisig}`, ...seen.summary];
  if (seen.kind === "config") {
    if (seen.actions.some((a) => a.__kind === "AddSpendingLimit" || a.__kind === "RemoveSpendingLimit")) {
      throw new Refusal(`proposal ${input.index} changes spending limits, which this tool does not execute; ${INSPECT}`, { proposal: reviewView(seen) });
    }
    const transaction = await transactionPda(input.multisig, input.index);
    return {
      summary,
      instructions: [configTransactionExecute({ multisig: input.multisig, proposal: proposalAt, transaction, member: input.member })],
      signers: [],
      details,
    };
  }
  const vault = await vaultOf(input.multisig);
  const expected = (input.expectBufferHashes ?? []).map((h) => h.toLowerCase());
  requireBuffers(seen, input.index, vault, expected);
  const instruction = await executeInstruction(chain, input);
  return {
    summary,
    instructions: [computeUnitLimit(EXECUTE_UNITS), instruction],
    signers: [],
    details: { ...details, ...singleHash(seen.buffers) },
    recheck: async () => requireBuffers(await review(chain, input.multisig, input.index, multisig), input.index, vault, expected),
  };
}

