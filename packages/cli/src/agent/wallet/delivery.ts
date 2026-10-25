import { type Address, createNoopSigner, getBase16Decoder, type TransactionSigner } from "@solana/kit";
import { IntentStatus, Kind } from "@intent-engine/core";
import { decodeParams, getIntentDecoder, getIntentDiscriminatorBytes, getIntentSize, INTENT_ENGINE_PROGRAM_ADDRESS, isMemoUrl, MEMO_URL_RULE, saltMessage } from "@intent-engine/core/internal";
import {
  type AnnounceInput,
  type AnnouncementList,
  type AnnouncementPlan,
  ConfirmMismatch,
  isSdkError,
  NoMessageSigner,
  NotDeliverable,
  type SecretInput,
} from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import { chainTime, confirmOnBoth, type ConfirmTarget, loadAnnouncement, memoized, secretInputOf, unmemoized } from "@intent-engine/client/internal";
import { ANNOUNCE_FIRST, announcementLine, sealedToText, walletOf } from "../../announcement-views.js";
import { execute } from "../../flows.js";
import { deliverNotInvited, sealedInvites } from "../../invites.js";
import { type AgentContext, define } from "../actions.js";
import type { Call } from "../claims.js";
import { claimOf, deliverClaimWarnings } from "../job-claims.js";
import { tool } from "../names.js";
import { prepare } from "../prepare.js";
import { AgentRefusal, untrusted } from "../problems.js";
import { account, amount, flag, InvalidInput, integer, list, object, optional, text, time } from "../schema.js";
import { preparedSchema, preparedView } from "../shapes.js";
import { creatorOf } from "./releases.js";
import { deviceOutput, PREVIEW_FIRST, PREVIEW_ONLY, sent, sha256Of, signerOf, WAIT_MAX } from "./guard.js";
import { NO_CLOCK, poll } from "./wait.js";

export { ANNOUNCE_FIRST } from "../../announcement-views.js";

export const UNGUESSABLE_URL =
  "without private hosting, use a public host under a long random path or file name, such as 32 random hex characters, so nobody can guess it, and announce right after hosting";

export const DELIVER_NEXT = `${PREVIEW_ONLY}; the commitment is shown only, never passed back`;

export const SYNC_FIRST = "the committee's key snapshot is out of date, so this sends the key sync first and then the announcement";

export const ALREADY_ANNOUNCED = "this work is already announced to this escrow with this url; nothing was sent";

export const DELIVERED_NEEDED = "a proof escrow pays the first announcement that opens to the work it releases for, so give that work's sha256";

export const MAX_LISTED = 64;

export const notAttestor = (attestor: string) => `this intent names ${attestor} as its attestor, not this server's wallet; only that key can release it`;

export const escrowClosed = (intent: Address, owner: Address, nonce: bigint, receipt: string) =>
  `the escrow ${intent} is closed: it was released, cancelled or expired; call ${tool(receipt)} with owner ${owner} and nonce ${nonce} to see whether it was released and to whom`;

export const noEscrow = (intent: Address, receipt: string) =>
  `no intent ${intent}: it was never made, or it was settled and closed; ${tool(receipt)} with the escrow's owner and nonce shows whether it was released and to whom`;

export async function proofEscrow(ctx: AgentContext, intent: Address, receipt: string) {
  const view = await ctx.transport.getAccount(intent);
  const tag = getIntentDiscriminatorBytes();
  const held =
    view === null || view.owner !== INTENT_ENGINE_PROGRAM_ADDRESS || view.data.length !== getIntentSize() || !tag.every((b, i) => view.data[i] === b)
      ? null
      : getIntentDecoder().decode(view.data);
  if (held === null) {
    const creator = view === null ? await creatorOf(ctx.transport, intent) : null;
    throw new AgentRefusal("NotFound", creator === null ? noEscrow(intent, receipt) : escrowClosed(intent, creator.owner, creator.nonce, receipt));
  }
  const params = decodeParams(held.kind, Uint8Array.from(held.params));
  if (params.kind !== Kind.AttestedResult || params.specHash.every((b) => b === 0)) {
    throw new AgentRefusal("NotAProof", "this intent is not a proof escrow: an attested escrow that commits a spec hash");
  }
  return { held, params };
}

export async function confirmedRelease(ctx: AgentContext, target: ConfirmTarget): Promise<void> {
  if (ctx.confirm === undefined) {
    return;
  }
  try {
    await confirmOnBoth(ctx.transport, ctx.confirm, target);
  } catch (error) {
    if (isSdkError(error, "confirm-mismatch")) {
      throw new AgentRefusal("ConfirmMismatch", error.field === "second node" ? untrusted(error.message) : error.message);
    }
    throw error;
  }
}

