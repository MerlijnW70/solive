import type { Address, TransactionPartialSigner } from "@solana/kit";
import { type DeliveryOpener, type JudgeOpening, openingMemo } from "@intent-engine/core";
import {
  ConfirmMismatch,
  type Delivery,
  type DeliveryRecord,
  deviceJudgeReady,
  judgeOpenings,
  missingKey,
  NoKeyAtCreation,
  openingInstructions,
  ProfileHistoryIncomplete,
  skippedNote,
  unopenedOf,
} from "@intent-engine/client";
import { execute } from "../../flows.js";
import type { AgentContext } from "../actions.js";
import { tool } from "../names.js";
import { AgentRefusal, problemOf } from "../problems.js";
import { list, optional, text } from "../schema.js";
import { preparedView } from "../shapes.js";
import { prepare } from "../prepare.js";
import { SALTS_SEALED } from "./record.js";
import { feePayerOf } from "./guard.js";

const MAX_OPENINGS = 64;

export const openingOutput = {
  opening_signatures: optional(list(text(), MAX_OPENINGS, "the transactions that published the salts of the announcements earlier than the payee's, in order")),
  opening_memos: optional(list(text(), MAX_OPENINGS, "the opening memos with the salts of the earlier announcements that were not sent")),
  skipped: optional(list(text(), MAX_OPENINGS, "announcements this wallet could not open that are sealed to no key it holds or published, so they were passed over as no delivery to it")),
};

export const openingFailed = (hint: string): string =>
  `released, but the opening of the earlier announcements was not sent (${hint}); readers can still check the release against the payee's salt`;

export type Sealed = { judge: Address; intent: Address; device: boolean; recipients: readonly Address[]; record: DeliveryRecord; first: Delivery | null; openers: readonly DeliveryOpener[] };

export const GIVE_KEY_SETTING = "start the server with mcp --encryption-keypair naming the encryption key file of that key";

const refusedHistory = (error: unknown): never => {
  if (error instanceof ProfileHistoryIncomplete) {
    throw new AgentRefusal("HistoryTooLong", error.message);
  }
  if (error instanceof NoKeyAtCreation) {
    throw new AgentRefusal("SealedSalts", error.message);
  }
  throw error;
};

export async function skippedOf(ctx: AgentContext, { judge, intent, device, recipients, record, first, openers }: Sealed): Promise<{ skipped?: string[] }> {
  if (device) {
    await deviceJudgeReady(ctx.transport, judge, intent).catch(refusedHistory);
  }
  const { missing, skipped } = await unopenedOf(ctx.transport, { judge, recipients, deliveries: record.deliveries, first, openers, confirm: ctx.confirm }).catch((error: unknown) => {
    if (error instanceof ProfileHistoryIncomplete) {
      throw new AgentRefusal("HistoryTooLong", error.message);
    }
    if (error instanceof ConfirmMismatch) {
      throw new AgentRefusal("ConfirmMismatch", error.message);
    }
    throw error;
  });
  if (missing !== null) {
    throw new AgentRefusal("SealedSalts", missing.key.kind === "wallet" ? SALTS_SEALED : missingKey(missing, GIVE_KEY_SETTING));
  }
  return skipped.length === 0 ? {} : { skipped: skipped.map(skippedNote) };
}

export const OPENINGS_NEED_FEE_PAYER =
  "this wallet is a Ledger, which signs no opening transaction, and the earlier announcements' salts must be published after the release; start the server with --fee-payer <key file>, which signs and pays the openings; nothing was signed";

export async function openingPayerOf(ctx: AgentContext): Promise<TransactionPartialSigner> {
  try {
    return await feePayerOf(ctx);
  } catch (error) {
    throw error instanceof AgentRefusal ? new AgentRefusal("NoFeePayer", OPENINGS_NEED_FEE_PAYER) : error;
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
