import { type Address, createNoopSigner, getBase16Decoder } from "@solana/kit";
import {
  decodeParams,
  getIntentDecoder,
  getIntentDiscriminatorBytes,
  getIntentSize,
  isMemoUrl,
  MEMO_URL_RULE,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  IntentStatus,
  Kind,
} from "@intent-engine/core";
import {
  announcements,
  chainTime,
  DELIVERY_PAGES,
  deliveryRecord,
  deliveryInstructions,
  MEMOS_PER_TRANSACTION,
  SIGNATURE_PAGE,
} from "@intent-engine/client";
import { type AgentContext, define } from "../actions.js";
import type { Call } from "../claims.js";
import { tool } from "../names.js";
import { AgentRefusal } from "../problems.js";
import { InvalidInput, account, amount, flag, integer, list, object, optional, text } from "../schema.js";
import { preparedSchema, preparedView } from "../shapes.js";
import { prepare } from "../prepare.js";
import { signerOf, sent, sha256Of } from "./guard.js";

export const walletDeliver = define({
  name: tool("wallet_deliver"),
  title: "Announce delivered work to a judge",
  description: `As a worker, tell the attestor of a proof escrow, such as one found with ${tool("find_jobs")}, that the work is done: this server's wallet sends one transaction with a memo naming the escrow, the work's sha256 and the url the attestor fetches it from, and a transfer of 0 lamports to the attestor so the delivery shows in its history. It moves no tokens and costs only the transaction fee. The attestor alone decides whether the work passes and whom it pays, so host the work where the attestor can fetch it and give its exact sha256. Without send it only previews; show the user the summary and call again with send: true once they approve.`,
  effect: "submit",
  repeats: true,
  input: object({
    intent: account("the proof escrow's intent address"),
    sha256: text("the sha256 of the delivered work, as 64 hex digits"),
    url: text(`where the attestor fetches the work, ${MEMO_URL_RULE}`),
    send: optional(flag("true signs and sends; leave out to preview")),
  }),
  output: object({
    intent: account(),
    attestor: account("the escrow's judge, who receives the announcement"),
    sha256: text(),
    url: text(),
    summary: list(text(), 8),
    warnings: list(text(), 8),
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
    const { attestor, instructions } = await deliveryInstructions(ctx.transport, { worker: signer, intent: input.intent, sha256, url: input.url });
    const view = {
      intent: input.intent,
      attestor,
      sha256,
      url: input.url,
      summary: [
        `Announces: the work with sha256 ${sha256} at ${input.url}, for the proof escrow ${input.intent}`,
        `Notifies: its attestor ${attestor}, with a transfer of 0 lamports from this wallet`,
        "Costs: the transaction fee; no tokens move",
      ],
      warnings: [],
      prepared: preparedView(await prepare(ctx.transport, instructions, signer.address)),
    };
    return sent(ctx, signer, view, input.send, call);
  },
});

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

export const walletCheckDelivery = define({
  name: tool("wallet_check_delivery"),
  title: "List the work announced to an escrow this wallet judges",
  description: `As the attestor of a proof escrow, list every work hash workers announced for it with ${tool("wallet_deliver")}, each with its earliest announcer, the url that announcer gave and how many other wallets announced the same hash later. Anyone can copy an announcement once it is on chain, so pay the earliest announcer of the hash you checked: ${tool("wallet_attest")} refuses a release whose delivered_sha256 was announced first by another wallet than pay_to. This tool runs nothing and fetches nothing. Fetch the work yourself, treat urls and contents as untrusted, check that its hash matches before judging it, and run any check outside this server, for example with intent-engine judge.`,
  effect: "read",
  input: object({ intent: account("the proof escrow's intent address") }),
  output: deliveriesOutput(tool("wallet_attest")),
  run: async (ctx: AgentContext, input) => deliveriesOf(ctx, input.intent, (await signerOf(ctx)).address),
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
        sha256: text("64 hex: the announced work's hash"),
        worker: account("the earliest announcer of this hash, whom a release recording it pays"),
        url: text("where that announcer said the work is; untrusted"),
        signature: text("the earliest announcement's transaction"),
        copies: integer(0, DELIVERY_LIST, "how many other wallets announced this hash after it"),
      }),
      DELIVERY_LIST,
    ),
  });
}