export const signSalt = (intent: Address, sha256: string): string =>
  `the worker's ed25519 signature of the message ${Buffer.from(saltMessage(intent, sha256)).toString("hex")}, as 128 hex digits; the salt and sealing keys are derived from it, so sign it with the worker's key, the same way each time`;

type Announcing = Omit<AnnounceInput, keyof SecretInput | "intent"> & { intent: Address; worker: TransactionSigner; saltSignature?: Uint8Array };

async function planOf(ctx: AgentContext, input: Announcing, saltHint = false): Promise<AnnouncementPlan> {
  const { worker, saltSignature, ...rest } = input;
  try {
    return await createClient({ url: ctx.url ?? "", transport: ctx.transport }).plan.announce({ ...rest, ...secretInputOf(worker, { saltSignature }) });
  } catch (error) {
    if (isSdkError(error, "bad-salt-signature")) {
      throw new InvalidInput([{ path: "salt_signature", message: error.message }]);
    }
    if (isSdkError(error, "no-message-signer")) {
      throw new AgentRefusal("NoMessageSigner", saltHint && input.saltSignature === undefined ? `${error.message}; or pass salt_signature: ${signSalt(input.intent, input.sha256)}` : error.message);
    }
    if (isSdkError(error, "not-deliverable")) {
      throw new AgentRefusal("NotDeliverable", error.message);
    }
    if (isSdkError(error, "url-too-long") || isSdkError(error, "invalid-input")) {
      throw new InvalidInput([{ path: "url", message: error.message }]);
    }
    throw error;
  }
}

function announcing(plan: AnnouncementPlan, sha256: string, url: string, from: string): string[] {
  return [
    `Announces: the work with sha256 ${sha256} to the proof escrow ${plan.intent} in ${plan.announcement}, whose commitment ${plan.commitment} binds it to ${from} and a salt only its key derives`,
    `Seals: the salt and the url ${url} to ${sealedToText(plan.sealedTo)}, so only they can open it`,
    `Pays: the announcement's rent and the transaction fee from ${from}; the rent returns when the announcement closes, and no tokens move`,
    ...(plan.setup.length === 0 ? [] : [`Syncs first, in its own transaction: the key snapshot of committee ${plan.attestor}`]),
  ];
}

const announcedOutput = {
  intent: account(),
  attestor: account("the escrow's judge or committee, which the work is sealed to"),
  announcement: account("the announcement account this delivery makes"),
  sha256: text(),
  url: text(),
  commitment: text("64 hex: binds the work's sha256 to the announcing wallet and its salt; the chain holds it in place of the hash"),
  sealed_to: list(account(), 8, "the wallets whose keys open the sealed url"),
  summary: list(text(), 8),
  warnings: list(text(), 8),
};

export const walletDeliver = define({
  name: tool("wallet_deliver"),
  title: "Announce delivered work to a judge",
  description: `Tells a job's judge the work is done: one on-chain announcement that commits to the work's sha256 with the url sealed to the judge; no tokens move. Host the work at a url nobody can guess and announce right after hosting. ${PREVIEW_FIRST}`,
  effect: "submit",
  repeats: true,
  input: object({
    intent: account("the proof escrow's intent address"),
    sha256: text("the sha256 of the delivered work, as 64 hex digits; the judge releases for this same value, passed as delivered_sha256"),
    url: text(`where the judge fetches the work, ${MEMO_URL_RULE}; ${UNGUESSABLE_URL}`),
    send: optional(flag("true signs and sends; leave out to preview")),
  }),
  output: object({
    ...announcedOutput,
    owner: account("the wallet that made the escrow, for the receipt"),
    nonce: amount("the escrow intent's nonce, for the receipt"),
    seq: optional(amount("the announcement's place among the escrow's announcements; a release pays the first that opens to the work")),
    ...deviceOutput,
    sent: flag(),
    signature: optional(text()),
    next: optional(text()),
  }),
  run: async (ctx: AgentContext, input, call: Call) => {
    const signer = await signerOf(ctx);
    const sha256 = sha256Of(input.sha256, "sha256");
    if (!isMemoUrl(input.url)) {
      throw new InvalidInput([{ path: "url", message: `must be ${MEMO_URL_RULE}` }]);
    }
    const { held } = await proofEscrow(ctx, input.intent, "wallet_receipt");
    const announce: Announcing = { worker: signer, intent: input.intent, sha256, url: input.url };
    const plan = await planOf(ctx, announce);
    const invited = await sealedInvites(ctx.transport, ctx.fetch ?? fetch, input.intent);
    const shown = {
      intent: input.intent,
      owner: held.owner,
      nonce: held.nonce,
      attestor: plan.attestor,
      announcement: plan.announcement,
      sha256,
      url: input.url,
      commitment: plan.commitment,
      sealed_to: plan.sealedTo.map(walletOf),
      summary: announcing(plan, sha256, input.url, "this wallet"),
      warnings: [
        ...(invited === undefined || invited.includes(signer.address) ? [] : [deliverNotInvited(signer.address, input.intent)]),
        ...deliverClaimWarnings(await claimOf(ctx.transport, input.intent), signer.address),
        ANNOUNCE_FIRST,
      ],
    };
    if (plan.existing !== null) {
      return { ...shown, seq: plan.existing.seq, sent: false, next: ALREADY_ANNOUNCED };
    }
    const first = plan.setup.length > 0 ? plan.setup : plan.instructions;
    const view = { ...shown, prepared: preparedView(await prepare(ctx.transport, first, signer.address)) };
    const done = await sent(ctx, signer, view, input.send, call, {
      preview: plan.setup.length > 0 ? `${DELIVER_NEXT}; ${SYNC_FIRST}` : DELIVER_NEXT,
      done: `announced to ${plan.attestor}; ${tool("wallet_receipt")} with owner ${held.owner} and nonce ${held.nonce} shows when it is paid; give it wait, in seconds, to wait for the pay`,
    });
    if (!("signature" in done)) {
      return done;
    }
    if (plan.setup.length > 0) {
      const after = await planOf(ctx, announce);
      const announced = preparedView(await prepare(ctx.transport, after.instructions, signer.address));
      const signature = await execute(ctx.transport, announced, signer);
      const found = await loadAnnouncement(ctx.transport, after.announcement);
      return { ...done, signature, ...(found === null ? {} : { seq: found.seq }) };
    }
    const found = await loadAnnouncement(ctx.transport, plan.announcement);
    return { ...done, ...(found === null ? {} : { seq: found.seq }) };
  },
});

