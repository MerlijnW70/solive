import { type Address, getAddressDecoder } from "@solana/kit";
import { type EngineEvent, formatAmount, IntentStatus, Kind, NATIVE_MINT } from "@intent-engine/core";
import { findIntentPda, MAX_RECIPIENTS } from "@intent-engine/core/internal";
import { type Transport } from "@intent-engine/client";
import { intentAt, memoized, mintOf, paidWalletsOf, unmemoized } from "@intent-engine/client/internal";
import { InvalidInput } from "../schema.js";
import { deliveryReleased, releaseStanding, standingOutput } from "./standing.js";
import { type AgentContext, define } from "../actions.js";
import { tool } from "../names.js";
import { AgentRefusal } from "../problems.js";
import { account, amount, flag, integer, list, object, optional, text } from "../schema.js";
import { WAIT_MAX, signerOf, sha256Of } from "./guard.js";
import { NO_CLOCK, poll } from "./wait.js";
import { RESULT_MEANS } from "./attest.js";
import { RELEASE_UNKNOWN, outlives, releaseLookup, namedRelease, releasedMint, createdMint, heldMint } from "./releases.js";
import { eventsIn, SOL_DECIMALS, STAKE_TO_WORKER } from "./history-work.js";

export const NOT_RELEASED = "no release of this escrow is in its history yet; check again later";

export const RELEASE_INPUT = "the release's transaction signature, as the attestor's release returned it; with it the release is read from that one transaction, with no search of the escrow's history";

const BASE58_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/;

export const RELEASE_SIGNATURE = "must be a base58 transaction signature";

export function releaseOf(signature: string | undefined): string | undefined {
  if (signature !== undefined && !BASE58_SIGNATURE.test(signature)) {
    throw new InvalidInput([{ path: "release", message: RELEASE_SIGNATURE }]);
  }
  return signature;
}

export const otherLifecycle = (release: string, intent: string) =>
  `the release ${release} belongs to an earlier lifecycle of the escrow address ${intent}, which was closed and made again at the same nonce since, so it is not a release of the escrow there now; leave release out to read the current one`;

export const COVERAGE_UNPROVABLE =
  "this transport cannot report the first slot its RPC node keeps, so it cannot prove that the history read reaches back to the escrow's creation and an escrow without a release found reads as unknown rather than not released";

export const coverageOf = (transport: Transport, text: string): string => (transport.firstAvailableSlot === undefined ? `${text}; ${COVERAGE_UNPROVABLE}` : text);

export const PAID_WRAPPED = `paid as wrapped SOL; ${tool("wallet_unwrap")} turns it into plain SOL`;

export const RECEIPT_PARTIAL =
  "the escrow's history around this release could not be read in full: it is longer than the pages read or the RPC node could not return some of its transactions yet, so the escrow address may have been made again since; pass release, the signature the release returned, or call again in a few seconds";

export const stillUnreleased = (name: string) => `not released yet; call ${tool(name)} again with wait, in seconds, to wait for the release`;

export const ALSO_MAX = 9;

export const noneReleased = (name: string, count: number) => `none of the ${count} escrows is released yet; call ${tool(name)} again with wait, in seconds, to wait for the first release`;

export const noneKnown = (name: string, count: number) =>
  `no release of the ${count} escrows was found, but the history of some could not be read in full, so whether they were released is unknown; call ${tool(name)} again in a few seconds, or read each alone`;

export const RELEASE_LANDING =
  "the escrow is marked released on chain, but the RPC node has not returned the release transaction yet, so who it paid is not known; call again in a few seconds";

export const stillUnknown = (name: string) =>
  `the RPC node had not returned the escrow's release when the wait ran out, so whether and how it was paid is still unknown; call ${tool(name)} again with wait in a few seconds`;

export { NO_CLOCK } from "./wait.js";

const waitInput = optional(integer(1, WAIT_MAX, "most seconds to wait for a release; without it, the tool reads once"));

