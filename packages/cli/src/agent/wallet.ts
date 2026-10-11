import type { Address, KeyPairSigner } from "@solana/kit";
import { parseAmount } from "@intent-engine/core";
import { mintOf } from "../accounts.js";
import { ENV_KEYPAIR, type Env } from "../args.js";
import { execute, type PreparedView } from "../flows.js";
import { tokenNamed } from "../tokens.js";
import { balances, defaultMints, FAUCET, type Files, PUBLIC_FAUCET, setup, withSettings } from "../wallet.js";
import { type AgentContext, type AnyAction, define } from "./actions.js";
import type { Call } from "./claims.js";
import { MAX_EXPIRES_IN, MIN_EXPIRES_IN, prepareCreate } from "./create.js";
import { tool } from "./names.js";
import { AgentRefusal } from "./problems.js";
import { listIntents } from "./read.js";
import { InvalidInput, account, amount, choice, flag, integer, list, object, optional, text } from "./schema.js";
import { prepareCancel } from "./settle.js";
import { STATUS } from "../accounts.js";

export type WalletAccess = { url: string; files: Files; env: Env };

export const DEFAULT_EXPIRES_IN = 3_600;

export const walletEmpty = (address: string) =>
  `the wallet ${address} holds no SOL yet; request devnet SOL for it at ${FAUCET} or ${PUBLIC_FAUCET}, then try again`;

export const NO_WALLET = `this server has no wallet yet; call ${tool("wallet_setup")} first`;
export const WALLET_OFF = "this server runs without a wallet; start it with mcp --wallet to let it sign";
export const PREVIEW_ONLY =
  "nothing was sent; show the summary to the user and call again with send: true only after they approve";

function access(ctx: AgentContext): WalletAccess {
  if (ctx.wallet === undefined) {
    throw new AgentRefusal("WalletNotConfigured", WALLET_OFF);
  }
  return ctx.wallet;
}

async function savedKeypair(wallet: WalletAccess): Promise<string | undefined> {
  return (await withSettings(wallet.files, wallet.env))[ENV_KEYPAIR];
}

async function signerOf(ctx: AgentContext): Promise<KeyPairSigner> {
  const wallet = access(ctx);
  const path = await savedKeypair(wallet);
  if (path === undefined) {
    throw new AgentRefusal("NoWallet", NO_WALLET);
  }
  try {
    return await wallet.files.loadSigner(path);
  } catch {
    throw new AgentRefusal("NoWallet", NO_WALLET);
  }
}

function mintNamed(text: string, url: string, path: string): Address {
  const mint = tokenNamed(text.trim(), url);
  if (mint instanceof Error) {
    throw new InvalidInput([{ path, message: mint.message }]);
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)) {
    throw new InvalidInput([{ path, message: "name SOL, TEST or a token mint address" }]);
  }
  return mint as Address;
}

function raw(tokens: string, decimals: number, path: string): bigint {
  try {
    return parseAmount(tokens, decimals);
  } catch (error) {
    throw new InvalidInput([{ path, message: error instanceof Error ? error.message : String(error) }]);
  }
}

async function sent(ctx: AgentContext, signer: KeyPairSigner, view: Record<string, unknown>, send: boolean | undefined, call: Call) {
  for (const undo of call.undo.splice(0)) {
    undo();
  }
  const { prepared, ...shown } = view as { prepared: PreparedView } & Record<string, unknown>;
  if (send !== true) {
    return { ...shown, sent: false, next: PREVIEW_ONLY };
  }
  return { ...shown, sent: true, signature: await execute(ctx.transport, prepared, signer) };
}

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
    "Create this server's devnet wallet if it has none, save it, and fund it from the devnet airdrop when it holds less than 0.5 SOL. Safe to call again: it reuses the saved wallet. Call this first.",
  effect: "submit",
  input: object({}),
  output: object({
    address: account(),
    keypair: text("the file holding the wallet's key on this machine"),
    created: flag("true when this call made the wallet"),
    url: text(),
    sol: text("SOL the wallet holds"),
    next: text("what to tell the user"),
  }),
  run: async (ctx: AgentContext) => {
    const wallet = access(ctx);
    return setup(ctx.transport, wallet.files, wallet.url, await savedKeypair(wallet));
  },
});

