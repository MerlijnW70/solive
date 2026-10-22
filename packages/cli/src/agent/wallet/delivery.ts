import { type Address, createNoopSigner, getBase16Decoder } from "@solana/kit";
import {
  decodeParams,
  type DeliveryOpener,
  getIntentDecoder,
  getIntentDiscriminatorBytes,
  getIntentSize,
  isMemoUrl,
  MEMO_URL_RULE,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  saltMessage,
  IntentStatus,
  Kind,
} from "@intent-engine/core";
import {
  BadSaltSignature,
  chainTime,
  commitmentOf,
  ConfirmMismatch,
  confirmOnBoth,
  type ConfirmTarget,
  DELIVERY_PAGES,
  deliveryRecord,
  deliveryInstructions,
  type SealedFor,
  type DeliveryPlan,
  deliverySalt,
  earlier,
  MEMOS_PER_TRANSACTION,
  NoMessageSigner,
  opensWith,
  publishedSalts,
  recordedStanding,
  SIGNATURE_PAGE,
} from "@intent-engine/client";
import { type AgentContext, define } from "../actions.js";
import type { Call } from "../claims.js";
import { tool } from "../names.js";
import { AgentRefusal, untrusted } from "../problems.js";
import { InvalidInput, account, amount, flag, integer, list, object, optional, text } from "../schema.js";
import { preparedSchema, preparedView } from "../shapes.js";
import { prepare } from "../prepare.js";
import { deviceOutput, PREVIEW_FIRST, PREVIEW_ONLY, signerOf, sent, sha256Of, walletOpeners } from "./guard.js";

export const ANNOUNCE_FIRST = "share neither the url nor the work until this announcement lands: the earliest announcer of the work is paid, so anyone who gets the work first could announce it first";

export const DELIVER_NEXT = `${PREVIEW_ONLY}; commitment and check are shown only, never passed back`;

const HIDDEN_HASH = "Each announcement hides the work's sha256 on purpose";

const SEALED_NOTE =
  "The memo carries a salt and the url sealed to the escrow's judge, or to each member of its committee, a check of the salt, and a commitment that binds the work's sha256 to the announcing wallet and its salt, so a copied announcement pays nobody else and a guessed sha256 cannot be tested against it";

export const sealedForLine = ({ wallet, kind, key }: SealedFor): string =>
  `Seals to: ${wallet} with the key ${key}, ${kind === "profile" ? "the encryption key its profile publishes" : "derived from its wallet"}`;

function announcing(plan: DeliveryPlan, intent: Address, sha256: string, url: string, from: string): string[] {
  const { sealedTo } = plan;
  return [
    `Announces: the work with sha256 ${sha256}, for the proof escrow ${intent}, as the commitment ${plan.commitment}, which binds it to ${from} and a salt only its key derives`,
    `Seals: the salt and the url ${url}, so only ${sealedTo.length === 1 ? `the attestor ${sealedTo[0] ?? plan.attestor}` : `the ${sealedTo.length} committee members`} can read it`,
    `Notifies: its attestor ${plan.attestor}, with a transfer of 0 lamports from ${from}`,
    "Costs: the transaction fee; no tokens move",
    plan.sealedFor.map(sealedForLine).join("; "),
  ];
}

