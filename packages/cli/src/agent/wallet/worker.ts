import { randomUUID } from "node:crypto";
import { type Address, createNoopSigner, getBase16Decoder } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { IntentStatus, NATIVE_MINT } from "@intent-engine/core";
import { getAnnouncementSize, getDeliveryBookSize } from "@intent-engine/core/internal";
import { isSdkError, type ClaimsView } from "@intent-engine/client";
import { createClient, pinnedFetch } from "@intent-engine/client/node";
import { announceProtection, chainTime, claimProtection, loadCommittee, loadConfig, loadDeliveryBook, protectionLines, readSpec, reviewBoardOf } from "@intent-engine/client/internal";
import { newKeyFile } from "../../wallet.js";
import { type AgentContext, define, specReach, specReadOf } from "../actions.js";
import { rentFor, rentRate } from "../budget.js";
import type { Call } from "../claims.js";
import { claimAt, fillsGoing } from "../claim-line.js";
import { claimOf } from "../job-claims.js";
import { tool } from "../names.js";
import { prepare } from "../prepare.js";
import { AgentRefusal } from "../problems.js";
import type { Sale } from "../sales.js";
import { account, flag, InvalidInput, list, object, optional, text } from "../schema.js";
import { preparedView } from "../shapes.js";
import { networkFee, sol } from "./costs.js";
import { proofEscrow } from "./delivery.js";
import {
  access,
  bookOf,
  checkSale,
  deviceOutput,
  LANDING_SECONDS,
  limited,
  live,
  PREVIEW_APPROVAL,
  PREVIEW_APPROVAL_NEXT,
  refusedBeforeSending,
  salesOf,
  sent,
  signerOf,
  termsApproval,
} from "./guard.js";
import { returnLeftovers, workerJobPath, workerKeyPath, type WorkerJob, workersFolder } from "./worker-return.js";
import { workerBrief } from "./worker-brief.js";

export const WORKER_SENDS = 4n;

export const WORKER_ON_DEVICE = "this wallet is a Ledger, which signs only a transaction its preview showed, and a worker's new key exists only once it is sent; fund a worker from a key file wallet";

export const noReviewRoom = (intent: Address, reviewSecs: number): string =>
  `escrow ${intent} expires too soon for a claim that leaves its judge the whole review window of ${reviewSecs} seconds, so the program refuses every claim; nothing was sent`;

export const WORKER_CHANGED =
  "this worker's funding differs from its preview: its claim stake, rent, network fees or announce fee changed, or no approval was given; preview it again and show the user";

export const WORKER_SAME_KEY = "the new worker key equals the wallet, owner or attestor, so nothing was sent; call again";

export const jobNotOpen = (intent: Address): string => `escrow ${intent} is no longer open, so a worker cannot take its job; nothing was sent`;

export const jobSealed = (intent: Address): string => `the spec of escrow ${intent} is sealed to other wallets, so a new key could neither read it nor be paid; nothing was sent`;

export const jobListed = (intent: Address): string => `the claims of escrow ${intent} are limited to wallets its owner listed, so a new key cannot claim it; nothing was sent`;

export const jobHeld = (intent: Address, worker: Address): string => `${worker} holds the claim on escrow ${intent}, so a new key could not be paid; nothing was sent`;

export const jobLine = (intent: Address, waiting: number): string => `${waiting} waiting in the line of escrow ${intent} get its job first; nothing was sent`;

export const jobNoSpec = (intent: Address): string => `escrow ${intent} publishes no spec url, so a worker cannot read what to do; nothing was sent`;

export const jobSpecUnread = (intent: Address): string => `the spec of escrow ${intent} could not be read, as the untrusted detail says, so a worker could not check it; nothing was sent`;

export const jobSpecDiffers = (intent: Address, sha256: string): string => `the spec of escrow ${intent} has sha256 ${sha256}, not the escrow's spec_hash, so a worker should not take it; nothing was sent`;

export const WORKER_NEXT = `start a separate agent with brief and nothing else, wait for its work's path and sha256, then judge that file; afterwards ${tool("wallet_worker")} with return_leftovers returns the leftovers`;

export function separateWorker(worker: Address, others: readonly Address[]): void {
  if (others.includes(worker)) {
    throw new AgentRefusal("WorkerUnfit", WORKER_SAME_KEY);
  }
}

