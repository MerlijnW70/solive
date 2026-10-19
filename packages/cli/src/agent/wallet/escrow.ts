import type { Address } from "@solana/kit";
import { feeBpsFor, formatAmount, Kind, MEMO_URL_RULE, NATIVE_MINT, splitFees } from "@intent-engine/core";
import { chainTime, loadConfig, mintOf } from "@intent-engine/client";
import { TOKEN_NAMES, tokenNamed } from "../../tokens.js";
import { type AgentContext, define } from "../actions.js";
import type { Call } from "../claims.js";
import { escrowJudge, MAX_EXPIRES_IN, MIN_EXPIRES_IN, neverSettles } from "../create.js";
import { tool } from "../names.js";
import { AgentRefusal, problemOf } from "../problems.js";
import { InvalidInput, account, amount, flag, hex32, integer, list, object, optional, text } from "../schema.js";
import { LANDING_SECONDS, access, mintNamed, raw, salesOf, checkSale, checkHour, refusedBeforeSending, PREVIEW_FIRST, oneAtATime, signerOf } from "./guard.js";
import { offerOutput, type Token, offered } from "./offer.js";
import { fetchSha256 } from "../../delivery-fetch.js";

async function specPreflight(ctx: AgentContext, specUrl: string, specHash: string): Promise<string | undefined> {
  const found = await fetchSha256(ctx.fetch ?? fetch, ctx.transport, specUrl);
  if ("problem" in found) {
    return `spec_url ${found.problem}; publish it or workers cannot read the job`;
  }
  if (found.sha256 !== specHash.toLowerCase()) {
    return `spec_url hashes to ${found.sha256}, not spec_hash ${specHash}; publish the exact bytes, or fix spec_hash`;
  }
  return undefined;
}

export const ESCROW_EXPIRES_IN = 86_400;

export const JOB_LIVE = `job live; ${tool("wallet_check_delivery")} to watch for work, then ${tool("wallet_attest")} its earliest announcer`;

export const RECORD_MINT_NEEDED = "selling SOL on this RPC needs record_mint: any other token's mint, which only labels the escrow";

function recordedMint(sell: Address, url: string, chosen: string | undefined): Address {
  if (chosen !== undefined) {
    return mintNamed(chosen, url, "record_mint");
  }
  if (sell !== NATIVE_MINT) {
    return NATIVE_MINT;
  }
  const test = tokenNamed("TEST", url);
  if (test instanceof Error) {
    throw new InvalidInput([{ path: "record_mint", message: RECORD_MINT_NEEDED }]);
  }
  return test as Address;
}

export const walletEscrow = define({
  name: tool("wallet_escrow"),
  title: "Escrow a payment for an attestor to release",
  description: `Pays for work once a judge approves it: locks tokens until the named attestor (the judge) releases them to the wallet it picks. Pick an attestor the user trusts. spec_url lets workers find the job with ${tool("find_jobs")}; they deliver to the attestor, as this wallet can cancel until release. ${PREVIEW_FIRST}`,
  effect: "submit",
  repeats: true,
  input: object({
    sell: text("SOL, TEST or a mint address: the token to pay with"),
    amount: text("whole tokens to escrow, such as 0.05"),
    attestor: account("the wallet whose signature alone releases the escrow, or a committee's address; at or above the token's committee floor it must be a committee of 2 or more"),
    min_result: optional(amount("least result the attestor may attest, a plain count not whole tokens; default 1")),
    max_result: optional(amount("greatest result the attestor may attest, a plain count not whole tokens; default min_result")),
    spec_hash: optional(hex32("64 hex: the sha256 of the acceptance spec the attestor must verify. Setting it binds the release to a signature over that exact spec, so the attestor cannot sign a generic result")),
    spec_url: optional(text(`where the acceptance spec is published, ${MEMO_URL_RULE}; needs spec_hash. Recorded in a memo this wallet signs with the escrow`)),
    judge_fee: optional(text("whole tokens of sell paid to the attestor out of the escrow when it settles, such as 0.001; needs spec_hash and must be below amount")),
    expires_in: optional(integer(MIN_EXPIRES_IN, MAX_EXPIRES_IN, `least seconds the escrow stays open once sent; default ${ESCROW_EXPIRES_IN}`)),
    record_mint: optional(text("a token the escrow records as its output, other than sell; only a label. Default SOL, or TEST when selling SOL on devnet")),
    send: optional(flag("true signs and sends; leave out to preview")),
  }),
  output: offerOutput,
  run: async (ctx: AgentContext, input, call: Call) => {
    const wallet = access(ctx);
    const sold = mintNamed(input.sell, wallet.url, "sell");
    const least = input.min_result ?? 1n;
    const most = input.max_result ?? least;
    if (most < least) {
      throw new InvalidInput([{ path: "max_result", message: "must be at least min_result" }]);
    }
    const specHash = input.spec_hash;
    if (input.judge_fee !== undefined && specHash === undefined) {
      throw new InvalidInput([{ path: "judge_fee", message: "needs spec_hash" }]);
    }
    if (input.spec_url !== undefined && specHash === undefined) {
      throw new InvalidInput([{ path: "spec_url", message: "needs spec_hash" }]);
    }
    const preflight = input.spec_url !== undefined && specHash !== undefined && input.send !== true ? await specPreflight(ctx, input.spec_url, specHash) : undefined;
    let settled: { amount: bigint; judgeFee: bigint; decimals: number } | undefined;
    const escrowed = (await offered(ctx, call, { sell: sold, buy: recordedMint(sold, wallet.url, input.record_mint), send: input.send }, (token, _, now) => {
      const amountIn = raw(input.amount, token.decimals, "amount");
      const judgeFee = input.judge_fee === undefined ? 0n : raw(input.judge_fee, token.decimals, "judge_fee");
      settled = { amount: amountIn, judgeFee, decimals: token.decimals };
      return {
        order: {
          kind: "attested",
          amount_in: amountIn,
          min_result: least,
          max_result: most,
          attestor: input.attestor,
          ...(specHash === undefined ? {} : { spec_hash: specHash }),
          ...(input.judge_fee === undefined ? {} : { judge_fee: judgeFee }),
        },
        expires_at: now + BigInt((input.expires_in ?? ESCROW_EXPIRES_IN) + LANDING_SECONDS),
        ...(input.spec_url === undefined ? {} : { spec_url: input.spec_url }),
      };
    }, JOB_LIVE)) as Record<string, unknown>;
    const summary = [...((escrowed["summary"] as string[]) ?? []), ...(settled === undefined ? [] : [await feeLine(ctx, settled)])];
    const warnings = [...((escrowed["warnings"] as string[]) ?? []), ...(preflight === undefined ? [] : [preflight])];
    return { ...escrowed, summary, warnings };
  },
});

