import type { Address } from "@solana/kit";
import {
  type AnnouncementList,
  ConfirmMismatch,
  deviceJudgeReady,
  type FirstOpening,
  firstOpeningIn,
  FirstOpeningRefused,
  NoKeyAtCreation,
  ProfileHistoryIncomplete,
} from "@intent-engine/client";
import { refusalNext, type SkippedLine, skippedLines } from "../../announcement-views.js";
import type { AgentContext } from "../actions.js";
import { tool } from "../names.js";
import { AgentRefusal } from "../problems.js";
import { account, amount, choice, list, object, optional } from "../schema.js";
import { walletOpeners } from "./guard.js";

export const MAX_SKIPPED = 64;

export const skippedOutput = optional(
  list(
    object({
      announcement: account(),
      seq: amount(),
      worker: account(),
      reason: choice(["does-not-open"] as const, "sealed to a key this wallet holds, yet it opens with none, so it can never open for anyone"),
    }),
    MAX_SKIPPED,
    "earlier announcements passed over, because they can never open",
  ),
);

export const GIVE_KEY_SETTING = "start the server with mcp --encryption-keypair naming the encryption key file of that key";

export const WAIT_FOR_LIST = "the RPC node does not list every announcement yet; call again in a few seconds";

export const NO_BOOK = `no worker has announced work to this escrow yet, or it is closed; a worker announces with ${tool("wallet_deliver")} first`;

export const KEY_ON_DEVICE =
  "an earlier announcement is sealed to the key derived from this wallet, which a Ledger cannot use; judge with the wallet's key file, or have the judge publish an encryption key before escrows are made";

const CODES = { incomplete: "AnnouncementsIncomplete", "key-not-given": "KeyNotGiven", "claim-held": "ClaimHeld", "nothing-opens": "NotAnnounced" } as const;

export function refused(refusal: FirstOpeningRefused, device: boolean, judge: Address): AgentRefusal {
  if (device && refusal.reason === "key-not-given" && refusal.sealedTo.some(({ kind, wallet }) => kind === "wallet" && wallet === judge)) {
    return new AgentRefusal("KeyNotGiven", `${refusal.message}; ${KEY_ON_DEVICE}`);
  }
  return new AgentRefusal(CODES[refusal.reason], `${refusal.message}; ${refusalNext(refusal, { key: GIVE_KEY_SETTING, wait: WAIT_FOR_LIST, closed: NO_BOOK })}`);
}

const refusedHistory = (error: unknown): never => {
  if (error instanceof ProfileHistoryIncomplete) {
    throw new AgentRefusal("HistoryTooLong", error.message);
  }
  if (error instanceof NoKeyAtCreation) {
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
  if (opening instanceof FirstOpeningRefused) {
    throw refused(opening, device, judge);
  }
  return { list, opening, skipped: skippedLines(opening) };
}

export const skippedField = (skipped: readonly SkippedLine[]): { skipped?: SkippedLine[] } => (skipped.length === 0 ? {} : { skipped: [...skipped] });

export function confirmRefused(error: unknown): never {
  if (error instanceof ConfirmMismatch) {
    throw new AgentRefusal("ConfirmMismatch", error.message);
  }
  throw error;
}