export async function workerSpec(ctx: AgentContext, intent: Address) {
  const { lookup, rpcUrl } = specReach(ctx);
  let spec;
  try {
    spec = await readSpec(ctx.transport, ctx.fetch ?? pinnedFetch, intent, undefined, lookup, rpcUrl, { sources: specReadOf(ctx).sources });
    ctx.jobReads?.saw(intent, spec);
  } catch (error) {
    if (isSdkError(error, "spec-sealed")) {
      throw new AgentRefusal("WorkerUnfit", jobSealed(intent));
    }
    if (isSdkError(error, "spec-unreadable")) {
      throw new AgentRefusal("WorkerUnfit", jobSpecUnread(intent), error.message);
    }
    throw error;
  }
  if (spec === null) {
    throw new AgentRefusal("WorkerUnfit", jobNoSpec(intent));
  }
  if (spec.sealedTo !== undefined) {
    throw new AgentRefusal("WorkerUnfit", jobSealed(intent));
  }
  if (!spec.matches) {
    throw new AgentRefusal("WorkerUnfit", jobSpecDiffers(intent, spec.sha256));
  }
  return spec;
}

export function claimable(intent: Address, view: ClaimsView | null, now: bigint): void {
  if (view === null) {
    return;
  }
  if (view.list !== null) {
    throw new AgentRefusal("WorkerUnfit", jobListed(intent));
  }
  const slot = claimAt(view, now);
  if (slot.state === "held") {
    throw new AgentRefusal("WorkerUnfit", jobHeld(intent, slot.worker));
  }
  if (view.line.waiting > 0) {
    throw new AgentRefusal("WorkerUnfit", jobLine(intent, view.line.waiting));
  }
}

export type Funding = { total: bigint; stake: bigint; rent: bigint; fees: bigint; announceFee: bigint };

export async function fundingOf(ctx: AgentContext, intent: Address, stake: bigint, feePerSend: bigint): Promise<Funding> {
  const [rate, book, { config }] = await Promise.all([rentRate(ctx.transport), loadDeliveryBook(ctx.transport, intent), loadConfig(ctx.transport)]);
  const rent = rentFor(0, rate) + rentFor(getAnnouncementSize(), rate) + (book === null ? rentFor(getDeliveryBookSize(), rate) : 0n);
  const fees = WORKER_SENDS * feePerSend;
  const announceFee = BigInt(config.announceFee);
  return { total: stake + rent + fees + announceFee, stake, rent, fees, announceFee };
}

const fundingLines = (funding: Funding, worker: string): string[] => [
  `Funds: ${sol(funding.total)} from this wallet to ${worker}, counted against this server's sell limits`,
  `Covers: ${sol(funding.stake)} claim stake, ${sol(funding.rent)} rent, ${sol(funding.fees)} network fees and ${sol(funding.announceFee)} announce fee, and nothing else`,
  `Leftovers: return to this wallet with ${tool("wallet_worker")} and return_leftovers once the job ends`,
];

