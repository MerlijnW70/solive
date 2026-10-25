import { createNoopSigner } from "@solana/kit";
import { formatAmount } from "@intent-engine/core";
import { buildCancelIntent, buildCloseIntent, decodeParamsLoose, describeTerms, findVaultPda, getIntentDecoder, tokenOf } from "@intent-engine/core/internal";
import { cancelClaims, chainTime, loadIntent, tokenProgramOf } from "@intent-engine/client/internal";
import { closing, CostlyFunding, crankAction, expiring, type Funding, UnfundedAccount, vaultBalance } from "../crank.js";
import { define } from "./actions.js";
import { tool } from "./names.js";
import { prepare } from "./prepare.js";
import { AgentRefusal } from "./problems.js";
import { preparedSchema, preparedView } from "./shapes.js";
import { account, amount, choice, flag, integer, list, object, optional, text } from "./schema.js";
import { TOKEN_NAMES, tokenNames } from "../tokens.js";
import { decimalsFor, SOL_DECIMALS } from "./read.js";

const WORK_LIMIT = 100;

export const OWNER_ACCOUNT_MISSING =
  "the owner has no token account that can take the refund; set fund_accounts to create one for them at the cranker's cost";

const intentRef = {
  owner: account("the wallet that created the intent"),
  nonce: amount("the intent's nonce under that owner"),
};

export const prepareCancel = define({
  name: tool("prepare_cancel"),
  title: "Prepare a cancel",
  description:
    "Build the transaction that cancels an open intent and returns what is left in escrow to the owner's token account. The intent account stays readable as cancelled and keeps its rent and bounty until whoever paid them closes it; if the owner paid them, set close to close it in the same transaction and get them back now. Only the owner can sign it.",
  effect: "prepare",
  input: object({
    ...intentRef,
    close: optional(flag("also close the intent account and return its rent and bounty to the owner, who must have paid them; it can no longer be read afterwards")),
  }),
  output: object({
    intent: account(),
    refund: amount("raw input units returned to the owner"),
    summary: list(text(), 16, "what signing does, in plain words"),
    warnings: list(text(), 8, "anything to check before signing"),
    prepared: preparedSchema,
  }),
  run: async ({ transport }, input) => {
    const { address, intent } = await loadIntent(transport, input.owner, input.nonce);
    const owner = createNoopSigner(input.owner);
    const ref = {
      owner: input.owner,
      nonce: input.nonce,
      inputMint: intent.inputMint,
      tokenProgram: await tokenProgramOf(transport, intent.inputMint),
      capped: intent.capped,
    };
    const claims = await cancelClaims(transport, address, intent.claims);
    const ix = await buildCancelIntent({ ...ref, owner, ...(claims === undefined ? {} : { claims }) });
    const ownPaid = intent.rentPayer === input.owner;
    const andClose = input.close ?? false;
    if (andClose && !ownPaid) {
      throw new AgentRefusal(
        "NotRentPayer",
        `${intent.rentPayer} paid this intent's rent and bounty, so only it can close the intent; cancel without close`,
      );
    }
    const close = andClose ? [await buildCloseIntent({ ...ref, cranker: owner, rentPayer: input.owner })] : [];
    const [vault] = await findVaultPda({ intent: address });
    let held = 0n;
    for (const account of [address, vault]) {
      held += (await transport.getAccount(account))?.lamports ?? 0n;
    }
    const rent = `${held} lamports (${formatAmount(held, SOL_DECIMALS)} SOL)`;
    const refund = await vaultBalance(transport, address);
    const decimals = await decimalsFor(transport, new Map(), intent.inputMint, intent.outputMint);
    const params = decodeParamsLoose(intent.kind, Uint8Array.from(intent.params));
    const terms =
      "unknown" in params
        ? []
        : describeTerms(
            { kind: intent.kind, params: Uint8Array.from(intent.params), inputMint: intent.inputMint, outputMint: intent.outputMint },
            { ...decimals, ...tokenNames(intent.inputMint, intent.outputMint) },
          );
    return {
      intent: address,
      refund,
      summary: [
        `Cancels intent ${address} (nonce ${intent.nonce}); nobody can fill it afterwards`,
        ...terms.map((line) => `Cancelled terms: ${line}`),
        `Returns ${formatAmount(refund, decimals.inputDecimals)} of ${tokenOf(intent.inputMint, TOKEN_NAMES[intent.inputMint])} to your token account`,
        andClose
          ? `Closes the intent and its escrow account in the same transaction and returns their ${rent} of rent and bounty to you; the intent can no longer be read afterwards`
          : ownPaid
            ? `The intent and its escrow account stay readable as cancelled and hold ${rent} of rent and bounty that are yours; set close to get them back in this transaction, or close it later with ${tool("prepare_crank")}`
            : `The intent and its escrow account stay until ${intent.rentPayer}, who paid for them, closes them; that returns their ${rent} to them`,
      ],
      warnings: [],
      prepared: preparedView(await prepare(transport, [ix, ...close], input.owner)),
    };
  },
});