const alsoInput = optional(
  list(
    object({ owner: account("the wallet that made this escrow"), nonce: amount("this escrow's nonce") }),
    ALSO_MAX,
    `up to ${ALSO_MAX} more escrows, each by owner and nonce, read with the one nonce names; the result is the first released, and its owner and nonce say which, and escrows gives the state of each; sha256 and release apply only to the one nonce names`,
  ),
);

type Paid = { released: boolean; paid_to?: Address | undefined; paid_wallets?: readonly Address[] | undefined };

type EscrowState = Paid & { owner: Address; nonce: bigint; intent: Address; complete?: false; paid_this_wallet?: boolean };

type Receipt = Awaited<ReturnType<typeof escrowReceipt>> & { owner?: Address; nonce?: bigint; escrows?: EscrowState[]; paid_this_wallet?: boolean };

type Escrow = { owner: Address; nonce: bigint; sha256?: string | undefined; release?: string | undefined };

const unknownIn = (receipt: Receipt): boolean => "complete" in receipt && receipt.complete === false;

const paidWalletsIn = (paid: Paid): readonly Address[] | undefined => (!paid.released ? undefined : paid.paid_to !== undefined ? [paid.paid_to] : paid.paid_wallets);

const stateOf = ({ owner, nonce }: Escrow, receipt: Receipt): EscrowState => {
  const paid: Paid = receipt;
  return {
    owner,
    nonce,
    intent: receipt.intent,
    released: receipt.released,
    ...(unknownIn(receipt) ? { complete: false as const } : {}),
    ...(!paid.released ? {} : paid.paid_to !== undefined ? { paid_to: paid.paid_to } : paid.paid_wallets !== undefined ? { paid_wallets: paid.paid_wallets } : {}),
  };
};

async function firstReleased(transport: Transport, escrows: readonly Escrow[]): Promise<Receipt> {
  const read: Receipt[] = [];
  for (const { owner, nonce, sha256, release } of escrows) {
    read.push(await escrowReceipt(transport, owner, nonce, sha256, release));
  }
  const [first] = read as [Receipt];
  if (escrows.length === 1) {
    return first;
  }
  const states = escrows.map((escrow, at) => stateOf(escrow, read[at] as Receipt));
  const at = read.findIndex(({ released }) => released);
  const escrow = escrows[at];
  if (escrow !== undefined) {
    return { ...(read[at] as Receipt), owner: escrow.owner, nonce: escrow.nonce, escrows: states };
  }
  return read.some(unknownIn) ? { intent: first.intent, released: false, complete: false, next: "", escrows: states } : { ...first, escrows: states };
}

export const paidOther = (wallets: readonly Address[], self: Address) =>
  `this release paid ${wallets.join(", ")}, not this wallet ${self}: matches and valid describe the recorded work, and this wallet was not paid for it`;

function forWallet(receipt: Receipt, self: Address): Receipt {
  const paid = (state: Paid): { paid_this_wallet?: boolean } => {
    const wallets = paidWalletsIn(state);
    return wallets === undefined ? {} : { paid_this_wallet: wallets.includes(self) };
  };
  const escrows = receipt.escrows?.map((state) => ({ ...state, ...paid(state) }));
  const own = paid(receipt);
  const wallets = paidWalletsIn(receipt);
  const shown = { ...receipt, ...own, ...(escrows === undefined ? {} : { escrows }) };
  if (own.paid_this_wallet !== false || wallets === undefined) {
    return shown;
  }
  const prior: unknown = "next" in receipt ? receipt.next : undefined;
  const line = paidOther(wallets, self);
  return { ...shown, next: typeof prior === "string" && prior !== "" ? `${line}; ${prior}` : line };
}

async function waitedReceipt(ctx: AgentContext, name: string, wait: number | undefined, escrows: readonly Escrow[]): Promise<Receipt> {
  const many = escrows.length > 1;
  const told = (last: Receipt): Receipt =>
    last.released
      ? last
      : unknownIn(last)
        ? many
          ? { ...last, next: noneKnown(name, escrows.length) }
          : wait === undefined
            ? last
            : { ...last, next: stillUnknown(name) }
        : { ...last, next: many ? noneReleased(name, escrows.length) : stillUnreleased(name) };
  if (wait === undefined) {
    return told(await firstReleased(ctx.transport, escrows));
  }
  const clock = ctx.wallet ?? ctx.clock;
  if (clock === undefined) {
    throw new AgentRefusal("NoClock", NO_CLOCK);
  }
  const fresh = unmemoized(ctx.transport);
  let receipt: Receipt | undefined;
  await poll(clock, wait, async () => {
    receipt = await firstReleased(memoized(fresh), escrows);
    return receipt.released;
  });
  return told(receipt as Receipt);
}

