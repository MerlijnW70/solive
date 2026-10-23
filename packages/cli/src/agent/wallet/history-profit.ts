import type { Address } from "@solana/kit";
import { type EngineEvent, findVaultPda, formatAmount, NATIVE_MINT, tokenName } from "@intent-engine/core";
import { mintOf, releaseShareOf, type Transport } from "@intent-engine/client";
import { tool } from "../names.js";
import { AgentRefusal } from "../problems.js";
import { account, InvalidInput, list, object, text } from "../schema.js";
import { SIGNATURE_FEE } from "../budget.js";
import { tokenAccountRent } from "./costs.js";
import { eventsIn } from "./history-work.js";
import { createdMint, heldMint, releaseLookup, releasedMint } from "./releases.js";

export const PAID_FROM_MAX = 8;
const ESCROW_EVENTS = 50;
const SOL_DECIMALS = 9;

export const PAID_FROM_INPUT = `up to ${PAID_FROM_MAX} escrows this wallet made to pay others for the job escrow names; with it, profit shows what the job paid this wallet against what these escrows cost`;

export const PROFIT_NEEDS_JOB = "give escrow, the job this wallet was paid for, with paid_from";

export const jobUnpaid = (job: Address) =>
  `no release of ${job} that paid this wallet is in its history yet; call ${tool("wallet_history")} again once it is released`;

export const notMadeHere = "not an escrow this wallet made, or its creation is not in its recent history";

export const otherToken = "pays in another token than the job escrow names";

export const profitItem = object({
  escrow: account("the job this wallet was paid for"),
  token: text("SOL, TEST or the mint the job paid in, and the paid_from escrows too"),
  received: text("whole tokens the job's release paid this wallet"),
  paid_out: text("whole tokens the releases of paid_from paid their workers"),
  fees: text("whole tokens of judge and protocol fees those releases took"),
  fees_sol: text("whole SOL of create fees, crank bounties others collected, and the base network fee of each transaction this wallet paid for on paid_from"),
  rent_sol: text("whole SOL the paid_from escrows' accounts still hold as rent and crank bounty; most comes back when they close"),
  difference: text("received less paid_out and fees, and for SOL also less fees_sol and rent_sol; a leading - is a loss"),
  escrows: list(account(), PAID_FROM_MAX, "the paid_from escrows counted"),
});

type Fields = Record<string, unknown>;

const signed = (raw: bigint, decimals: number): string => (raw < 0n ? `-${formatAmount(-raw, decimals)}` : formatAmount(raw, decimals));

async function received(transport: Transport, wallet: Address, job: Address) {
  const { release, transactions } = await releaseLookup(transport, job);
  if (release === null) {
    throw new AgentRefusal("NotReleased", jobUnpaid(job));
  }
  const event = release.event as EngineEvent;
  const share = await releaseShareOf(transport, { event, transaction: release.tx }, job, wallet);
  if (share === null) {
    throw new AgentRefusal("NotReleased", jobUnpaid(job));
  }
  const payee = event.name === "IntentAttested" ? event.fields.payee : undefined;
  const mint = releasedMint(release.tx, job, payee) ?? createdMint(transactions, job) ?? (await heldMint(transport, job));
  if (mint === undefined) {
    throw new AgentRefusal("NotReleased", jobUnpaid(job));
  }
  return { share, mint };
}

type Spent = { paidOut: bigint; fees: bigint; feesSol: bigint; rentSol: bigint };

async function spentOn(transport: Transport, wallet: Address, intent: Address, mint: Address, at: number): Promise<Spent> {
  const transactions = (await transport.engineTransactions(ESCROW_EVENTS, intent)).filter(({ failed }) => !failed);
  const events = eventsIn(transactions).filter((event) => (event.fields as Fields)["intent"] === intent);
  const created = events.find((event) => event.name === "IntentCreated");
  if (created?.name !== "IntentCreated" || created.fields.owner !== wallet) {
    throw new InvalidInput([{ path: `paid_from.${at}`, message: notMadeHere }]);
  }
  if (created.fields.inputMint !== mint) {
    throw new InvalidInput([{ path: `paid_from.${at}`, message: otherToken }]);
  }
  let paidOut = 0n;
  let fees = 0n;
  let feesSol = BigInt(created.fields.createFee);
  for (const event of events) {
    if (event.name === "IntentAttested" || event.name === "IntentSplit") {
      paidOut += event.fields.net;
      fees += event.fields.fee + event.fields.partnerFee;
    }
    if (event.name === "IntentClosed" && event.fields.bountyTo !== wallet) {
      feesSol += BigInt(event.fields.bounty);
    }
  }
  const touched = new Set(events.map(({ signature }) => signature));
  feesSol += SIGNATURE_FEE * BigInt(transactions.filter(({ signature, feePayer }) => feePayer === wallet && touched.has(signature)).length);
  const [vault] = await findVaultPda({ intent });
  const [held, vaultView] = await transport.getAccounts([intent, vault]);
  const rentSol = (held?.lamports ?? 0n) + (vaultView === null || vaultView === undefined ? 0n : await tokenAccountRent(transport, vaultView.owner));
  return { paidOut, fees, feesSol, rentSol };
}

export async function profitOf(transport: Transport, wallet: Address, job: Address | undefined, paidFrom: readonly Address[]) {
  if (job === undefined) {
    throw new InvalidInput([{ path: "paid_from", message: PROFIT_NEEDS_JOB }]);
  }
  const { share, mint } = await received(transport, wallet, job);
  const escrows = [...new Set(paidFrom)];
  const total: Spent = { paidOut: 0n, fees: 0n, feesSol: 0n, rentSol: 0n };
  for (const [at, intent] of escrows.entries()) {
    const spent = await spentOn(transport, wallet, intent, mint, at);
    total.paidOut += spent.paidOut;
    total.fees += spent.fees;
    total.feesSol += spent.feesSol;
    total.rentSol += spent.rentSol;
  }
  const decimals = (await mintOf(transport, mint)).decimals;
  const sol = mint === NATIVE_MINT ? total.feesSol + total.rentSol : 0n;
  return {
    escrow: job,
    token: tokenName(mint) ?? mint,
    received: formatAmount(share, decimals),
    paid_out: formatAmount(total.paidOut, decimals),
    fees: formatAmount(total.fees, decimals),
    fees_sol: formatAmount(total.feesSol, SOL_DECIMALS),
    rent_sol: formatAmount(total.rentSol, SOL_DECIMALS),
    difference: signed(share - total.paidOut - total.fees - sol, decimals),
    escrows,
  };
}