async function feeLine(ctx: AgentContext, settled: { amount: bigint; judgeFee: bigint; decimals: number }): Promise<string> {
  const bps = feeBpsFor((await loadConfig(ctx.transport)).config, Kind.AttestedResult);
  const { net } = splitFees(settled.amount - settled.judgeFee, bps, 0, 0);
  return `Payee receives: ${formatAmount(net, settled.decimals)}, after the ${bps / 100}% protocol fee at today's config`;
}

export const MAX_PIECES = 12;

export const piecesPartlySent = (sent: number, total: number, problem: string) =>
  `${sent} of ${total} pieces were escrowed; the next failed with ${problem}. To finish, escrow only the ${total - sent} remaining pieces; do not repeat this call`;

export const piecesMayHaveLanded = (sent: number, total: number, problem: string) =>
  `${sent} of ${total} pieces were escrowed and the next may have landed too (${problem}); check ${tool("wallet_intents")} before escrowing any again, and do not repeat this call`;

export const pieceUnsettled = (index: number, name: string) => `nothing was escrowed: piece ${index} (${name}) cannot be paid; `;

type Piece = { name: string; amountIn: bigint; attestor: Address };

export const walletEscrowPlan = define({
  name: tool("wallet_escrow_plan"),
  title: "Escrow a task's pieces in one plan",
  description: `Pays for a larger task in pieces: one preview and one send lock a payment per piece, each like ${tool("wallet_escrow")}. Each piece is released on its own as it passes; cancel an unreleased piece with ${tool("wallet_cancel")}. Workers deliver to the attestor, not this wallet. ${PREVIEW_FIRST}`,
  effect: "submit",
  repeats: true,
  input: object({
    sell: text("SOL, TEST or a mint address: the token to pay with"),
    attestor: account("the wallet that releases every piece that names no attestor of its own"),
    pieces: list(
      object({
        name: text("a label for the piece, shown in the plan only"),
        amount: text("whole tokens this piece pays, such as 0.01"),
        attestor: optional(account("this piece's attestor, instead of the plan's")),
      }),
      MAX_PIECES,
      "the pieces, in order",
      2,
    ),
    expires_in: optional(integer(MIN_EXPIRES_IN, MAX_EXPIRES_IN, `least seconds each escrow stays open once sent; default ${ESCROW_EXPIRES_IN}`)),
    record_mint: optional(text("a token the escrows record as their output, other than sell; only a label. Default SOL, or TEST when selling SOL on devnet")),
    send: optional(flag("true signs and sends every piece; leave out to preview")),
  }),
  output: object({
    pieces: list(
      object({ name: text(), amount: text(), attestor: account(), intent: optional(account()), nonce: optional(amount()), signature: optional(text()) }),
      MAX_PIECES,
    ),
    total: text("whole tokens escrowed across all pieces"),
    summary: list(text(), 24, "the plan, then the first piece"),
    warnings: list(text(), 16),
    sent: flag(),
    next: optional(text()),
  }),
  run: async (ctx: AgentContext, input, call: Call) => {
    const wallet = access(ctx);
    oneAtATime(await signerOf(ctx));
    const sold = mintNamed(input.sell, wallet.url, "sell");
    const buy = recordedMint(sold, wallet.url, input.record_mint);
    const [token, now, { config }] = await Promise.all([mintOf(ctx.transport, sold), chainTime(ctx.transport), loadConfig(ctx.transport)]);
    const planned: Piece[] = input.pieces.map((piece, i) => ({
      name: piece.name,
      amountIn: raw(piece.amount, token.decimals, `pieces.${i}.amount`),
      attestor: piece.attestor ?? input.attestor,
    }));
    for (const [i, piece] of planned.entries()) {
      const order = { kind: Kind.AttestedResult, amountIn: piece.amountIn, minResult: 1n, maxResult: 1n, attestor: piece.attestor, specHash: new Uint8Array(32), judgeFee: 0n } as const;
      const unsettled = neverSettles(order, config, 0, token.decimals);
      if (unsettled !== undefined) {
        throw new AgentRefusal("NeverSettles", `${pieceUnsettled(i + 1, piece.name)}${unsettled}`);
      }
      await escrowJudge(ctx.transport, config, sold, order, token.decimals).catch((error: unknown) => {
        throw error instanceof AgentRefusal ? new AgentRefusal("CommitteeRequired", `${pieceUnsettled(i + 1, piece.name)}${error.message}`) : error;
      });
    }
    const total = planned.reduce((sum, piece) => sum + piece.amountIn, 0n);
    const sales = await salesOf(wallet, now);
    for (const piece of planned) {
      checkSale(wallet.limits, sold, token.decimals, piece.amountIn, now, sales);
    }
    checkHour(wallet.limits, sold, token.decimals, total, now, sales);
    const terms = (piece: Piece) => (_sold: Token, _bought: Token, at: bigint) => ({
      order: { kind: "attested" as const, amount_in: piece.amountIn, min_result: 1n, max_result: 1n, attestor: piece.attestor },
      expires_at: at + BigInt((input.expires_in ?? ESCROW_EXPIRES_IN) + LANDING_SECONDS),
    });
    const name = TOKEN_NAMES[sold] ?? sold;
    const listed = (piece: Piece) => ({ name: piece.name, amount: formatAmount(piece.amountIn, token.decimals), attestor: piece.attestor });
    const [head, ...rest] = planned as [Piece, ...Piece[]];
    const first = (await offered(ctx, call, { sell: sold, buy, send: input.send }, terms(head))) as Record<string, unknown>;
    const shown = {
      total: formatAmount(total, token.decimals),
      summary: [
        `Plan: ${planned.length} pieces, ${formatAmount(total, token.decimals)} of ${name} in all, each escrowed now and released on its own`,
        ...planned.map((piece, i) => `Piece ${i + 1}: ${piece.name}, ${formatAmount(piece.amountIn, token.decimals)} of ${name}, released by ${piece.attestor}`),
        ...(first["summary"] as string[]),
      ],
      warnings: first["warnings"] as string[],
    };
    if (input.send !== true) {
      return { pieces: planned.map(listed), ...shown, sent: false, next: first["next"] };
    }
    const pieces = [{ ...listed(head), intent: first["intent"], nonce: first["nonce"], signature: first["signature"] }];
    for (const piece of rest) {
      try {
        const made = (await offered(ctx, call, { sell: sold, buy, send: true }, terms(piece))) as Record<string, unknown>;
        pieces.push({ ...listed(piece), intent: made["intent"], nonce: made["nonce"], signature: made["signature"] });
      } catch (error) {
        for (const undo of call.undo.splice(0)) {
          undo();
        }
        const problem = problemOf(error);
        const reason = `${problem.code}: ${problem.hint}`;
        return {
          pieces: [...pieces, ...planned.slice(pieces.length).map(listed)],
          ...shown,
          sent: true,
          next: refusedBeforeSending(error) ? piecesPartlySent(pieces.length, planned.length, reason) : piecesMayHaveLanded(pieces.length, planned.length, reason),
        };
      }
    }
    return {
      pieces,
      ...shown,
      sent: true,
      next: `${planned.length} pieces escrowed; ${tool("wallet_check_delivery")} then ${tool("wallet_attest")} each earliest announcer`,
    };
  },
});