const escrowsOf = (first: Escrow, also: readonly Escrow[] | undefined): Escrow[] => [first, ...(also ?? [])];

const receiptOutput = object({
  intent: account(),
  released: flag(),
  complete: optional(
    flag(
      "false when the history read was not enough: with released false, no release was found in it, so released is unknown rather than known; with released true, a later lifecycle of the escrow address may be missing from it",
    ),
  ),
  paid_to: optional(account("the wallet the release paid, the pay_to its attestor gave; it owns payee")),
  payee: optional(account("a token account, not a wallet: the one the tokens landed in, owned by paid_to; for SOL it holds wrapped SOL")),
  paid: optional(text("whole tokens paid into the payee token account")),
  stake_returned: optional(text("whole SOL of the job's claim stake that went back to stake_returned_to, the worker who held the claim, at or after the release")),
  stake_returned_to: optional(account("the wallet the claim stake returned to")),
  mint: optional(account("the token the release paid")),
  attestor: optional(account()),
  result: optional(amount(RESULT_MEANS)),
  recipients: optional(amount("how many co-authors a split release paid")),
  signature: optional(text("the release's transaction")),
  delivered_sha256: optional(text("the sha256 of the work the release paid for, which the program checked against the paid announcement")),
  matches: optional(flag("whether sha256 equals the paid one")),
  delivered_salt: optional(text("the paid announcement's salt, public once a release records it")),
  ...standingOutput,
  paid_wallets: optional(list(account(), MAX_RECIPIENTS, "the wallets a split release paid")),
  paid_this_wallet: optional(flag("wallet_receipt with a released escrow whose payees are known: whether the release paid this server's wallet")),
  owner: optional(account("given with also: the owner of the escrow released")),
  nonce: optional(amount("given with also: the nonce of the escrow released")),
  escrows: optional(
    list(
      object({
        owner: account(),
        nonce: amount(),
        intent: account(),
        released: flag(),
        complete: optional(flag("false when the history read was not enough to know whether it was released")),
        paid_to: optional(account("the wallet the release paid")),
        paid_wallets: optional(list(account(), MAX_RECIPIENTS, "the wallets a split release paid")),
        paid_this_wallet: optional(flag("wallet_receipt only: whether the release paid this server's wallet")),
      }),
      ALSO_MAX + 1,
      "given with also: every named escrow in the order given, released or not, with whom each release paid",
    ),
  ),
  next: optional(text()),
});

export const walletReceipt = define({
  name: tool("wallet_receipt"),
  title: "Check an escrow release",
  description: `Shows whether an escrow was released: to whom, for how much, by which attestor (judge), and which work it recorded. A worker passes the job's owner and nonce from ${tool("wallet_deliver")}, and in also up to ${ALSO_MAX} more jobs. Give sha256 to check the paid work. Pass wait, in seconds, to wait for the first release. It sends nothing.`,
  effect: "read",
  input: object({
    owner: optional(account("the wallet that made the escrow; default this server's wallet")),
    nonce: amount("the escrow intent's nonce"),
    sha256: optional(text("the sha256, as 64 hex digits, of the work, to compare with the one the release recorded")),
    release: optional(text(RELEASE_INPUT)),
    wait: waitInput,
    also: alsoInput,
  }),
  output: receiptOutput,
  run: async (ctx: AgentContext, input) => {
    const self = (await signerOf(ctx)).address;
    const escrows = escrowsOf({ owner: input.owner ?? self, nonce: input.nonce, sha256: input.sha256, release: input.release }, input.also);
    const receipt = forWallet(await waitedReceipt(ctx, "wallet_receipt", input.wait, escrows), self);
    const wrapped = "paid_to" in receipt && receipt.paid_to === self && receipt.mint === NATIVE_MINT;
    if (!wrapped) {
      return receipt;
    }
    const prior: unknown = "next" in receipt ? receipt.next : undefined;
    const next = typeof prior === "string" ? `${prior}; ${PAID_WRAPPED}` : PAID_WRAPPED;
    return { ...receipt, next };
  },
});