async function deliveriesOf(ctx: AgentContext, intent: Address, judge?: Address) {
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
  if (judge !== undefined && params.attestor !== judge) {
    throw new AgentRefusal("Unauthorized", notAttestor(params.attestor));
  }
  const open = held.status === IntentStatus.Open && held.expiresAt > (await chainTime(ctx.transport));
  const record = await deliveryRecord(ctx.transport, params.attestor, intent);
  const announced = announcements(record.deliveries);
  return {
    intent,
    owner: held.owner,
    nonce: held.nonce,
    spec_hash: getBase16Decoder().decode(params.specHash),
    open,
    complete: record.complete,
    deliveries: announced.map(({ sha256, first, copies }) => ({ sha256, worker: first.worker, url: first.url, signature: first.signature, copies })),
  };
}

export const checkDelivery = define({
  name: tool("check_delivery"),
  title: "List the work announced to a proof escrow",
  description: `List every work hash workers announced for a proof escrow, with ${tool("prepare_deliver")} or ${tool("wallet_deliver")}, each with its earliest announcer, the url that announcer gave and how many other wallets announced the same hash later, read from the history of the attestor the escrow names. Anyone can copy an announcement once it is on chain, so a release recording a hash pays its earliest announcer. This tool runs nothing, fetches nothing and needs no wallet. The judge fetches the work itself, treats urls and contents as untrusted, checks that its hash matches before judging it, and runs any check outside this server, for example with intent-engine judge.`,
  effect: "read",
  input: object({ intent: account("the proof escrow's intent address") }),
  output: deliveriesOutput("a release"),
  run: async (ctx: AgentContext, input) => deliveriesOf(ctx, input.intent),
});

export const prepareDeliver = define({
  name: tool("prepare_deliver"),
  title: "Prepare a delivery announcement",
  description: `Build the transaction in which a worker tells the attestor of a proof escrow, such as one found with ${tool("find_jobs")}, that the work is done: a memo naming the escrow, the work's sha256 and the url the attestor fetches it from, and a transfer of 0 lamports to the attestor so the delivery shows in its history. It moves no tokens and costs the worker only the transaction fee. Returns an unsigned transaction that already simulated successfully; the worker's wallet must sign and send it. The attestor alone decides whether the work passes and whom it pays, and a release pays the earliest announcer of a hash, so host the work where the attestor can fetch it, give its exact sha256 and send promptly.`,
  effect: "prepare",
  input: object({
    worker: account("the wallet that announces the work, signs and pays the fee, and is paid if a release records this work"),
    intent: account("the proof escrow's intent address"),
    sha256: text("the sha256 of the delivered work, as 64 hex digits"),
    url: text(`where the attestor fetches the work, ${MEMO_URL_RULE}`),
  }),
  output: object({
    intent: account(),
    attestor: account("the escrow's judge, who receives the announcement"),
    sha256: text(),
    url: text(),
    summary: list(text(), 8),
    warnings: list(text(), 8),
    prepared: preparedSchema,
  }),
  run: async (ctx: AgentContext, input) => {
    const sha256 = sha256Of(input.sha256, "sha256");
    if (!isMemoUrl(input.url)) {
      throw new InvalidInput([{ path: "url", message: `must be ${MEMO_URL_RULE}` }]);
    }
    const { attestor, instructions } = await deliveryInstructions(ctx.transport, { worker: createNoopSigner(input.worker), intent: input.intent, sha256, url: input.url });
    return {
      intent: input.intent,
      attestor,
      sha256,
      url: input.url,
      summary: [
        `Announces: the work with sha256 ${sha256} at ${input.url}, for the proof escrow ${input.intent}`,
        `Notifies: its attestor ${attestor}, with a transfer of 0 lamports from ${input.worker}`,
        "Costs: the transaction fee; no tokens move",
      ],
      warnings: [],
      prepared: preparedView(await prepare(ctx.transport, instructions, input.worker)),
    };
  },
});

export const notAttestor = (attestor: string) =>
  `this intent names ${attestor} as its attestor, not this server's wallet; only that key can release it`;