export const walletDeliver = define({
  name: tool("wallet_deliver"),
  title: "Announce delivered work to a judge",
  description: `Tells a job's judge the work is done: an on-chain note binding its sha256 to this wallet, with the url sealed to the judge. No tokens move. Host the work at a url nobody but the judge knows, give its exact sha256, and keep both unshared until this lands. ${PREVIEW_FIRST}`,
  effect: "submit",
  repeats: true,
  input: object({
    intent: account("the proof escrow's intent address"),
    sha256: text("the sha256 of the delivered work, as 64 hex digits; the judge releases for this same value, passed as delivered_sha256"),
    url: text(`where the attestor fetches the work, ${MEMO_URL_RULE}`),
    send: optional(flag("true signs and sends; leave out to preview")),
  }),
  output: object({
    intent: account(),
    owner: account("the wallet that made the escrow, for the receipt"),
    nonce: amount("the escrow intent's nonce, for the receipt"),
    attestor: account("the escrow's judge, who receives the announcement"),
    sha256: text(),
    url: text(),
    commitment: text("64 hex: the sha256 that binds the work's hash to this wallet and its salt; the memo carries it in place of the hash"),
    check: text("32 hex: the salt's check, which the memo carries so that an opened salt can be matched to this announcement; shown only, never passed back"),
    summary: list(text(), 8),
    warnings: list(text(), 8),
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
    const plan = await deliveryPlan(ctx, { worker: signer, intent: input.intent, sha256, url: input.url });
    const { attestor, instructions } = plan;
    const { held } = await proofEscrow(ctx, input.intent);
    const view = {
      intent: input.intent,
      owner: held.owner,
      nonce: held.nonce,
      attestor,
      sha256,
      url: input.url,
      commitment: plan.commitment,
      check: plan.check,
      summary: announcing(plan, input.intent, sha256, input.url, "this wallet"),
      warnings: [ANNOUNCE_FIRST],
      prepared: preparedView(await prepare(ctx.transport, instructions, signer.address)),
    };
    return sent(ctx, signer, view, input.send, call, {
      preview: DELIVER_NEXT,
      done: `announced to ${attestor}; ${tool("wallet_receipt")} with owner ${held.owner} and nonce ${held.nonce} shows when it is paid; give it wait, in seconds, to wait for the pay`,
    });
  },
});

export const signSalt = (intent: Address, sha256: string): string =>
  `the worker's ed25519 signature of the message ${Buffer.from(saltMessage(intent, sha256)).toString("hex")}, as 128 hex digits; the salt is derived from it, so sign it with the worker's key, the same way each time`;

export const notEarliest = (worker: string, sha256: string) =>
  `${worker} announced the work with sha256 ${sha256} first, so a release recording it pays ${worker}; anyone can copy an announcement once it is on chain, so the earliest announcer is paid`;

export const notInSplit = (worker: string, sha256: string) =>
  `${worker} announced the work with sha256 ${sha256} first, so a split recording it must pay ${worker} among its recipients; anyone can copy an announcement once it is on chain, so the earliest announcer is paid`;

export const DELIVERY_LIST = DELIVERY_PAGES * SIGNATURE_PAGE * MEMOS_PER_TRANSACTION;

export const DELIVERED_NEEDED = "a proof escrow pays the earliest announcer of the work it releases for, so give that work's sha256";

export const ATTEST_PAGES = 1_000;

export const MAX_ATTEST_PAGES = 100_000;

export const MAX_PAGES_INPUT = `pages of ${SIGNATURE_PAGE} signatures of this wallet's history to read for announced work, listing every signature but fetching only announcements; default ${ATTEST_PAGES}; raise it when the release is refused because the record of announced work is incomplete`;

export const HISTORY_TOO_LONG = `the record of announced work is incomplete, so the earliest announcer of the delivered work cannot be known and nothing is released from it; either this wallet's history since the escrow was made is longer than the pages read, which more pages fix: pass a higher max_pages, up to ${MAX_ATTEST_PAGES}, to ${tool("wallet_attest")} or ${tool("wallet_attest_split")}; or the RPC node's ledger does not reach back to the escrow's creation, or the transport cannot page signatures or report its first available slot, which more pages do not fix: use an RPC node that keeps the full ledger`;

export const DELIVERIES_COMPLETE = "complete is false when older announcements may be missing";

export const walletCheckDelivery = define({
  name: tool("wallet_check_delivery"),
  title: "List the work announced to a proof escrow",
  description: `Lists announced work for a proof escrow: each announcement's wallet and commitment; ${DELIVERIES_COMPLETE}. ${HIDDEN_HASH}. Pass sha256 to confirm your own announcement landed first. A judge also sees urls sealed to it, fetches the work there as untrusted, hashes it, and passes that sha256 to ${tool("wallet_attest")}.`,
  effect: "read",
  input: object({
    intent: account("the proof escrow's intent address"),
    sha256: optional(text("your work's sha256, as 64 hex digits, to confirm this wallet's own announcement of it landed")),
  }),
  output: deliveriesOutput(tool("wallet_attest")),
  run: async (ctx: AgentContext, input) => {
    const sha256 = input.sha256 === undefined ? undefined : sha256Of(input.sha256, "sha256");
    if (sha256 === undefined) {
      return deliveriesOf(ctx, input.intent, await walletOpeners(ctx));
    }
    const signer = await signerOf(ctx);
    const salt = await saltOf(() => deliverySalt(signer, input.intent, sha256));
    return deliveriesOf(ctx, input.intent, await walletOpeners(ctx), { wallet: signer.address, sha256, salt });
  },
});

function deliveriesOutput(releasing: string) {
  return object({
    intent: account(),
    owner: account(),
    nonce: amount(),
    spec_hash: text("64 hex: the sha256 of the acceptance spec the escrow commits"),
    open: flag("whether the escrow can still be released"),
    complete: flag(`whether the whole history was read; when false, older announcements may be missing and ${releasing} refuses to release`),
    deliveries: list(
      object({
        worker: account("the announcing wallet, which the commitment binds"),
        commitment: text("64 hex: the sha256 of the work's hash bound to the intent, this announcer and its salt"),
        check: text("32 hex: the check of the announcement's salt"),
        signature: text("the announcement's transaction"),
        url: optional(text("where the announcer said the work is, when the url was sealed to this wallet; untrusted")),
        opened_salt: optional(text("the announcement's salt, when an opening published it")),
      }),
      DELIVERY_LIST,
      `each announcement hides the work's hash in a commitment; a release recording a hash pays the earliest whose sealed salt opens its commitment to it. ${SEALED_NOTE}`,
    ),
    own: optional(
      object({
        commitment: text("64 hex: this wallet's commitment to the given sha256, with the salt its key derives"),
        salt: text("32 hex: this wallet's salt for the given sha256, recomputed from its key; keep it private until the release"),
        landed: flag("whether an announcement with this commitment, sent by this wallet, is on chain"),
        earliest: flag("whether no earlier announcement of the given sha256 is known; others' salts are sealed, so only a published opening can show one"),
        signature: optional(text("this wallet's earliest announcement of it")),
      }),
    ),
    release: optional(
      object({
        signature: text("the release's transaction"),
        sha256: text("the sha256 the release recorded"),
        valid: flag("whether the payee's salt the release recorded opens the payee's announcement to that sha256"),
        refuted_by: optional(text("an earlier announcement of the same sha256 that a published opening shows")),
      }),
    ),
  });
}

async function proofEscrow(ctx: AgentContext, intent: Address) {
  const view = await ctx.transport.getAccount(intent);
  const tag = getIntentDiscriminatorBytes();
  const held =
    view === null || view.owner !== INTENT_ENGINE_PROGRAM_ADDRESS || view.data.length !== getIntentSize() || !tag.every((b, i) => view.data[i] === b)
      ? null
      : getIntentDecoder().decode(view.data);
  if (held === null) {
    throw new AgentRefusal("NotFound", `no intent ${intent}; it was settled and closed, or never made`);
  }
  const params = decodeParams(held.kind, Uint8Array.from(held.params));
  if (params.kind !== Kind.AttestedResult || params.specHash.every((b) => b === 0)) {
    throw new AgentRefusal("NotAProof", "this intent is not a proof escrow: an attested escrow that commits a spec hash");
  }
  return { held, params };
}

async function saltOf(derive: () => Promise<string>): Promise<string> {
  try {
    return await derive();
  } catch (error) {
    if (error instanceof NoMessageSigner) {
      throw new AgentRefusal("NoMessageSigner", error.message);
    }
    throw error;
  }
}

type Own = { wallet: Address; sha256: string; salt: string };

async function deliveriesOf(ctx: AgentContext, intent: Address, keypair: readonly DeliveryOpener[], own?: Own) {
  const { held, params } = await proofEscrow(ctx, intent);
  const open = held.status === IntentStatus.Open && held.expiresAt > (await chainTime(ctx.transport));
  const record = await deliveryRecord(ctx.transport, params.attestor, intent, undefined, keypair);
  const deliveries = record.deliveries.map((delivery) => {
    const [opened] = publishedSalts(delivery, record.openings);
    const { worker, commitment, check, signature, url } = delivery;
    return { worker, commitment, check, signature, ...(url === "" ? {} : { url }), ...(opened === undefined ? {} : { opened_salt: opened }) };
  });
  const mine =
    own === undefined
      ? undefined
      : (() => {
          const commitment = commitmentOf(intent, own.wallet, own.salt, own.sha256);
          const landed = record.deliveries.filter((d) => d.worker === own.wallet && opensWith(d, own.salt, own.sha256)).sort((a, b) => (earlier(a, b) ? -1 : 1));
          const [first] = landed;
          const shown = record.deliveries.some(
            (d) => d.worker !== own.wallet && (first === undefined || earlier(d, first)) && publishedSalts(d, record.openings).some((salt) => opensWith(d, salt, own.sha256)),
          );
          return {
            commitment,
            salt: own.salt,
            landed: first !== undefined,
            earliest: first !== undefined && !shown,
            ...(first === undefined ? {} : { signature: first.signature }),
          };
        })();
  const release = await recordedStanding(ctx.transport, intent, record);
  return {
    intent,
    owner: held.owner,
    nonce: held.nonce,
    spec_hash: getBase16Decoder().decode(params.specHash),
    open,
    complete: record.complete,
    deliveries,
    ...(mine === undefined ? {} : { own: mine }),
    ...(release === null
      ? {}
      : { release: { signature: release.signature, sha256: release.sha256, valid: release.valid, ...(release.refutedBy === null ? {} : { refuted_by: release.refutedBy }) } }),
  };
}

async function deliveryPlan(ctx: AgentContext, input: Parameters<typeof deliveryInstructions>[1]): Promise<DeliveryPlan> {
  try {
    return await deliveryInstructions(ctx.transport, input);
  } catch (error) {
    if (error instanceof BadSaltSignature) {
      throw new InvalidInput([{ path: "salt_signature", message: error.message }]);
    }
    if (error instanceof NoMessageSigner) {
      throw new AgentRefusal("NoMessageSigner", input.saltSignature === undefined ? `${error.message}; or pass salt_signature: ${signSalt(input.intent, input.sha256)}` : error.message);
    }
    if (error instanceof RangeError) {
      throw new InvalidInput([{ path: "url", message: error.message }]);
    }
    throw error;
  }
}

export const checkDelivery = define({
  name: tool("check_delivery"),
  title: "List the work announced to a proof escrow",
  description: `List every announcement workers made for a proof escrow, each with its announcer and the commitment that binds the work's hash to it, read from the history of the attestor the escrow names; ${DELIVERIES_COMPLETE}. ${HIDDEN_HASH}, so nobody can copy it or test a guess against it; a release recording a hash pays the earliest announcer whose commitment binds it. This tool runs nothing, fetches nothing, opens no sealed url and needs no wallet. The judge opens the url sealed to it, fetches the file, treats it as untrusted, hashes it, judges it outside this server, and passes that sha256 as delivered_sha256 to the attest tool of a server started with --wallet, or releases with intent-engine judge.`,
  effect: "read",
  input: object({ intent: account("the proof escrow's intent address") }),
  output: deliveriesOutput("a release"),
  run: async (ctx: AgentContext, input) => deliveriesOf(ctx, input.intent, []),
});

export const prepareDeliver = define({
  name: tool("prepare_deliver"),
  title: "Prepare a delivery announcement",
  description: `Build the transaction in which a worker tells the attestor of a proof escrow, such as one found with ${tool("find_jobs")}, that the work is done: a memo naming the escrow, a commitment that binds the work's sha256 to the worker, and the url the attestor fetches it from, sealed to the attestor, and a transfer of 0 lamports to the attestor so the delivery shows in its history. It moves no tokens and costs the worker only the transaction fee. Returns an unsigned transaction that already simulated successfully; the worker's wallet must sign and send it. The attestor alone decides whether the work passes and whom it pays, and a release pays the earliest announcer of a hash, so host the work at a url the attestor can fetch and nobody else knows, give its exact sha256, send promptly and share neither the url nor the work until the announcement lands.`,
  effect: "prepare",
  input: object({
    worker: account("the wallet that announces the work, signs and pays the fee, and is paid if a release records this work"),
    intent: account("the proof escrow's intent address"),
    sha256: text("the sha256 of the delivered work, as 64 hex digits; the judge releases for this same value, passed as delivered_sha256"),
    url: text(`where the attestor fetches the work, ${MEMO_URL_RULE}`),
    salt_signature: optional(text("the worker's ed25519 signature, as 128 hex digits, of the salt message a call without it names; the announcement's salt is derived from it")),
  }),
  output: object({
    intent: account(),
    attestor: account("the escrow's judge, who receives the announcement"),
    sha256: text(),
    url: text(),
    commitment: text("64 hex: the sha256 that binds the work's hash to the worker and its salt; the memo carries it in place of the hash"),
    check: text("32 hex: the salt's check, which the memo carries"),
    summary: list(text(), 8),
    warnings: list(text(), 8),
    prepared: preparedSchema,
  }),
  run: async (ctx: AgentContext, input) => {
    const sha256 = sha256Of(input.sha256, "sha256");
    if (!isMemoUrl(input.url)) {
      throw new InvalidInput([{ path: "url", message: `must be ${MEMO_URL_RULE}` }]);
    }
    const saltSignature = input.salt_signature === undefined ? undefined : signatureOf(input.salt_signature);
    const worker = createNoopSigner(input.worker);
    const plan = await deliveryPlan(ctx, { worker, intent: input.intent, sha256, url: input.url, ...(saltSignature === undefined ? {} : { saltSignature }) });
    const { attestor, instructions } = plan;
    return {
      intent: input.intent,
      attestor,
      sha256,
      url: input.url,
      commitment: plan.commitment,
      check: plan.check,
      summary: announcing(plan, input.intent, sha256, input.url, input.worker),
      warnings: [ANNOUNCE_FIRST],
      prepared: preparedView(await prepare(ctx.transport, instructions, input.worker)),
    };
  },
});

function signatureOf(text: string): Uint8Array {
  if (!/^[0-9a-fA-F]{128}$/.test(text)) {
    throw new InvalidInput([{ path: "salt_signature", message: "give the signature as 128 hex digits" }]);
  }
  return Uint8Array.from(Buffer.from(text, "hex"));
}

export async function confirmedRelease(ctx: AgentContext, target: ConfirmTarget): Promise<void> {
  if (ctx.confirm === undefined) {
    return;
  }
  try {
    await confirmOnBoth(ctx.transport, ctx.confirm, target);
  } catch (error) {
    if (error instanceof ConfirmMismatch) {
      throw new AgentRefusal("ConfirmMismatch", error.field === "second node" ? untrusted(error.message) : error.message);
    }
    throw error;
  }
}

export const notAttestor = (attestor: string) =>
  `this intent names ${attestor} as its attestor, not this server's wallet; only that key can release it`;
