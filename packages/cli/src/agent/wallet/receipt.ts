import { type Address, getAddressDecoder } from "@solana/kit";
import { findIntentPda, formatAmount } from "@intent-engine/core";
import { intentAt, mintOf, recordedDelivery, type Transport } from "@intent-engine/client";
import { type AgentContext, define } from "../actions.js";
import { tool } from "../names.js";
import { AgentRefusal } from "../problems.js";
import { account, amount, flag, object, optional, text } from "../schema.js";
import { signerOf, sha256Of } from "./guard.js";
import { RELEASE_INPUT, releaseOf, otherLifecycle, coverageOf } from "./record.js";
import { RELEASE_UNKNOWN, outlives, releaseLookup, namedRelease, releasedMint, createdMint, heldMint } from "./releases.js";

export const NOT_RELEASED = `no release of this escrow is in its history; ${tool("wallet_wait")} or ${tool("wallet_intents")} shows whether it is still open`;

export const RECEIPT_PARTIAL =
  "the escrow's history after this release could not be read in full: it is longer than the pages read or the RPC node could not return some of its transactions yet, so a follow-up recording the delivered work may be missing, and without release given, the escrow address may have been made again since; pass release, the signature the release returned, or call again in a few seconds";

const receiptOutput = object({
  intent: account(),
  released: flag(),
  complete: optional(
    flag(
      "false when the history read was not enough: with released false, no release was found in it, so released is unknown rather than known; with released true, a follow-up recording the delivered work, or a later lifecycle of the escrow address, may be missing from it",
    ),
  ),
  paid_to: optional(account("the wallet the release paid")),
  payee: optional(account("the token account the release paid")),
  paid: optional(text("whole tokens the payee received")),
  attestor: optional(account()),
  result: optional(amount()),
  recipients: optional(amount("how many co-authors a split release paid")),
  signature: optional(text("the release's transaction")),
  delivered_sha256: optional(text("the sha256 the release recorded, if any, in its own memo or in a follow-up transaction its attestor signed")),
  matches: optional(flag("whether sha256 equals the recorded one")),
  next: optional(text()),
});

export const walletReceipt = define({
  name: tool("wallet_receipt"),
  title: "Check this wallet's escrow release",
  description: `Shows the payer whether an escrow made with ${tool("wallet_escrow")} was released: to whom, for how much, by which attestor (judge), and which work it recorded. Give sha256 of the work received to check it is what was paid for, and release, the release's signature, to read it quickly. It sends nothing.`,
  effect: "read",
  input: object({
    owner: optional(account("the wallet that made the escrow; default this server's wallet")),
    nonce: amount("the escrow intent's nonce"),
    sha256: optional(text("the sha256, as 64 hex digits, of the work you received, to compare with the one the release recorded")),
    release: optional(text(RELEASE_INPUT)),
  }),
  output: receiptOutput,
  run: async (ctx: AgentContext, input) => escrowReceipt(ctx.transport, input.owner ?? (await signerOf(ctx)).address, input.nonce, input.sha256, input.release),
});

export const getReceipt = define({
  name: tool("get_receipt"),
  title: "Check any owner's escrow release",
  description: `Look up whether an escrow was released: to whom, for how much, by which attestor, and which delivered work the release recorded. Give sha256, the hash of the work you received, to check it is the work that was paid for, and release, the signature the release returned, to read the release from that one transaction however long the escrow's history grew. It reads the escrow's own transactions, sends nothing and needs no wallet.`,
  effect: "read",
  input: object({
    owner: account("the wallet that made the escrow"),
    nonce: amount("the escrow intent's nonce"),
    sha256: optional(text("the sha256, as 64 hex digits, of the work you received, to compare with the one the release recorded")),
    release: optional(text(RELEASE_INPUT)),
  }),
  output: receiptOutput,
  run: async (ctx: AgentContext, input) => escrowReceipt(ctx.transport, input.owner, input.nonce, input.sha256, input.release),
});

export async function escrowReceipt(transport: Transport, owner: Address, nonce: bigint, sha256: string | undefined, releaseSignature?: string) {
  const wanted = sha256 === undefined ? undefined : sha256Of(sha256, "sha256");
  const named = releaseOf(releaseSignature);
  const [intent] = await findIntentPda({ owner, nonce });
  const lookup = named === undefined ? await releaseLookup(transport, intent) : await namedRelease(transport, intent, named);
  const { release, transactions, complete, bound, creation } = lookup;
  if (release === null) {
    return complete ? { intent, released: false, next: NOT_RELEASED } : { intent, released: false, complete: false, next: coverageOf(transport, RELEASE_UNKNOWN) };
  }
  const { tx } = release;
  if (named !== undefined) {
    const now = await intentAt(transport, intent);
    if (lookup.later === true || (now !== null && outlives(now, tx, creation))) {
      throw new AgentRefusal("OtherLifecycle", otherLifecycle(named, intent));
    }
  }
  const fields = release.event.fields as Record<string, unknown>;
  let mint = createdMint([...transactions, ...(creation === null || creation === undefined ? [] : [creation])], intent) ?? releasedMint(tx, intent, fields["payee"] as Address | undefined);
  const recorded = recordedDelivery(transactions, tx, fields["attestor"] as Address) ?? undefined;
  const common = {
    intent,
    released: true,
    ...(complete && bound ? {} : { complete: false, next: RECEIPT_PARTIAL }),
    attestor: fields["attestor"] as Address,
    result: fields["result"] as bigint,
    signature: tx.signature,
    ...(recorded === undefined ? {} : { delivered_sha256: recorded }),
    ...(wanted === undefined ? {} : { matches: wanted === recorded }),
  };
  if (release.event.name === "IntentSplit") {
    mint ??= await heldMint(transport, intent);
    const decimals = mint === undefined ? undefined : (await mintOf(transport, mint)).decimals;
    return { ...common, paid: formatAmount(fields["net"] as bigint, decimals), recipients: BigInt(fields["recipients"] as number) };
  }
  const payee = fields["payee"] as Address;
  const held = await transport.getAccount(payee);
  mint ??= held === null || held.data.length < 64 ? await heldMint(transport, intent) : getAddressDecoder().decode(held.data.subarray(0, 32));
  const decimals = mint === undefined ? undefined : (await mintOf(transport, mint)).decimals;
  const paidTo = tx.tokens?.find(({ account }) => account === payee)?.owner ?? (held === null || held.data.length < 64 ? undefined : getAddressDecoder().decode(held.data.subarray(32, 64)));
  return {
    ...common,
    ...(paidTo === undefined ? {} : { paid_to: paidTo }),
    payee,
    paid: formatAmount(fields["net"] as bigint, decimals),
  };
}
