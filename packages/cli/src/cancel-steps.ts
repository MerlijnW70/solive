import type { Address, Instruction, TransactionSigner } from "@solana/kit";
import { IntentStatus } from "@intent-engine/core";
import { buildCancelIntent, buildCloseIntent } from "@intent-engine/core/internal";
import { type CancelState, cancelNotReadyText, cancelStateAt, cancelClaims, NOTICE_SECS, requestCancelInstructions, tokenAccountIfMissing, tokenProgramOf, type Transport } from "@intent-engine/client/internal";
import { previewed } from "./admin-commands.js";
import type { Command } from "./command-types.js";
import { FlowRefused, ownOrder } from "./flows.js";
import { transactionSigner } from "./ledger-keys.js";
import type { Runtime } from "./runtime.js";

export type CancelStep = { state: CancelState; request: Instruction[] | null };

export async function cancelStep(transport: Transport, owner: TransactionSigner, intent: Address, claims: number, open: boolean): Promise<CancelStep> {
  const state = await cancelStateAt(transport, intent, claims, open);
  return { state, request: state.stage === "request" ? await requestCancelInstructions(transport, owner, intent, state) : null };
}

export const notYet = (state: CancelState): string => `escrow ${state.intent} ${cancelNotReadyText(state)}; cancel it again from ${state.readyAt}; nothing was sent`;

export const requestLines = (state: CancelState): string[] => [
  `Requests a cancel of escrow ${state.intent}: work was announced to it, so the cancel itself can land only ${NOTICE_SECS} seconds after this request lands; until then the judge can still release or reject the work`,
  ...(state.migrates ? [`Migrates: the escrow's delivery book to the current layout first, in the same transaction`] : []),
  "Then: cancel again once the notice ends; it returns the escrow to you then",
];

export const REQUEST_NEXT = "requested; cancel again once the notice ends";

type CancelCommand = Extract<Command, { name: "cancel" }>;

export async function cliCancel(command: CancelCommand, runtime: Runtime, transport: Transport): Promise<object> {
  const owner = await transactionSigner(runtime, command.keypair);
  const { address, intent } = await ownOrder(transport, owner.address, command.nonce);
  const step = await cancelStep(transport, owner, address, intent.claims, intent.status === IntentStatus.Open);
  if (step.request !== null) {
    const shown = { intent: address, stage: step.state.stage, summary: requestLines(step.state) };
    const done = await previewed(transport, step.request, owner, shown, command.yes);
    return command.yes ? { ...done, next: REQUEST_NEXT } : done;
  }
  if (step.state.stage !== "now") {
    throw new FlowRefused(notYet(step.state));
  }
  const ref = { nonce: command.nonce, inputMint: intent.inputMint, tokenProgram: await tokenProgramOf(transport, intent.inputMint), capped: intent.capped };
  const refund = await tokenAccountIfMissing(transport, owner, owner.address, intent.inputMint, ref.tokenProgram);
  const claims = await cancelClaims(transport, address, intent.claims);
  const instructions = [
    ...refund.create,
    await buildCancelIntent({ ...ref, owner, ...(claims === undefined ? {} : { claims }) }),
    ...(command.close ? [await buildCloseIntent({ ...ref, owner: owner.address, cranker: owner, rentPayer: intent.rentPayer })] : []),
  ];
  const lapsed = step.state.review?.lapsed === true;
  const summary = [
    `Cancels intent ${address} (nonce ${command.nonce}); nobody can fill it afterwards`,
    `Returns what is left in escrow to ${refund.address}, the owner's token account for ${intent.inputMint}`,
    ...(refund.create.length > 0 ? [`Creates ${refund.address} first, since it is missing; the owner pays its rent`] : []),
    ...(claims?.stakeTo === undefined || claims.stakeTo === null || lapsed
      ? []
      : [claims.stakeTo === owner.address ? `Takes the stake of the lapsed claim on this job, which the worker forfeited` : `Returns the claim stake to ${claims.stakeTo}, the worker who held this job`]),
    ...(lapsed ? [`Pays: the holder ${claims?.stakeTo ?? ""} its stake and the kill fee, since the judge's review of ${step.state.review?.announcement ?? ""} ended at ${step.state.review?.until ?? 0n} with no release or reject`] : []),
    ...(command.close ? [`Closes the intent in the same transaction and returns its rent and bounty to ${intent.rentPayer}, who paid them; it can no longer be read afterwards`] : []),
  ];
  return previewed(transport, instructions, owner, { intent: address, summary }, command.yes);
}