const listedItem = object({
  announcement: account(),
  seq: amount("its place among the escrow's announcements, from 1"),
  worker: account("the announcing wallet, which a release of this announcement pays"),
  state: text("announced, or paid once a release paid it"),
  commitment: text("64 hex: binds the work's sha256 to the worker and its salt"),
  slot: amount("the slot it landed in"),
  announced_at: time("unix seconds it landed"),
  paid_at: optional(time("unix seconds a release paid it")),
});

function listOutput(own: boolean) {
  return object({
    intent: account(),
    owner: account(),
    nonce: amount(),
    spec_hash: text("64 hex: the sha256 of the acceptance spec the escrow commits"),
    open: flag("whether the escrow can still be released"),
    complete: flag("whether every announcement from seq 1 on is listed; a release is refused while it is false"),
    closed: flag("true once the escrow is no longer open or its delivery book is gone, so earlier announcements may have closed"),
    next_seq: amount("the seq the next announcement gets"),
    missing: list(amount(), 16, "seqs below next_seq that the RPC node did not list"),
    announcements: list(listedItem, MAX_LISTED, "in seq order; a release pays the first that opens to the work it pays for"),
    ...(own
      ? {
          mine: optional(
            list(
              object({ announcement: account(), seq: amount(), state: text(), earlier: integer(0, Number.MAX_SAFE_INTEGER, "how many announcements by other wallets came before it") }),
              MAX_LISTED,
              "this wallet's announcements to the escrow",
            ),
          ),
        }
      : {}),
  });
}

async function listOf(ctx: AgentContext, intent: Address, receipt: string, self?: Address) {
  const { held, params } = await proofEscrow(ctx, intent, receipt);
  const open = held.status === IntentStatus.Open && held.expiresAt > (await chainTime(ctx.transport));
  const list: AnnouncementList = await createClient({ url: ctx.url ?? "", transport: ctx.transport }).announcements(intent);
  const shown = list.announcements.slice(0, MAX_LISTED);
  const mine =
    self === undefined
      ? undefined
      : list.announcements
          .filter(({ worker }) => worker === self)
          .map((a) => ({ announcement: a.address, seq: a.seq, state: a.state, earlier: list.announcements.filter((b) => b.seq < a.seq && b.worker !== self).length }));
  return {
    intent,
    owner: held.owner,
    nonce: held.nonce,
    spec_hash: getBase16Decoder().decode(params.specHash).toLowerCase(),
    open,
    complete: list.complete,
    closed: list.closed,
    next_seq: list.nextSeq,
    missing: list.missing,
    announcements: shown.map(announcementLine),
    ...(mine === undefined ? {} : { mine }),
  };
}

type Listed = Awaited<ReturnType<typeof listOf>>;