export const findCrankWork = define({
  name: tool("find_crank_work"),
  title: "Find crank work",
  description:
    "List intents anyone may settle now for their bounty: open intents past their expiry (expire refunds the owner) and filled or expired intents waiting to be closed (close returns their rent to whoever paid it, or to the cranker when that payer has since become a program). A cancelled intent's bounty goes back to its payer, so it is listed only for that payer, given as cranker. Each comes with the bounty in lamports.",
  effect: "read",
  input: object({
    cranker: optional(account("include the cancelled intents this wallet paid for, whose bounty and rent return to it")),
    limit: optional(integer(1, WORK_LIMIT)),
  }),
  output: object({
    now: amount("chain time in unix seconds"),
    work: list(
      object({ intent: account(), owner: account(), nonce: amount(), action: choice(["expire", "close"]), bounty: amount() }),
      WORK_LIMIT,
    ),
    more: flag(),
  }),
  run: async ({ transport }, input) => {
    const now = await chainTime(transport);
    const work = [];
    for (const { address, data } of await transport.intents()) {
      const intent = getIntentDecoder().decode(data);
      const action = crankAction(intent, now, input.cranker);
      if (action !== undefined) {
        work.push({ intent: address, owner: intent.owner, nonce: intent.nonce, action, bounty: BigInt(intent.bounty) });
      }
    }
    const limit = input.limit ?? WORK_LIMIT;
    return { now, work: work.slice(0, limit), more: work.length > limit };
  },
});

export const prepareCrank = define({
  name: tool("prepare_crank"),
  title: "Prepare a crank",
  description:
    "Build the transaction that expires an overdue intent (refunding its owner) and closes it, or closes an already settled one, paying the intent's bounty to the cranker. The cranker signs and pays the fee. If the owner's token account is gone or cannot take the refund, set fund_accounts to create one for the owner at the cranker's cost; that is refused when its rent exceeds the bounty.",
  effect: "prepare",
  input: object({
    cranker: account("the wallet that signs, pays the fee and receives the bounty"),
    ...intentRef,
    fund_accounts: optional(flag("recreate the owner's missing token account at the cranker's cost, only when the bounty covers its rent")),
  }),
  output: object({ intent: account(), action: choice(["expire", "close"]), bounty: amount(), prepared: preparedSchema }),
  run: async ({ transport }, input) => {
    const { address, intent } = await loadIntent(transport, input.owner, input.nonce);
    const action = crankAction(intent, await chainTime(transport), input.cranker);
    if (action === undefined) {
      throw new AgentRefusal(
        "NothingToCrank",
        "this intent is still open and not yet expired, was cancelled and pays nothing to this cranker, or is not one this client can read",
      );
    }
    const cranker = createNoopSigner(input.cranker);
    const fund: Funding = (input.fund_accounts ?? false) ? "covered" : "never";
    try {
      const ixs =
        action === "expire"
          ? await expiring(transport, cranker, address, intent, fund, true)
          : await closing(transport, cranker, address, intent, fund);
      return { intent: address, action, bounty: BigInt(intent.bounty), prepared: preparedView(await prepare(transport, ixs, input.cranker)) };
    } catch (error) {
      if (error instanceof CostlyFunding) {
        throw new AgentRefusal("FundingExceedsBounty", error.message);
      }
      if (error instanceof UnfundedAccount) {
        throw new AgentRefusal("OwnerAccountMissing", OWNER_ACCOUNT_MISSING);
      }
      throw error;
    }
  },
});
