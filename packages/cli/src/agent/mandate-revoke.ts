import { type Address, createNoopSigner } from "@solana/kit";
import { AccountState, getRevokeInstruction, getTokenDecoder } from "@solana-program/token";
import { formatAmount, IntentStatus, findAssociatedTokenAddress } from "@intent-engine/core";
import { buildApproveDelegate, buildCancelIntent, buildRevokeMandate, tokenOf } from "@intent-engine/core/internal";
import { type Transport } from "@intent-engine/client";
import { cancelClaims, createdAccount, mintOf, TOKEN_PROGRAMS, tokenProgramOf } from "@intent-engine/client/internal";
import { vaultBalance } from "../crank.js";
import { define } from "./actions.js";
import { tool } from "./names.js";
import { lowerAllowance } from "./owner.js";
import { prepare } from "./prepare.js";
import { readIntents } from "./read.js";
import { SimulationFailed } from "./problems.js";
import { preparedSchema, preparedView } from "./shapes.js";
import { TOKEN_NAMES } from "../tokens.js";
import { account, amount, integer, list, object, text } from "./schema.js";
import { loadMandate, mandateRef, MAX_MANDATE_INTENTS, REVOKE_CANCELS } from "./mandate-state.js";

const WARN_STILL_OPEN =
  "some of the agent's intents stay open after this; they can no longer be filled, but their escrow stays locked until you cancel them";

const skipReason = (account: Address, problem: string) =>
  `the refund to your token account ${account} would fail: ${problem}; fix it, then cancel with ${tool("prepare_cancel")}`;

async function refundProblem(
  transport: Transport,
  owner: Address,
  mint: Address,
  tokenProgram: Address,
): Promise<{ account: Address; problem: string | null }> {
  const account = await findAssociatedTokenAddress({ owner, mint, tokenProgram });
  const view = await createdAccount(transport, account);
  if (view === null || view.owner !== tokenProgram) {
    return { account, problem: "it does not exist" };
  }
  return { account, problem: getTokenDecoder().decode(view.data).state === AccountState.Frozen ? "it is frozen" : null };
}

async function frozen(transport: Transport, account: Address): Promise<boolean> {
  const view = await createdAccount(transport, account);
  return view !== null && TOKEN_PROGRAMS.includes(view.owner) && getTokenDecoder().decode(view.data).state === AccountState.Frozen;
}