export const walletBalance = define({
  name: tool("wallet_balance"),
  title: "Show the wallet's balances",
  description: "Show the SOL and token balances of this server's wallet, in whole tokens. Without mints it shows wrapped SOL and, on devnet, the TEST token.",
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

export const walletSwap = define({
  name: tool("wallet_swap"),
  title: "Swap from the wallet",
  description:
    "Offer an exact amount of one token for at least an amount of another, from this server's wallet: the tokens are escrowed in an intent that a solver fills or that the wallet gets back. Amounts are whole tokens such as 0.05. Selling SOL wraps it first. Without send it only previews; show the user the summary and call again with send: true once they approve.",
  effect: "submit",
  repeats: true,
  input: object({
    sell: text("SOL, TEST or a mint address"),
    buy: text("SOL, TEST or a mint address"),
    amount: text("whole tokens to sell, such as 0.05"),
    min_receive: text("least whole tokens to receive for all of it"),
    expires_in: optional(integer(MIN_EXPIRES_IN, MAX_EXPIRES_IN, `seconds until the offer expires; default ${DEFAULT_EXPIRES_IN}`)),
    send: optional(flag("true signs and sends; leave out to preview")),
  }),
  output: object({
    intent: account(),
    nonce: amount(),
    summary: list(text(), 24),
    warnings: list(text(), 16),
    sent: flag(),
    signature: optional(text()),
    next: optional(text()),
  }),
  run: async (ctx: AgentContext, input, call: Call) => {
    const wallet = access(ctx);
    const signer = await signerOf(ctx);
    if (((await ctx.transport.getAccount(signer.address))?.lamports ?? 0n) === 0n) {
      throw new AgentRefusal("WalletEmpty", walletEmpty(signer.address));
    }
    const inputMint = mintNamed(input.sell, wallet.url, "sell");
    const outputMint = mintNamed(input.buy, wallet.url, "buy");
    const [inputToken, outputToken] = [await mintOf(ctx.transport, inputMint), await mintOf(ctx.transport, outputMint)];
    const view = (await prepareCreate.run(
      ctx,
      {
        owner: signer.address,
        input_mint: inputMint,
        output_mint: outputMint,
        order: {
          kind: "swap",
          amount_in: raw(input.amount, inputToken.decimals, "amount"),
          min_out: raw(input.min_receive, outputToken.decimals, "min_receive"),
        },
        expires_in: input.expires_in ?? DEFAULT_EXPIRES_IN,
      } as never,
      call,
    )) as Record<string, unknown>;
    const { intent, nonce, summary, warnings, prepared } = view;
    return sent(ctx, signer, { intent, nonce, summary, warnings, prepared }, input.send, call);
  },
});

export const walletIntents = define({
  name: tool("wallet_intents"),
  title: "List the wallet's intents",
  description: "List the intents this server's wallet created, newest state first: open ones can still fill or be cancelled.",
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
  description:
    "Cancel an open intent of this server's wallet by its nonce: the escrow returns to the wallet and the intent account closes, returning its rent. Without send it only previews; call again with send: true once the user approves.",
  effect: "submit",
  input: object({ nonce: amount("the intent's nonce, from wallet_intents"), send: optional(flag("true signs and sends; leave out to preview")) }),
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
    const view = (await prepareCancel.run(ctx, { owner: signer.address, nonce: input.nonce, close: true } as never, call)) as Record<
      string,
      unknown
    >;
    return sent(ctx, signer, view, input.send, call);
  },
});

export const WALLET_ACTIONS: readonly AnyAction[] = [walletSetup, walletBalance, walletSwap, walletIntents, walletCancel];