export const getReceipt = define({
  name: tool("get_receipt"),
  title: "Check any owner's escrow release",
  description: `Look up whether an escrow was released: to whom, for how much, by which attestor, and which delivered work the release recorded. Give sha256, the hash of the work you received, to check it is the work that was paid for, and release, the signature the release returned, to read the release from that one transaction however long the escrow's history grew. It reads the escrow's own transactions, sends nothing and needs no wallet. Pass wait, in seconds, to wait for the release, and in also up to ${ALSO_MAX} more escrows by owner and nonce, to wait for the first release among them.`,
  effect: "read",
  input: object({
    owner: account("the wallet that made the escrow"),
    nonce: amount("the escrow intent's nonce"),
    sha256: optional(text("the sha256, as 64 hex digits, of the work you received, to compare with the one the release recorded")),
    release: optional(text(RELEASE_INPUT)),
    wait: waitInput,
    also: alsoInput,
  }),
  output: receiptOutput,
  run: async (ctx: AgentContext, input) =>
    waitedReceipt(ctx, "get_receipt", input.wait, escrowsOf({ owner: input.owner, nonce: input.nonce, sha256: input.sha256, release: input.release }, input.also)),
});

export async function escrowReceipt(transport: Transport, owner: Address, nonce: bigint, sha256: string | undefined, releaseSignature?: string) {
  const wanted = sha256 === undefined ? undefined : sha256Of(sha256, "sha256");
  const named = releaseOf(releaseSignature);
  const [intent] = await findIntentPda({ owner, nonce });
  const lookup = named === undefined ? await releaseLookup(transport, intent) : await namedRelease(transport, intent, named);
  const { release, transactions, complete, bound, creation } = lookup;
  if (release === null) {
    const held = await intentAt(transport, intent);
    if (held !== null && held.kind === Kind.AttestedResult && held.status === IntentStatus.Filled) {
      return { intent, released: false, complete: false, next: RELEASE_LANDING };
    }
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
  const paidWork = deliveryReleased(tx, intent);
  const standing = paidWork === null ? {} : await releaseStanding(transport, intent, paidWork);
  const stake = eventsIn([tx, ...transactions]).find(
    (event) => event.name === "StakeMoved" && event.fields.intent === intent && event.fields.role === STAKE_TO_WORKER && event.slot >= tx.slot,
  );
  const returned = stake?.name === "StakeMoved" ? { stake_returned: formatAmount(stake.fields.amount, SOL_DECIMALS), stake_returned_to: stake.fields.to } : {};
  const common = {
    intent,
    released: true,
    ...returned,
    ...(complete && bound ? {} : { complete: false, next: RECEIPT_PARTIAL }),
    attestor: fields["attestor"] as Address,
    result: fields["result"] as bigint,
    signature: tx.signature,
    ...(paidWork === null ? {} : { delivered_sha256: paidWork.sha256, delivered_salt: paidWork.salt }),
    ...(wanted === undefined ? {} : { matches: wanted === paidWork?.sha256 }),
    ...standing,
  };
  if (release.event.name === "IntentSplit") {
    mint ??= await heldMint(transport, intent);
    const decimals = mint === undefined ? undefined : (await mintOf(transport, mint)).decimals;
    const wallets = await paidWalletsOf(transport, { event: release.event as EngineEvent, transaction: tx }, intent);
    return {
      ...common,
      paid: formatAmount(fields["net"] as bigint, decimals),
      ...(mint === undefined ? {} : { mint }),
      recipients: BigInt(fields["recipients"] as number),
      ...(wallets === null ? {} : { paid_wallets: wallets }),
    };
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
    ...(mint === undefined ? {} : { mint }),
  };
}