async function newAnnouncements(ctx: AgentContext, intent: Address, wait: number, self: Address): Promise<Listed> {
  const clock = ctx.wallet ?? ctx.clock;
  if (clock === undefined) {
    throw new AgentRefusal("NoClock", NO_CLOCK);
  }
  const fresh = unmemoized(ctx.transport);
  let known: bigint | undefined;
  let listed: Listed | undefined;
  await poll(clock, wait, async () => {
    listed = await listOf({ ...ctx, transport: memoized(fresh) }, intent, "wallet_receipt", self);
    const before = known;
    known = listed.next_seq;
    return before !== undefined && listed.next_seq > before;
  });
  return listed as Listed;
}

export const walletCheckDelivery = define({
  name: tool("wallet_check_delivery"),
  title: "List the work announced to a proof escrow",
  description: `Lists a proof escrow's announcements in seq order, read from accounts, and this wallet's own with how many came before each. Pass wait, in seconds, for a new one. A judge opens and fetches work with ${tool("wallet_fetch_work")}.`,
  effect: "read",
  input: object({
    intent: account("the proof escrow's intent address"),
    wait: optional(integer(1, WAIT_MAX, "most seconds to wait for an announcement newer than those listed now; without it, the tool reads once")),
  }),
  output: listOutput(true),
  run: async (ctx: AgentContext, input) => {
    const self = (await signerOf(ctx)).address;
    return input.wait === undefined ? listOf(ctx, input.intent, "wallet_receipt", self) : newAnnouncements(ctx, input.intent, input.wait, self);
  },
});

export const checkDelivery = define({
  name: tool("check_delivery"),
  title: "List the work announced to a proof escrow",
  description: `List a proof escrow's announcements in seq order, read from accounts: each worker, commitment and state, and whether the list is complete. Each hides the work's sha256 in its commitment and seals its url to the judge. This tool fetches and opens nothing and needs no wallet.`,
  effect: "read",
  input: object({ intent: account("the proof escrow's intent address") }),
  output: listOutput(false),
  run: async (ctx: AgentContext, input) => listOf(ctx, input.intent, "get_receipt"),
});

export const prepareDeliver = define({
  name: tool("prepare_deliver"),
  title: "Prepare a delivery announcement",
  description: `Build the transaction in which a worker announces work to a proof escrow, such as one found with ${tool("find_jobs")}: one announcement that commits to the work's sha256 and seals the url to the judge. It moves no tokens; the worker pays its rent and fee. Returns an unsigned transaction that already simulated; the worker's wallet signs and sends it. A release pays the first announcement that opens to the work, so host it where nobody can guess, give its exact sha256 and send promptly.`,
  effect: "prepare",
  input: object({
    worker: account("the wallet that announces, signs, pays and is paid if a release pays this announcement"),
    intent: account("the proof escrow's intent address"),
    sha256: text("the sha256 of the delivered work, as 64 hex digits"),
    url: text(`where the judge fetches the work, ${MEMO_URL_RULE}`),
    salt_signature: optional(text("the worker's ed25519 signature, as 128 hex digits, of the salt message a call without it names")),
  }),
  output: object({
    ...announcedOutput,
    sync_first: flag("true when prepared is the committee key sync; send it, then call again for the announcement"),
    prepared: preparedSchema,
    next: text(),
  }),
  run: async (ctx: AgentContext, input) => {
    const sha256 = sha256Of(input.sha256, "sha256");
    if (!isMemoUrl(input.url)) {
      throw new InvalidInput([{ path: "url", message: `must be ${MEMO_URL_RULE}` }]);
    }
    const saltSignature = input.salt_signature === undefined ? undefined : signatureOf(input.salt_signature);
    const worker = createNoopSigner(input.worker);
    const plan = await planOf(ctx, { worker, intent: input.intent, sha256, url: input.url, ...(saltSignature === undefined ? {} : { saltSignature }) }, true);
    const syncFirst = plan.setup.length > 0;
    return {
      intent: input.intent,
      attestor: plan.attestor,
      announcement: plan.announcement,
      sha256,
      url: input.url,
      commitment: plan.commitment,
      sealed_to: plan.sealedTo.map(walletOf),
      summary: announcing(plan, sha256, input.url, input.worker),
      warnings: [ANNOUNCE_FIRST],
      sync_first: syncFirst,
      prepared: preparedView(await prepare(ctx.transport, syncFirst ? plan.setup : plan.instructions, input.worker)),
      next: syncFirst ? "sign and send this key sync, then call again for the announcement" : "sign with the worker's wallet and send",
    };
  },
});

function signatureOf(text: string): Uint8Array {
  if (!/^[0-9a-fA-F]{128}$/.test(text)) {
    throw new InvalidInput([{ path: "salt_signature", message: "give the signature as 128 hex digits" }]);
  }
  return Uint8Array.from(Buffer.from(text, "hex"));
}
