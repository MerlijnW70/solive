import type { Address } from "@solana/kit";
import { findAssociatedTokenAddress, formatAmount, NATIVE_MINT, TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import { getClaimBoardSize, getClaimListSize, getIntentSize, getUserStateSize } from "@intent-engine/core/internal";
import { type Transport } from "@intent-engine/client";
import { createdAccount, loadConfig, loadUser, MissingAccount, mintOf } from "@intent-engine/client/internal";
import { TOKEN_NAMES } from "../../tokens.js";
import { rentFor, rentRate, SIGNATURE_FEE, TOKEN_ACCOUNT_BYTES, TOKEN_ACCOUNT_RENT_BYTES, vaultBytes } from "../budget.js";
import { tool } from "../names.js";
import { SOL_DECIMALS } from "../read.js";

export const TOTAL = "Total: ";

export const tokenAccountBytes = (tokenProgram: Address): number => (tokenProgram === TOKEN_PROGRAM_ADDRESS ? TOKEN_ACCOUNT_BYTES : TOKEN_ACCOUNT_RENT_BYTES);

export async function tokenAccountRent(transport: Transport, tokenProgram: Address): Promise<bigint> {
  return rentFor(tokenAccountBytes(tokenProgram), await rentRate(transport));
}

export async function vaultRent(transport: Transport, mint: Address): Promise<bigint> {
  const [view, rent] = await Promise.all([transport.getAccount(mint), rentRate(transport)]);
  if (view === null) {
    throw new MissingAccount("mint", mint);
  }
  return rentFor(vaultBytes(view), rent);
}

export const sol = (lamports: bigint): string => `${formatAmount(lamports, SOL_DECIMALS)} SOL`;

export const networkFee = (prepared: { signers: readonly unknown[]; priority_fee_lamports: bigint }): bigint =>
  SIGNATURE_FEE * BigInt(prepared.signers.length) + prepared.priority_fee_lamports;

type Cost = { what: string; lamports: bigint };

export type EscrowCosts = { sell: Address; decimals: number; fees: Cost[]; rent: Cost[]; setup: Cost[] };

export async function escrowCosts(transport: Transport, input: { owner: Address; sell: Address; buy: Address; claims: boolean; listed?: boolean }): Promise<EscrowCosts> {
  const [{ config }, rent, sold, bought, user, vault] = await Promise.all([
    loadConfig(transport),
    rentRate(transport),
    mintOf(transport, input.sell),
    mintOf(transport, input.buy),
    loadUser(transport, input.owner),
    vaultRent(transport, input.sell),
  ]);
  const [receiver, wrapped] = await Promise.all([
    findAssociatedTokenAddress({ owner: input.owner, mint: input.buy, tokenProgram: bought.tokenProgram }),
    findAssociatedTokenAddress({ owner: input.owner, mint: input.sell, tokenProgram: sold.tokenProgram }),
  ]);
  const wraps = input.sell === NATIVE_MINT && sold.tokenProgram === TOKEN_PROGRAM_ADDRESS;
  const [receiverMissing, wrappedMissing] = await Promise.all([
    createdAccount(transport, receiver).then((view) => view === null),
    wraps ? createdAccount(transport, wrapped).then((view) => view === null) : Promise.resolve(false),
  ]);
  return {
    sell: input.sell,
    decimals: sold.decimals,
    fees: [
      { what: "create fee to the treasury", lamports: BigInt(config.createFee) },
      { what: "crank bounty the escrow holds for whoever closes it", lamports: BigInt(config.crankBounty) },
    ],
    rent: [
      { what: "the escrow account", lamports: rentFor(getIntentSize(), rent) },
      { what: "its token vault", lamports: vault },
      ...(input.claims ? [{ what: BOARD_RENT, lamports: rentFor(getClaimBoardSize(), rent) }] : []),
      ...(input.listed === true ? [{ what: LIST_RENT, lamports: rentFor(getClaimListSize(), rent) }] : []),
    ],
    setup: [
      ...(user === null ? [{ what: "your engine registration", lamports: rentFor(getUserStateSize(), rent) }] : []),
      ...(receiverMissing ? [{ what: `your token account for ${input.buy}`, lamports: rentFor(tokenAccountBytes(bought.tokenProgram), rent) }] : []),
      ...(wrappedMissing ? [{ what: "your wrapped SOL account", lamports: rentFor(TOKEN_ACCOUNT_BYTES, rent) }] : []),
    ],
  };
}

const listed = (costs: readonly Cost[], joint = ""): string => costs.map((cost) => `${sol(cost.lamports)} ${joint}${cost.what}`).join(", ");

const sum = (costs: readonly Cost[]): bigint => costs.reduce((total, cost) => total + cost.lamports, 0n);

export const BOARD_RENT = "the claims board";

export const LIST_RENT = "the claim list";

const onBoard = (cost: Cost): boolean => cost.what === BOARD_RENT || cost.what === LIST_RENT;

export function rentBack(costs: EscrowCosts, each: string): string {
  const board = costs.rent.filter(onBoard);
  const escrow = costs.rent.filter((cost) => !onBoard(cost));
  const held = board.some((cost) => cost.what === LIST_RENT) ? "the claims board and its claim list" : "the claims board";
  return [
    `Rent back${each}: ${sol(sum(escrow))} for the escrow account and its vault returns to this wallet when the escrow closes, at once with ${tool("wallet_cancel")} or by a cranker after its release or expiry`,
    ...(board.length === 0 ? [] : [`${sol(sum(board))} for ${held} does not return until ${tool("wallet_claim")} action settle closes the board once the escrow is released or gone`]),
    ...(costs.setup.length === 0 ? [] : ["the setup rent stays in this wallet's own accounts"]),
  ].join("; ");
}

export const networkFees = (sends: number): string => (sends > 1 ? `network fees of its ${sends} transactions` : "network fee");

export type NetworkFee = { lamports: bigint; sends: number };

export const networkLine = (network: readonly NetworkFee[]): string =>
  `Network fees: ${sol(network.reduce((total, fee) => total + fee.lamports, 0n))} in all for the ${network.reduce((total, fee) => total + fee.sends, 0)} transactions of this plan, ${network.map((fee, i) => `piece ${i + 1} ${sol(fee.lamports)}`).join(", ")}`;

export function costLines(costs: EscrowCosts, network: bigint, escrowed: bigint, pieces: number, sends = 1): string[] {
  return pieceCostLines(costs, Array.from({ length: pieces }, () => ({ lamports: network, sends })), escrowed);
}

export function pieceCostLines(costs: EscrowCosts, network: readonly NetworkFee[], escrowed: bigint): string[] {
  const pieces = network.length;
  const [head = { lamports: 0n, sends: 1 }] = network;
  const even = network.every((fee) => fee.lamports === head.lamports && fee.sends === head.sends);
  const fees = [...costs.fees, ...(even ? [{ what: networkFees(head.sends), lamports: head.lamports }] : [])];
  const each = pieces > 1 ? " per piece" : "";
  const spent = BigInt(pieces) * (sum(costs.fees) + sum(costs.rent)) + network.reduce((total, fee) => total + fee.lamports, 0n) + sum(costs.setup);
  const name = TOKEN_NAMES[costs.sell] ?? costs.sell;
  const locked = `${formatAmount(escrowed, costs.decimals)} ${name}`;
  const whole = costs.sell === NATIVE_MINT ? sol(escrowed + spent) : `${locked} and ${sol(spent)}`;
  return [
    `Fees${each}: ${listed(fees)}`,
    ...(even ? [] : [networkLine(network)]),
    ...(pieces > 1 ? [`Rent per piece: ${listed(costs.rent, "for ")}`, ...(costs.setup.length === 0 ? [] : [`Rent once: ${listed(costs.setup, "for ")}`])] : [`Rent: ${listed([...costs.rent, ...costs.setup], "for ")}`]),
    rentBack(costs, each),
    `${TOTAL}this ${pieces > 1 ? "plan" : "send"} takes ${whole} from this wallet: ${locked} escrowed and ${sol(spent)} of fees and rent`,
  ];
}
