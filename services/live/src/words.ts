import type { Address } from "@solana/kit";
import { formatAmount, tokenName } from "@intent-engine/core";
import type { Activity } from "./activity.js";

export const shortAddress = (address: string): string => (address.length <= 8 ? address : `${address.slice(0, 4)}…${address.slice(-4)}`);

export const tokenOf = (mint: string): string => tokenName(mint as Address) ?? mint;

export function amountText(raw: bigint, decimals: number): string {
  return formatAmount(raw, decimals);
}

const paid = (amount: string | null, token: string | null): string => (amount === null || token === null ? "" : ` ${amount} ${token === "SOL" || token === "TEST" ? token : "tokens"}`);

export function detailOf(activity: Activity, amount: string | null, token: string | null, specName: string | null): string {
  const who = shortAddress(activity.who);
  switch (activity.kind) {
    case "escrow":
      return `${who} locked${paid(amount, token)} in escrow for ${specName === null ? "a custom job" : `the ${specName} demo job`}.`;
    case "claim":
      return amount === null || amount === "0" ? `${who} claimed the job.` : `${who} claimed the job with a stake of${paid(amount, token)}.`;
    case "delivery":
      return `${who} delivered work to judge ${shortAddress(activity.attestor ?? "")}.`;
    case "release": {
      const judge = activity.signers === undefined ? `Judge ${who}` : `A committee of ${activity.signers}`;
      return `${judge} approved the work and paid ${shortAddress(activity.payee ?? "")}${paid(amount, token)}.`;
    }
    case "refund":
      return activity.refund === "expired" ? `The job expired and${paid(amount, token) || " its escrow"} went back to ${who}.` : `${who} cancelled and got${paid(amount, token) || " the escrow"} back.`;
    case "swap":
      return `${who} filled a swap of${paid(amount, token) || " tokens"}.`;
  }
}
