import { type Address, createNoopSigner, type TransactionPartialSigner } from "@solana/kit";
import { getApproveCheckedInstruction, getRevokeInstruction, getTokenDecoder } from "@solana-program/token";
import { findAssociatedTokenAddress, formatAmount } from "@intent-engine/core";
import { allowanceOf, spendable } from "@intent-engine/solver";
import { type Transport } from "@intent-engine/client";
import { createdAccount, mintOf } from "@intent-engine/client/internal";
import { prepare } from "./agent/prepare.js";
import { preparedView } from "./agent/shapes.js";
import type { Command } from "./command-types.js";
import { finish, FlowRefused, inRaw } from "./flows.js";
import { transactionSigner } from "./ledger-keys.js";
import type { Runtime } from "./runtime.js";
import { defaultMints } from "./wallet.js";

export const FLOAT_TO_OWNER = "the delegate is the solver key that spends the float, not the owner who holds it";

export const replacesDelegate = (delegate: Address, account: Address): string =>
  `${delegate} loses its allowance on ${account}, since a token account has one delegate`;

export const FLOAT_NEXT = "run solve with --keypair <solver key file> --inventory-owner <this owner> and --inventory; solver float show reads what is left";

export const NO_DELEGATE = "no delegate may spend from this token account, so there is nothing to revoke";

export const REVOKE_NEXT = "the solver can no longer fill from this owner's float; solver float approves a new one";

type FloatCommand = Extract<Command, { name: "solver-float" | "solver-float-show" | "solver-float-revoke" }>;

export async function floatCommand(command: FloatCommand, runtime: Runtime, transport: Transport): Promise<object> {
  if (command.name === "solver-float-show") {
    return floatShow(transport, command.owner, command.delegate, command.mints ?? defaultMints(command.url));
  }
  const signer = await transactionSigner(runtime, command.keypair);
  if (command.name === "solver-float-revoke") {
    return floatRevoke(transport, signer, command.mint, command.yes);
  }
  const { amount } = await inRaw(transport, { amount: command.amount }, command.mint, command.mint);
  return floatApprove(transport, signer, command.delegate, command.mint, BigInt(amount as string), command.yes);
}

export async function floatApprove(
  transport: Transport,
  signer: TransactionPartialSigner,
  delegate: Address,
  mint: Address,
  amount: bigint,
  yes: boolean,
): Promise<object> {
  if (delegate === signer.address) {
    throw new FlowRefused(FLOAT_TO_OWNER);
  }
  const token = await mintOf(transport, mint);
  const account = await findAssociatedTokenAddress({ owner: signer.address, mint, tokenProgram: token.tokenProgram });
  const view = await createdAccount(transport, account);
  if (view === null) {
    throw new FlowRefused(`${signer.address} holds no token account for ${mint} at ${account}`);
  }
  const state = getTokenDecoder().decode(view.data);
  const other = state.delegate.__option === "Some" && state.delegate.value !== delegate ? state.delegate.value : null;
  const show = (raw: bigint) => formatAmount(raw, token.decimals);
  const instruction = getApproveCheckedInstruction(
    { source: account, mint, delegate, owner: createNoopSigner(signer.address), amount, decimals: token.decimals },
    { programAddress: token.tokenProgram },
  );
  const warnings = other === null ? [] : [replacesDelegate(other, account)];
  return finish(
    transport,
    {
      account,
      delegate,
      allowance: amount,
      summary: [
        `Lets ${delegate} spend up to ${show(amount)} from ${account} (now ${show(allowanceOf(view.data, delegate))}), and nothing else the owner holds`,
        ...warnings.map((w) => `WARNING: ${w}`),
      ],
      warnings,
      next: FLOAT_NEXT,
      prepared: preparedView(await prepare(transport, [instruction], signer.address)),
    },
    signer,
    yes,
  );
}

export async function floatRevoke(transport: Transport, signer: TransactionPartialSigner, mint: Address, yes: boolean): Promise<object> {
  const token = await mintOf(transport, mint);
  const account = await findAssociatedTokenAddress({ owner: signer.address, mint, tokenProgram: token.tokenProgram });
  const view = await createdAccount(transport, account);
  if (view === null) {
    throw new FlowRefused(`${signer.address} holds no token account for ${mint} at ${account}`);
  }
  const state = getTokenDecoder().decode(view.data);
  if (state.delegate.__option !== "Some") {
    throw new FlowRefused(NO_DELEGATE);
  }
  const delegate = state.delegate.value;
  const instruction = getRevokeInstruction({ source: account, owner: createNoopSigner(signer.address) }, { programAddress: token.tokenProgram });
  return finish(
    transport,
    {
      account,
      delegate,
      summary: [`Revokes ${delegate}'s allowance of ${formatAmount(state.delegatedAmount, token.decimals)} on ${account}, so it can spend nothing the owner holds`],
      next: REVOKE_NEXT,
      prepared: preparedView(await prepare(transport, [instruction], signer.address)),
    },
    signer,
    yes,
  );
}

export async function floatShow(transport: Transport, owner: Address, delegate: Address, mints: readonly Address[]): Promise<object> {
  const floats = [];
  for (const mint of mints) {
    const token = await mintOf(transport, mint);
    const account = await findAssociatedTokenAddress({ owner, mint, tokenProgram: token.tokenProgram });
    const view = await createdAccount(transport, account);
    const balance = view === null ? 0n : getTokenDecoder().decode(view.data).amount;
    const allowance = allowanceOf(view?.data ?? null, delegate);
    floats.push({
      mint,
      account,
      balance: formatAmount(balance, token.decimals),
      allowance: formatAmount(allowance, token.decimals),
      spendable: formatAmount(spendable(balance, allowance), token.decimals),
    });
  }
  return { owner, delegate, floats };
}
