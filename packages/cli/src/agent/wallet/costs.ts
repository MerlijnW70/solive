import type { Address } from "@solana/kit";
import { findAssociatedTokenAddress, formatAmount, getClaimBoardSize, getIntentSize, getUserStateSize, NATIVE_MINT, TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import { createdAccount, loadConfig, loadUser, mintOf, type Transport } from "@intent-engine/client";
import { TOKEN_NAMES } from "../../tokens.js";
import { rentFor, rentRate, SIGNATURE_FEE, TOKEN_ACCOUNT_RENT_BYTES } from "../budget.js";
import { tool } from "../names.js";
import { SOL_DECIMALS } from "../read.js";

export const TOKEN_ACCOUNT_BYTES = 165;

export const TOTAL = "Total: ";

export const tokenAccountBytes = (tokenProgram: Address): number => (tokenProgram === TOKEN_PROGRAM_ADDRESS ? TOKEN_ACCOUNT_BYTES : TOKEN_ACCOUNT_RENT_BYTES);

export async function tokenAccountRent(transport: Transport, tokenProgram: Address): Promise<bigint> {
  return rentFor(tokenAccountBytes(tokenProgram), await rentRate(transport));
}

export const sol = (lamports: bigint): string => `${formatAmount(lamports, SOL_DECIMALS)} SOL`;

export const networkFee = (prepared: { signers: readonly unknown[]; priority_fee_lamports: bigint }): bigint =>
  SIGNATURE_FEE * BigInt(prepared.signers.length) + prepared.priority_fee_lamports;

type Cost = { what: string; lamports: bigint };

export type EscrowCosts = { sell: Address; decimals: number; fees: Cost[]; rent: Cost[]; setup: Cost[] };

export async function escrowCosts(transport: Transport, input: { owner: Address; sell: Address; buy: Address; claims: boolean }): Promise<EscrowCosts> {
  const [{ config }, rent, sold, bought, user] = await Promise.all([
    loadConfig(transport),
    rentRate(transport),
    mintOf(transport, input.sell),
    mintOf(transport, input.buy),
    loadUser(transport, input.owner),
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
      { what: "its token vault", lamports: rentFor(TOKEN_ACCOUNT_BYTES, rent) },
      ...(input.claims ? [{ what: BOARD_RENT, lamports: rentFor(getClaimBoardSize(), rent) }] : []),
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

export function rentBack(costs: EscrowCosts, each: string): string {
  const board = costs.rent.filter((cost) => cost.what === BOARD_RENT);
  const escrow = costs.rent.filter((cost) => cost.what !== BOARD_RENT);
  return [
    `Rent back${each}: ${sol(sum(escrow))} for the escrow account and its vault returns to this wallet when the escrow closes, at once with ${tool("wallet_cancel")} or by a cranker after its release or expiry`,
    ...(board.length === 0 ? [] : [`${sol(sum(board))} for the claims board does not return until ${tool("wallet_claim")} action settle closes the board once the escrow is released or gone`]),
    ...(costs.setup.length === 0 ? [] : ["the setup rent stays in this wallet's own accounts"]),
  ].join("; ");
}

export function costLines(costs: EscrowCosts, network: bigint, escrowed: bigint, pieces: number): string[] {
  const fees = [...costs.fees, { what: "network fee", lamports: network }];
  const each = pieces > 1 ? " per piece" : "";
  const spent = BigInt(pieces) * (sum(fees) + sum(costs.rent)) + sum(costs.setup);
  const name = TOKEN_NAMES[costs.sell] ?? costs.sell;
  const locked = `${formatAmount(escrowed, costs.decimals)} ${name}`;
  const whole = costs.sell === NATIVE_MINT ? sol(escrowed + spent) : `${locked} and ${sol(spent)}`;
  return [
    `Fees${each}: ${listed(fees)}`,
    ...(pieces > 1 ? [`Rent per piece: ${listed(costs.rent, "for ")}`, ...(costs.setup.length === 0 ? [] : [`Rent once: ${listed(costs.setup, "for ")}`])] : [`Rent: ${listed([...costs.rent, ...costs.setup], "for ")}`]),
    rentBack(costs, each),
    `${TOTAL}this ${pieces > 1 ? "plan" : "send"} takes ${whole} from this wallet: ${locked} escrowed and ${sol(spent)} of fees and rent`,
  ];
}
