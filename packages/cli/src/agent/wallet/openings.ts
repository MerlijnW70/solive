import type { Address, TransactionPartialSigner } from "@solana/kit";
import { type JudgeOpening, openingMemo } from "@intent-engine/core";
import { type Delivery, type DeliveryRecord, judgeOpenings, openingInstructions } from "@intent-engine/client";
import { execute } from "../../flows.js";
import type { AgentContext } from "../actions.js";
import { tool } from "../names.js";
import { AgentRefusal, problemOf } from "../problems.js";
import { list, optional, text } from "../schema.js";
import { preparedView } from "../shapes.js";
import { prepare } from "../prepare.js";
import { SALTS_SEALED } from "./record.js";

const MAX_OPENINGS = 64;

export const openingOutput = {
  opening_signatures: optional(list(text(), MAX_OPENINGS, "the transactions that published the salts of the announcements earlier than the payee's, in order")),
  opening_memos: optional(list(text(), MAX_OPENINGS, "the opening memos with the salts of the earlier announcements that were not sent")),
};

export const openingFailed = (hint: string): string =>
  `released, but the opening of the earlier announcements was not sent (${hint}); readers can still check the release against the payee's salt`;

export function sealedRecord(record: DeliveryRecord, keypair: Uint8Array | undefined): void {
  if (keypair === undefined && record.deliveries.length > 0) {
    throw new AgentRefusal("SealedSalts", SALTS_SEALED);
  }
}

export const openingsFor = (record: DeliveryRecord, first: Delivery | null): JudgeOpening[] => (first === null ? [] : judgeOpenings(record.deliveries, first));

export async function sendOpenings(
  ctx: AgentContext,
  signer: TransactionPartialSigner,
  attestor: Address,
  openings: readonly JudgeOpening[],
): Promise<{ opening_signatures?: string[]; opening_memos?: string[]; next?: string }> {
  const signatures: string[] = [];
  for (const [at, opening] of openings.entries()) {
    try {
      const prepared = preparedView(await prepare(ctx.transport, openingInstructions(signer, attestor, opening), signer.address));
      signatures.push(await execute(ctx.transport, prepared, signer));
    } catch (error) {
      return {
        ...(signatures.length === 0 ? {} : { opening_signatures: signatures }),
        opening_memos: openings.slice(at).map(openingMemo),
        next: `${openingFailed(problemOf(error).hint)}; ${tool("wallet_receipt")} shows it`,
      };
    }
  }
  return signatures.length === 0 ? {} : { opening_signatures: signatures };
}
