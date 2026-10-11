import { AccountRole, type Address, getU64Encoder, type Instruction } from "@solana/kit";
import { findAssociatedTokenAddress } from "@intent-engine/core";
import type { Pricer, Quote, QuoteRequest } from "./market.js";

export type IssueRoute = {
  inputMint: Address;
  outputMint: Address;
  outputTokenProgram: Address;
  out: bigint;
  in: bigint;
};

export const MINT_TO = 7;

export function issueInstruction(mint: Address, token: Address, authority: Address, tokenProgram: Address, amount: bigint): Instruction {
  const data = new Uint8Array(9);
  data[0] = MINT_TO;
  data.set(getU64Encoder().encode(amount), 1);
  return {
    programAddress: tokenProgram,
    accounts: [
      { address: mint, role: AccountRole.WRITABLE },
      { address: token, role: AccountRole.WRITABLE },
      { address: authority, role: AccountRole.READONLY_SIGNER },
    ],
    data,
  };
}

export function issuePricer(routes: readonly IssueRoute[]): Pricer {
  for (const route of routes) {
    if (route.out <= 0n || route.in <= 0n) {
      throw new RangeError(`the issue rate for ${route.outputMint} must be positive on both sides`);
    }
  }
  return {
    async quote(request: QuoteRequest): Promise<Quote | null> {
      const route = routes.find((r) => r.inputMint === request.inputMint && r.outputMint === request.outputMint);
      if (route === undefined) {
        return null;
      }
      const amountOut = (request.amountIn * route.out) / route.in;
      const token = await findAssociatedTokenAddress({
        owner: request.taker,
        mint: route.outputMint,
        tokenProgram: route.outputTokenProgram,
      });
      return {
        amountIn: request.amountIn,
        amountOut,
        instructions: [issueInstruction(route.outputMint, token, request.taker, route.outputTokenProgram, amountOut)],
        lookupTables: [],
      };
    },
  };
}
