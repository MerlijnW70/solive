import { balances, defaultMints, setup } from "../../wallet.js";
import { type AgentContext, define } from "../actions.js";
import type { Call } from "../claims.js";
import { tool } from "../names.js";
import { listIntents } from "../read.js";
import { account, amount, choice, flag, list, object, optional, text } from "../schema.js";
import { prepareCancel } from "../settle.js";
import { STATUS } from "../../accounts.js";
import { PREVIEW_FIRST, WALLET_NOTICE, access, testCluster, savedKeypair, signerOf, mintNamed, sent } from "./guard.js";

const tokenRow = object({
  mint: account(),
  name: optional(text()),
  account: account("the wallet's token account for this mint"),
  balance: text("in whole tokens"),
});

export const walletSetup = define({
  name: tool("wallet_setup"),
  title: "Set up the wallet",
  description:
    "Gives the user a test wallet: creates one if this server has none, keeps its key in a file on this computer, and tops it up with free devnet SOL when it holds less than 0.5 SOL. Safe to call again: it reuses the saved wallet. It saves this node (RPC) as the command line's default if none is saved.",
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
    next: text("what to tell the user"),
    notice: list(text(), 8, "the notice from the server instructions; show it if the user has not seen it yet"),
  }),
  run: async (ctx: AgentContext) => {
    const wallet = await testCluster(ctx);
    return { ...(await setup(ctx.transport, wallet.files, wallet.url, await savedKeypair(wallet), true)), notice: WALLET_NOTICE };
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
    close: optional(flag("true also closes the empty intent account and returns its rent; default true. Set false when a NotRentPayer error says another wallet paid the rent")),
    send: optional(flag("true signs and sends; leave out to preview")),
  }),
  output: object({
    intent: account(),
    refund: amount("raw input units returned to the wallet"),
    summary: list(text(), 16),
    warnings: list(text(), 8),
    sent: flag(),
    signature: optional(text()),
    next: optional(text()),
  }),
  run: async (ctx: AgentContext, input, call: Call) => {
    const signer = await signerOf(ctx);
    const view = (await prepareCancel.run(ctx, { owner: signer.address, nonce: input.nonce, close: input.close ?? true } as never, call)) as Record<
      string,
      unknown
    >;
    return sent(ctx, signer, view, input.send, call, {
      done: `the escrow is cancelled and its tokens returned; call ${tool("wallet_balance")} to see them`,
    });
  },
});