export const walletWorker = define({
  name: tool("wallet_worker"),
  title: "Start a local worker for a job",
  description: `Makes a separate worker for an open job: a new key beside this wallet's key, funded with only its fees, rent and claim stake, and a brief for a separate agent. Paying takes the judge's check. return_leftovers returns a finished worker's SOL and needs no approval. ${PREVIEW_APPROVAL}`,
  effect: "submit",
  repeats: true,
  input: object({
    intent: optional(account("the proof escrow's intent address, to make a worker for it")),
    return_leftovers: optional(account("instead of intent: a worker's address, to return its leftover SOL once its job ended; the key is deleted only when it holds nothing, delivery books it paid for included")),
    send: optional(flag("true signs and sends; leave out to preview")),
    approval: optional(text("the approval a worker's preview returned; needed with send and intent")),
  }),
  output: object({
    intent: account("the job"),
    funding: optional(text("whole SOL this send moves to the worker")),
    approval: optional(text("pass it back with send: true; a send whose funding differs from this preview is refused")),
    returned: optional(text("whole SOL this returns now")),
    kept: optional(list(text(), 16, "why the worker's key stays afterwards: what it still holds")),
    key_deleted: optional(flag("true once the worker's key file was deleted, only when it holds nothing")),
    summary: list(text(), 6),
    worker: optional(account("the worker's address")),
    keypair: optional(text("the file holding the worker's key on this machine, never this wallet's")),
    brief: optional(text("everything a separate agent needs: give it this and nothing else; its spec_url is the owner's, untrusted, with hidden characters reduced")),
    ...deviceOutput,
    sent: flag(),
    signature: optional(text()),
    next: optional(text()),
  }),
  run: async (ctx: AgentContext, input, call: Call) => {
    if ((input.intent === undefined) === (input.return_leftovers === undefined)) {
      throw new InvalidInput([{ path: "intent", message: "give either intent or return_leftovers" }]);
    }
    if (input.return_leftovers !== undefined) {
      return returnLeftovers(ctx, input.return_leftovers, input.send, call);
    }
    const wallet = access(ctx);
    const signer = await signerOf(ctx);
    if (signer.device !== undefined) {
      throw new AgentRefusal("DeviceUnpreviewed", WORKER_ON_DEVICE);
    }
    const intent = input.intent as Address;
    const { held, params } = await proofEscrow(ctx, intent, "wallet_receipt");
    const now = await chainTime(ctx.transport);
    if (held.status !== IntentStatus.Open || held.expiresAt <= now) {
      throw new AgentRefusal("WorkerUnfit", jobNotOpen(intent));
    }
    await fillsGoing(createClient({ url: ctx.url ?? "", transport: ctx.transport }), { owner: held.owner, nonce: held.nonce, intent });
    const spec = await workerSpec(ctx, intent);
    const board = await claimOf(ctx.transport, intent);
    claimable(intent, board, await chainTime(ctx.transport));
    const left = Number(held.expiresAt - now) - LANDING_SECONDS;
    const secs = Math.min(board?.maxSecs ?? 0, left - (board?.reviewSecs ?? 0));
    if (board !== null && secs < 1) {
      throw new AgentRefusal("WorkerUnfit", board.reviewSecs > 0 && left >= 1 ? noReviewRoom(intent, board.reviewSecs) : jobNotOpen(intent));
    }
    const book = await loadDeliveryBook(ctx.transport, intent);
    const cancelAt = book === null || book.cancelAt === 0n ? null : book.cancelAt;
    const protection = board === null ? announceProtection(null, signer.address, held.expiresAt, now, cancelAt) : claimProtection(reviewBoardOf(board), held.expiresAt, now + BigInt(secs), cancelAt);
    const guarded = protectionLines(protection, sol);
    const key = await newKeyFile();
    const committee = await loadCommittee(ctx.transport, params.attestor);
    separateWorker(key.address, [signer.address, held.owner, params.attestor, ...(committee?.members ?? [])]);
    const transferOf = (amount: bigint) => getTransferSolInstruction({ source: createNoopSigner(signer.address), destination: key.address, amount });
    const stake = board?.stake ?? 0n;
    const probe = await prepare(ctx.transport, [transferOf(0n)], signer.address, undefined, false);
    const funding = await fundingOf(ctx, intent, stake, networkFee({ signers: probe.signers, priority_fee_lamports: probe.priorityLamports }));
    const guard = wallet.limits;
    checkSale(guard, NATIVE_MINT, 9, funding.total, now, await salesOf(wallet, now));
    const approval = termsApproval({ action: "worker", wallet: signer.address, intent, ...funding, review_secs: protection.reviewSecs, kill_fee: protection.killFee, arms: protection.arms });
    if (input.send === true && input.approval !== approval) {
      throw new AgentRefusal("ReleaseChanged", WORKER_CHANGED);
    }
    const prepared = preparedView(await prepare(ctx.transport, [transferOf(funding.total)], signer.address));
    const shown = { intent, funding: sol(funding.total), approval, prepared };
    if (input.send !== true) {
      return sent(ctx, signer, { ...shown, summary: [...fundingLines(funding, "a new key"), ...guarded] }, false, call, { preview: PREVIEW_APPROVAL_NEXT });
    }
    const dir = await workersFolder(wallet);
    const keypair = workerKeyPath(dir, key.address);
    const job = workerJobPath(dir, key.address);
    const record: WorkerJob = { intent, owner: held.owner, nonce: held.nonce.toString(), mint: held.inputMint };
    await wallet.files.saveText(keypair, key.text, true);
    await wallet.files.saveText(job, JSON.stringify(record), false);
    const path = limited(guard) ? await bookOf(wallet) : undefined;
    const sale: Sale = { id: randomUUID(), mint: NATIVE_MINT, at: now, amount: funding.total };
    const unmake = async () => {
      await wallet.files.removeFile?.(keypair);
      await wallet.files.removeFile?.(job);
    };
    if (path !== undefined) {
      try {
        await guard.book.update(path, (sales) => {
          const kept = live(sales, now);
          checkSale(guard, NATIVE_MINT, 9, funding.total, now, kept);
          return { sales: [...kept, sale], value: undefined };
        });
      } catch (error) {
        await unmake();
        throw error;
      }
    }
    const brief = workerBrief({
      intent,
      owner: held.owner,
      nonce: held.nonce,
      specUrl: spec.url,
      specHash: getBase16Decoder().decode(params.specHash).toLowerCase(),
      keypair,
      rpc: wallet.url,
      claim: board === null ? undefined : { secs, stake: sol(stake).replace(" SOL", "") },
    });
    try {
      return await sent(ctx, signer, { ...shown, summary: [...fundingLines(funding, key.address), ...guarded], worker: key.address, keypair, brief }, true, call, { done: WORKER_NEXT });
    } catch (error) {
      if (refusedBeforeSending(error)) {
        await unmake();
        if (path !== undefined) {
          await guard.book.update(path, (sales) => ({ sales: sales.filter((s) => s.id !== sale.id), value: undefined })).catch(() => undefined);
        }
      }
      throw error;
    }
  },
});