export const prepareRevokeMandate = define({
  name: tool("prepare_revoke_mandate"),
  title: "Prepare a mandate revocation",
  description: `Build the transaction that revokes one mandate, returns its rent to the owner and lowers the engine's spending allowance by the unused budget. From then on no solver can fill any intent opened under it. Separate transactions in cancels each cancel one of up to ${REVOKE_CANCELS} of those intents that are still open, refunding their escrow; send them after prepared, in any order. An intent whose refund would fail, because the owner's token account for it is missing or frozen, is listed in skipped instead, so the revocation never depends on a cancel. still_open counts the ones left, skipped included, which list_intents finds and prepare_cancel cancels. Intents the owner made outside this mandate stay open and are counted in other_open. To revoke every mandate and pending signature together, the owner advances their signing epoch instead.`,
  effect: "prepare",
  input: object(mandateRef),
  output: object({
    mandate: account(),
    cancelled: list(account(), REVOKE_CANCELS, "intents the transactions in cancels cancel"),
    skipped: list(
      object({ intent: account(), reason: text("why its cancel was left out") }),
      REVOKE_CANCELS,
      "open intents under the mandate whose cancel would fail, so none is prepared",
    ),
    still_open: integer(0, MAX_MANDATE_INTENTS, "intents opened under the mandate that stay open, unfillable, until cancelled"),
    other_open: integer(
      0,
      Number.MAX_SAFE_INTEGER,
      "the owner's open intents not made under this mandate, such as their own or signed ones, which revoking leaves untouched",
    ),
    unreadable: integer(0, Number.MAX_SAFE_INTEGER, "intent accounts skipped because they could not be read"),
    allowance: amount("the engine's spending allowance on the mandate's input account once prepared lands"),
    summary: list(text(), 32, "what signing does, in plain words"),
    warnings: list(text(), 8, "anything to check before signing"),
    prepared: preparedSchema,
    cancels: list(preparedSchema, REVOKE_CANCELS, "one transaction per cancelled intent; send each once prepared has landed"),
  }),
  run: async ({ transport }, input) => {
    const id = input.id ?? 0n;
    const { address, mandate } = await loadMandate(transport, input.owner, input.agent, id);
    const owner = createNoopSigner(input.owner);
    const inputToken = await mintOf(transport, mandate.inputMint);
    const unused = mandate.total - mandate.spent;
    const locked = await frozen(transport, mandate.inputAccount);
    const lowered = await lowerAllowance(transport, input.owner, mandate.inputAccount, unused);
    const allowance = locked ? { ...lowered, after: lowered.before } : lowered;
    const lower =
      allowance.after === allowance.before
        ? []
        : allowance.after === 0n
          ? [getRevokeInstruction({ source: mandate.inputAccount, owner }, { programAddress: inputToken.tokenProgram })]
          : [
              await buildApproveDelegate({
                owner,
                mint: mandate.inputMint,
                tokenProgram: inputToken.tokenProgram,
                amount: allowance.after,
                decimals: inputToken.decimals,
                source: mandate.inputAccount,
              }),
            ];
    const { intents, unreadable } = readIntents(await transport.intents({ owner: input.owner }));
    const live = intents
      .map(({ address: intent, intent: state }) => ({ intent, state }))
      .filter(({ state }) => state.owner === input.owner && state.status === IntentStatus.Open);
    const open = live.filter(({ state }) => state.mandate === address);
    const ix = await buildRevokeMandate({ owner, agent: input.agent, id });
    const prepared = preparedView(await prepare(transport, [ix, ...lower], input.owner));
    const chosen: Address[] = [];
    const cancels = [];
    const skipped: { intent: Address; reason: string }[] = [];
    let refunded = 0n;
    for (const { intent, state } of open.slice(0, REVOKE_CANCELS)) {
      const tokenProgram = await tokenProgramOf(transport, state.inputMint);
      const refund = await refundProblem(transport, input.owner, state.inputMint, tokenProgram);
      if (refund.problem !== null) {
        skipped.push({ intent, reason: skipReason(refund.account, refund.problem) });
        continue;
      }
      const claims = await cancelClaims(transport, intent, state.claims);
      const cancel = await buildCancelIntent({ owner, nonce: state.nonce, inputMint: state.inputMint, tokenProgram, capped: state.capped, ...(claims === undefined ? {} : { claims }) });
      try {
        cancels.push(preparedView(await prepare(transport, [cancel], input.owner)));
      } catch (error) {
        if (!(error instanceof SimulationFailed)) {
          throw error;
        }
        skipped.push({ intent, reason: `its cancel fails: ${error.problem.code}: ${error.problem.hint}` });
        continue;
      }
      chosen.push(intent);
      refunded += await vaultBalance(transport, intent);
    }
    const show = (raw: bigint) => formatAmount(raw, inputToken.decimals);
    const left = open.length - chosen.length;
    const others = live.filter(({ state }) => state.mandate !== address);
    return {
      mandate: address,
      cancelled: chosen,
      skipped,
      still_open: left,
      other_open: others.length,
      unreadable,
      allowance: allowance.after,
      summary: [
        `Revokes mandate ${address}: ${input.agent} can no longer create intents for you, and nobody can fill the ones it made`,
        ...(open.length === 0
          ? ["None of the agent's intents under it are open"]
          : chosen.length === 0
            ? []
            : [
                `Cancels the agent's ${chosen.length} open intent(s) and returns ${show(refunded)} of ${tokenOf(mandate.inputMint, TOKEN_NAMES[mandate.inputMint])} to you, one transaction each after the revocation`,
              ]),
        ...skipped.map(({ intent, reason }) => `Does not cancel ${intent}: ${reason}`),
        ...(left === 0 ? [] : [`Leaves ${left} more of its intents open but unfillable; cancel them with ${tool("prepare_cancel")}`]),
        locked
          ? `Leaves the engine's spending allowance on ${mandate.inputAccount} at ${show(allowance.before)}, since that account is frozen`
          : allowance.after === allowance.before
            ? `Leaves the engine's spending allowance on ${mandate.inputAccount} at ${show(allowance.before)}`
            : `Lowers the engine's spending allowance on ${mandate.inputAccount} from ${show(allowance.before)} to ${show(allowance.after)}, taking back the mandate's unused ${show(unused)}`,
        ...(others.length === 0
          ? []
          : [`Leaves your ${others.length} other open intent(s) untouched: ${others.map(({ intent }) => intent).join(", ")}`]),
        "Returns the mandate's rent to you",
      ],
      warnings: left === 0 ? [] : [WARN_STILL_OPEN],
      prepared,
      cancels,
    };
  },
});
