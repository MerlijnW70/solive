import type { Address } from "@solana/kit";
import { type AnnouncementList, ConfirmMismatch, type FirstOpening, FirstOpeningRefused, isSdkError } from "@intent-engine/client";
import { deviceJudgeReady, firstOpeningIn } from "@intent-engine/client/internal";
import { refusalNext, SKIP_REASONS, type SkippedLine, skippedLines } from "../../announcement-views.js";
import type { AgentContext } from "../actions.js";
import { tool } from "../names.js";
import { AgentRefusal } from "../problems.js";
import { account, amount, choice, list, object, optional, text } from "../schema.js";
import { walletOpeners } from "./guard.js";

export const MAX_SKIPPED = 64;

export const skippedOutput = optional(
  list(
    object({
      announcement: account(),
      seq: amount(),
      worker: account(),
      reason: choice(
        Object.keys(SKIP_REASONS) as (keyof typeof SKIP_REASONS)[],
        Object.entries(SKIP_REASONS)
          .map(([reason, why]) => `${reason}: ${why}`)
          .join("; "),
      ),
      why: text("the reason in plain words"),
    }),
    MAX_SKIPPED,
    "earlier announcements passed over, because they are not deliveries this wallet can pay",
  ),
);

export const GIVE_KEY_SETTING = "start the server with mcp --encryption-keypair naming the encryption key file of that key";

export const WAIT_FOR_LIST = "the RPC node does not list every announcement yet; call again in a few seconds";

export const NO_BOOK = `no worker has announced work to this escrow yet; a worker announces with ${tool("wallet_deliver")} first`;

export const KEY_ON_DEVICE =
  "an earlier announcement is sealed to the key derived from this wallet, which a Ledger cannot use; judge with the wallet's key file, or have the judge publish an encryption key before escrows are made";

const CODES = { incomplete: "AnnouncementsIncomplete", "key-not-given": "KeyNotGiven", "claim-held": "ClaimHeld", "nothing-opens": "NotAnnounced" } as const;

export function refused(refusal: FirstOpeningRefused, device: boolean, judge: Address, announced: boolean): AgentRefusal {
  if (device && refusal.reason === "key-not-given" && refusal.sealedTo.some(({ kind, wallet }) => kind === "wallet" && wallet === judge)) {
    return new AgentRefusal("KeyNotGiven", `${refusal.message}; ${KEY_ON_DEVICE}`);
  }
  return new AgentRefusal(CODES[refusal.reason], `${refusal.message}; ${refusalNext(refusal, { key: GIVE_KEY_SETTING, wait: WAIT_FOR_LIST, nobody: NO_BOOK }, announced)}`);
}

const refusedHistory = (error: unknown): never => {
  if (isSdkError(error, "profile-history-incomplete")) {
    throw new AgentRefusal("HistoryTooLong", error.message);
  }
  if (isSdkError(error, "no-key-at-creation")) {
    throw new AgentRefusal("KeyNotGiven", error.message);
  }
  throw error;
};

export type Opened = { list: AnnouncementList; opening: FirstOpening; skipped: SkippedLine[] };

export async function firstOpeningFor(ctx: AgentContext, judge: Address, intent: Address, sha256: string, device: boolean): Promise<Opened> {
  if (device) {
    await deviceJudgeReady(ctx.transport, judge, intent).catch(refusedHistory);
  }
  const { list, opening } = await firstOpeningIn(ctx.transport, { intent, sha256, keypair: await walletOpeners(ctx) });
  if (isSdkError(opening, "first-opening-refused")) {
    throw refused(opening, device, judge, list.announcements.length > 0);
  }
  return { list, opening, skipped: skippedLines(opening) };
}

export const skippedField = (skipped: readonly SkippedLine[]): { skipped?: SkippedLine[] } => (skipped.length === 0 ? {} : { skipped: [...skipped] });

export function confirmRefused(error: unknown): never {
  if (isSdkError(error, "confirm-mismatch")) {
    throw new AgentRefusal("ConfirmMismatch", error.message);
  }
  throw error;
}
