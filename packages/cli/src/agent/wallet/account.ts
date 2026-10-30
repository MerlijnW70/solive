import type { Address } from "@solana/kit";
import { formatAmount } from "@intent-engine/core";
import { balances, defaultMints, FUND_BELOW, setup, SWAP_START } from "../../wallet.js";
import { type AgentContext, define } from "../actions.js";
import type { Call } from "../claims.js";
import { boardLeft, leavesBoard, thenSettle } from "../claim-line.js";
import { tool } from "../names.js";
import { listIntents, SOL_DECIMALS } from "../read.js";
import { account, amount, choice, flag, list, object, optional, text } from "../schema.js";
import { prepareCancel } from "../settle.js";
import { STATUS } from "../../accounts.js";
import { deviceOutput, PREVIEW_FIRST, WALLET_NOTICE, access, testCluster, savedKeypair, signerOf, mintNamed, sent } from "./guard.js";

export const WALLET_SMALL_START = `hire with ${tool("wallet_escrow")} or earn from ${tool("find_jobs")}; a 0.05 SOL swap needs ${formatAmount(SWAP_START, SOL_DECIMALS)} SOL`;

export const WALLET_START = [
  `trade with ${tool("wallet_swap")}, such as 0.05 SOL for at least 5 TEST`,
  `hire someone with ${tool("wallet_escrow")}, which pays once the attestor approves the work`,
  `earn by taking a paid job from ${tool("find_jobs")}`,
].join("; ");

const tokenRow = object({
  mint: account(),
  name: optional(text()),
  account: optional(account(`the wallet's token account for this mint; absent when it has none, for example after ${tool("wallet_unwrap")} closed it`)),
  balance: text("in whole tokens"),
});

export const walletSetup = define({
  name: tool("wallet_setup"),
  title: "Set up the wallet",
  description:
    `Gives the user a test wallet: creates one if this server has none, keeps its key on this computer, and asks devnet for free SOL below ${formatAmount(FUND_BELOW, SOL_DECIMALS)} SOL. Devnet may refuse; next says what the wallet holds and whether that is enough to start. Safe to call again. Saves this node (RPC) as the CLI's default if none is saved.`,
  effect: "submit",
  destructive: false,
  input: object({}),
  output: object({
    address: account(),
    keypair: text("the file holding the wallet's key on this machine"),
    created: flag("true when this call made the wallet"),
    url: text("the RPC node this server uses, as scheme, host and port only"),
    settings: text("whether this call saved the RPC as the CLI's default; it does so only when none is saved yet"),
    sol: text("SOL the wallet holds"),
    airdrop: optional(text("SOL devnet sent; less than asked when it refused a larger airdrop")),
    faucet: optional(
      object({
        lamports: optional(text("lamports the instant faucet sent, asked before devnet")),
        signature: optional(text("the transaction that carried them")),
        refused: optional(text("untrusted, with hidden characters reduced: why the instant faucet sent nothing")),
      }),
    ),
    next: text("what to tell the user: what the wallet holds, and how to trade, hire or earn"),
    other_ways: optional(list(text(), 4, "other ways to get SOL, when the wallet holds too little to start")),
    notice: list(text(), 8, "the notice from the server instructions; show it if the user has not seen it yet"),
  }),
  run: async (ctx: AgentContext) => {
    const wallet = await testCluster(ctx);
    return { ...(await setup(ctx.transport, wallet.files, wallet.url, await savedKeypair(wallet), true, undefined, undefined, WALLET_START, WALLET_SMALL_START, undefined, { fetch: ctx.faucetFetch, env: wallet.env })), notice: WALLET_NOTICE };
  },
});

export const walletBalance = define({
  name: tool("wallet_balance"),
  title: "Show the wallet's balances",
  description: "Shows the user how much SOL and how many tokens this wallet holds, in whole tokens. Without mints (token addresses) it shows wrapped SOL and, on devnet, the TEST token.",
  effect: "read",
  input: object({ mints: optional(list(text("SOL, TEST or a mint address"), 8)) }),
  output: object({ address: account(), sol: text(), tokens: list(tokenRow, 8) }),
  run: async (ctx: AgentContext, input) => {
    const wallet = access(ctx);
    const owner = (await signerOf(ctx)).address;
    const mints = input.mints?.map((m, i) => mintNamed(m, wallet.url, `mints.${i}`)) ?? defaultMints(wallet.url);
    return balances(ctx.transport, owner, mints);
  },
});

export const walletIntents = define({
  name: tool("wallet_intents"),
  title: "List the wallet's intents",
  description: "Lists the user's orders (intents) this wallet created, newest state first: open ones can still fill or be cancelled.",
  effect: "read",
  input: object({ status: optional(choice(STATUS, "only intents in this status")) }),
  output: listIntents.output,
  run: async (ctx: AgentContext, input, call: Call) => {
    const owner = (await signerOf(ctx)).address;
    return listIntents.run(ctx, { owner, ...(input.status === undefined ? {} : { status: input.status }) } as never, call);
  },
});

export const walletCancel = define({
  name: tool("wallet_cancel"),
  title: "Cancel a wallet intent",
  description: `Cancels one of the user's open orders by its nonce (order number): the locked tokens and the order's rent deposit return to this wallet, with SOL as wrapped SOL. ${PREVIEW_FIRST}`,
  effect: "submit",
  input: object({
    nonce: amount("the intent's nonce, from wallet_intents"),
    close: optional(flag("also close the empty account and return its rent; default true. Set false on a NotRentPayer error")),
    send: optional(flag("true signs and sends; leave out to preview")),
  }),
  output: object({
    intent: account(),
    refund: amount("raw input units returned to the wallet"),
    summary: list(text(), 18),
    warnings: list(text(), 8),
    ...deviceOutput,
    sent: flag(),
    signature: optional(text()),
    next: optional(text()),
  }),
  run: async (ctx: AgentContext, input, call: Call) => {
    const signer = await signerOf(ctx);
    const view = (await prepareCancel.run(ctx, { owner: signer.address, nonce: input.nonce, close: input.close ?? true } as never, call)) as Record<
      string,
      unknown
    > & { intent: Address; summary: string[] };
    const left = await boardLeft(ctx.transport, signer.address, input.nonce, view.intent);
    return sent(ctx, signer, { ...view, summary: [...view.summary, ...leavesBoard(left)] }, input.send, call, {
      done: thenSettle(`cancelled; ${tool("wallet_balance")} to see the refund`, left),
    });
  },
});
