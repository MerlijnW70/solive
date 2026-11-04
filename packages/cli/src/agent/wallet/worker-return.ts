import { dirname, join, resolve } from "node:path";
import { type Address, getAddressEncoder, type Instruction, type TransactionSigner } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { AccountState, getCloseAccountInstruction, getTokenDecoder } from "@solana-program/token";
import { formatAmount, IntentStatus, NATIVE_MINT } from "@intent-engine/core";
import {
  buildSettleClaims,
  CLAIM_BOARD_DISCRIMINATOR,
  claimSlot,
  decodeClaimBoardAccount,
  decodeStandbyAccount,
  STANDBY_DISCRIMINATOR,
  stakeReceiverOnSettle,
} from "@intent-engine/core/internal";
import { createClient } from "@intent-engine/client/node";
import { chainTime, intentAt, isLedgerPath, mintOf, unmemoized } from "@intent-engine/client/internal";
import type { Client, EngineAccount, Transport } from "@intent-engine/client";
import { keptLines } from "../../announcement-views.js";
import { listAccount } from "../../claim-lists.js";
import { execute } from "../../flows.js";
import { expandHome, settingsDir } from "../../wallet.js";
import type { AgentContext } from "../actions.js";
import { escrowState } from "../claim-line.js";
import type { Call } from "../claims.js";
import { claimOf } from "../job-claims.js";
import { prepare } from "../prepare.js";
import { AgentRefusal } from "../problems.js";
import { preparedView } from "../shapes.js";
import { sol } from "./costs.js";
import { bookBatches, type BookClose, booksClosed, booksKeptLine, booksOf, booksPaidBy, bookUnclosed, intentsOf, rentOf } from "./worker-books.js";
import { access, oneAtATime, savedKeypair, sent, signerAt, signerOf, type WalletAccess, type WalletSigner } from "./guard.js";

export const WORKERS_FOLDER = "workers";

export const BOARD_WORKER_AT = 72;

export const STANDBY_WORKER_AT = 8;

export type WorkerJob = { intent: Address; owner: Address; nonce: string; mint: Address };

export const workersDir = (keyPath: string): string => join(dirname(keyPath), WORKERS_FOLDER);

export const workerKeyPath = (dir: string, worker: Address): string => join(dir, `${worker}.json`);

export const workerJobPath = (dir: string, worker: Address): string => join(dir, `${worker}.job.json`);

export async function workersFolder(wallet: WalletAccess): Promise<string> {
  const path = await savedKeypair(wallet);
  const home = wallet.files.home;
  return workersDir(path === undefined || isLedgerPath(path) ? `${settingsDir(home)}/wallet.json` : resolve(expandHome(path, home)));
}

export const noWorker = (worker: Address): string => `this wallet made no worker ${worker}: its key is not in the workers folder; nothing was sent`;

export const jobStillOpen = (intent: Address): string => `escrow ${intent} is still open, so its worker may still need this SOL; cancel it or wait for it to end; nothing was sent`;

export const claimHeldOpen = (worker: Address, intent: Address): string =>
  `${worker} holds the claim on escrow ${intent}, whose job is still open, and its stake is on the board; it delivers or gives up with the CLI command claims drop first; nothing was sent`;

export const lineStillOpen = (worker: Address, intent: Address): string =>
  `${worker} still stands in the line of escrow ${intent}, which holds its stake; it leaves first with the CLI command claims leave; nothing was sent`;

export const CLAIMS_UNLISTED = "this RPC node cannot list claims boards and lines by worker, so whether the worker still holds a stake is unknown; nothing was sent";

export const boardUnread = (board: Address): string => `the claims board ${board} names this worker but cannot be read, so its stake is unknown; nothing was sent`;

export const TOKENS_UNLISTED = "this RPC node cannot list the worker's token accounts, so the key stays";

export const tokensLeft = (amount: string, mint: Address, account: Address, keypair: string): string =>
  `${amount} of ${mint} in ${account}, which this does not move; its key file is ${keypair}`;

export const unclosable = (account: Address, mint: Address, why: string, keypair: string): string =>
  `${account} of ${mint} cannot be closed (${why}), so it stays; its key file is ${keypair}`;

export const FROZEN = "it is frozen";

export const WITHHELD_FEES = "it holds withheld transfer fees";

export const OTHER_CLOSE_AUTHORITY = "another address holds its close authority";

export const NOTHING_LEFT = "the worker holds nothing to return and nothing was sent";

export const settleLine = (worker: Address, intent: Address, stake: bigint, receiver: Address): string =>
  `Settles: the claim of ${worker} on ended or lapsed escrow ${intent}; its stake of ${sol(stake)} goes to ${receiver}`;

export const returnsLine = (returned: bigint, worker: Address, wrapped: bigint): string =>
  `Returns: ${sol(returned)} from ${worker} to this wallet${wrapped > 0n ? `, including ${sol(wrapped)} of wrapped SOL, which holds any pay the worker received` : ""}`;

const RETURNED = "returned to this wallet";

type Settle = { instruction: Instruction; line: string; toWorker: bigint };

type Tokens = { closes: Instruction[]; rent: bigint; wrapped: bigint; kept: string[] };

const naming = (worker: Address, offset: number) => ({ offset, address: worker });

const holds = (data: Uint8Array, worker: Address, offset: number): boolean => {
  const bytes = getAddressEncoder().encode(worker);
  return data.length >= offset + bytes.length && bytes.every((b, i) => data[offset + i] === b);
};

async function namedBy(transport: Transport, discriminator: typeof CLAIM_BOARD_DISCRIMINATOR, worker: Address, offset: number): Promise<EngineAccount[]> {
  if (transport.engineAccounts === undefined) {
    throw new AgentRefusal("WorkerBusy", CLAIMS_UNLISTED);
  }
  return (await transport.engineAccounts({ discriminator, match: [naming(worker, offset)] })).filter(({ data }) => holds(data, worker, offset));
}

const isOpen = async (transport: Transport, intent: Address, now: bigint): Promise<boolean> => {
  const held = await intentAt(transport, intent);
  return held !== null && held.status === IntentStatus.Open && now < held.expiresAt;
};

export async function workerStakes(transport: Transport, worker: Address): Promise<Settle[]> {
  const entries = await namedBy(transport, STANDBY_DISCRIMINATOR, worker, STANDBY_WORKER_AT);
  for (const entry of entries) {
    let intent: Address;
    try {
      intent = decodeStandbyAccount(entry.data).intent;
    } catch {
      throw new AgentRefusal("WorkerBusy", boardUnread(entry.address));
    }
    throw new AgentRefusal("WorkerBusy", lineStillOpen(worker, intent));
  }
  const boards = await namedBy(transport, CLAIM_BOARD_DISCRIMINATOR, worker, BOARD_WORKER_AT);
  const now = await chainTime(transport);
  const settles: Settle[] = [];
  for (const found of boards) {
    let board;
    try {
      board = decodeClaimBoardAccount(found.data);
    } catch {
      throw new AgentRefusal("WorkerBusy", boardUnread(found.address));
    }
    if (board.worker !== worker) {
      continue;
    }
    const open = await isOpen(transport, board.intent, now);
    if (open && claimSlot(board, now).state === "held") {
      throw new AgentRefusal("WorkerBusy", claimHeldOpen(worker, board.intent));
    }
    const receiver = stakeReceiverOnSettle(board, now, open) ?? board.owner;
    const view = await claimOf(transport, board.intent);
    settles.push({
      instruction: await buildSettleClaims({ intent: board.intent, owner: board.owner, worker, ...listAccount(view?.list ?? null) }),
      line: settleLine(worker, board.intent, board.held, receiver),
      toWorker: receiver === worker ? board.held : 0n,
    });
  }
  return settles;
}

const ACCOUNT_BASE = 165;

const TRANSFER_FEE_AMOUNT = 2;

const withheldFees = (data: Uint8Array): boolean => {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  for (let at = ACCOUNT_BASE + 1; at + 4 <= data.length; ) {
    const type = view.getUint16(at, true);
    const length = view.getUint16(at + 2, true);
    if (type === TRANSFER_FEE_AMOUNT && length >= 8 && at + 12 <= data.length && view.getBigUint64(at + 4, true) > 0n) {
      return true;
    }
    at += 4 + length;
  }
  return false;
};

const refusal = (token: ReturnType<ReturnType<typeof getTokenDecoder>["decode"]>, data: Uint8Array, worker: Address): string | undefined => {
  if (token.state === AccountState.Frozen) {
    return FROZEN;
  }
  if (withheldFees(data)) {
    return WITHHELD_FEES;
  }
  if (token.closeAuthority.__option === "Some" && token.closeAuthority.value !== worker) {
    return OTHER_CLOSE_AUTHORITY;
  }
  return undefined;
};

async function tokensOf(transport: Transport, worker: Address, key: TransactionSigner, hirer: Address, keypair: string): Promise<Tokens> {
  if (transport.tokenAccountsOf === undefined) {
    return { closes: [], rent: 0n, wrapped: 0n, kept: [TOKENS_UNLISTED] };
  }
  const tokens: Tokens = { closes: [], rent: 0n, wrapped: 0n, kept: [] };
  for (const found of await transport.tokenAccountsOf(worker)) {
    const token = getTokenDecoder().decode(found.data);
    const { mint, amount } = token;
    const why = refusal(token, found.data, worker);
    if (why !== undefined) {
      tokens.kept.push(unclosable(found.address, mint, why, keypair));
    } else if (mint === NATIVE_MINT || amount === 0n) {
      tokens.closes.push({ ...getCloseAccountInstruction({ account: found.address, destination: hirer, owner: key }), programAddress: found.program });
      tokens.rent += found.lamports;
      tokens.wrapped += mint === NATIVE_MINT ? amount : 0n;
    } else {
      tokens.kept.push(tokensLeft(formatAmount(amount, (await mintOf(transport, mint)).decimals), mint, found.address, keypair));
    }
  }
  return tokens;
}

async function sweepOf(transport: Transport, worker: Address, key: TransactionSigner, hirer: Address, keypair: string) {
  const [own, tokens] = await Promise.all([transport.getAccount(worker), tokensOf(transport, worker, key, hirer, keypair)]);
  const lamports = own?.lamports ?? 0n;
  const instructions = [...tokens.closes, ...(lamports > 0n ? [getTransferSolInstruction({ source: key, destination: hirer, amount: lamports })] : [])];
  return { instructions, lamports, tokens };
}

async function holdsNothing(transport: Transport, client: Client, worker: Address, key: TransactionSigner): Promise<boolean> {
  const [own, tokens, plan, stakes, books] = await Promise.all([
    transport.getAccount(worker),
    transport.tokenAccountsOf?.(worker),
    client.plan.reclaim({ worker: key }),
    workerStakes(transport, worker).catch(() => null),
    booksPaidBy(transport, worker).catch(() => null),
  ]);
  return (
    (own?.lamports ?? 0n) === 0n &&
    tokens !== undefined &&
    tokens.length === 0 &&
    plan.closed.length + plan.kept.length === 0 &&
    stakes !== null &&
    stakes.length === 0 &&
    books !== null &&
    books.length === 0
  );
}

async function refuseOpen(client: Client, job: WorkerJob): Promise<void> {
  if ((await escrowState(client, job.owner, BigInt(job.nonce))) === "open") {
    throw new AgentRefusal("WorkerBusy", jobStillOpen(job.intent));
  }
}

export async function returnLeftovers(ctx: AgentContext, worker: Address, send: boolean | undefined, call: Call) {
  const wallet = access(ctx);
  const signer = await signerOf(ctx);
  const dir = await workersFolder(wallet);
  const keypair = workerKeyPath(dir, worker);
  const jobFile = workerJobPath(dir, worker);
  let key: WalletSigner;
  let job: WorkerJob;
  try {
    key = await signerAt(ctx, keypair);
    job = JSON.parse(await wallet.files.readText(jobFile)) as WorkerJob;
  } catch {
    throw new AgentRefusal("NotFound", noWorker(worker));
  }
  if (key.address !== worker || worker === signer.address) {
    throw new AgentRefusal("NotFound", noWorker(worker));
  }
  const client = createClient({ url: ctx.url ?? "", transport: ctx.transport });
  const settles = await workerStakes(ctx.transport, worker);
  await refuseOpen(client, job);
  const plan = await client.plan.reclaim({ worker: key });
  const closing = plan.batches[0] ?? [];
  const rents = await ctx.transport.getAccounts(plan.closed.slice(0, closing.length));
  const closingRent = rents.reduce((sum, view) => sum + (view?.lamports ?? 0n), 0n);
  const books = await booksOf(ctx.transport, worker, key, intentsOf(rents), await chainTime(ctx.transport), keypair);
  const sweep = await sweepOf(ctx.transport, worker, key, signer.address, keypair);
  const stakesBack = settles.reduce((sum, settle) => sum + settle.toWorker, 0n);
  const kept = [
    ...keptLines(plan.reasons),
    ...(plan.closed.length > closing.length ? [`${plan.closed.length - closing.length} more announcements can close; call again`] : []),
    ...sweep.tokens.kept,
    ...books.kept,
  ];
  const viewOf = (closed: readonly BookClose[], unclosed: readonly Address[]) => {
    const keeps = [...kept, ...unclosed.map((book) => bookUnclosed(book, keypair))];
    const open = [...books.open, ...unclosed];
    const returned = sweep.lamports + closingRent + sweep.tokens.rent + stakesBack + rentOf(closed);
    return {
      worker,
      intent: job.intent,
      returned: sol(returned),
      kept: keeps,
      key_deleted: false,
      summary: [
        ...settles.map((settle) => settle.line),
        returnsLine(returned, worker, sweep.tokens.wrapped),
        "Pays: the network fee, from this wallet",
        ...(closed.length === 0 ? [] : [booksClosed(closed.map(({ book }) => book), rentOf(closed))]),
        keeps.length === 0 ? `Deletes: ${keypair}, once it holds nothing` : open.length > 0 ? booksKeptLine(keypair, open) : `Keeps: ${keypair}, since the worker still holds something`,
      ],
    };
  };
  const finish = async (done: Record<string, unknown> & { kept: string[] }): Promise<Record<string, unknown>> => {
    const fresh = unmemoized(ctx.transport);
    if (done.kept.length > 0 || wallet.files.removeFile === undefined || !(await holdsNothing(fresh, createClient({ url: ctx.url ?? "", transport: fresh }), worker, key))) {
      return done;
    }
    await wallet.files.removeFile(keypair);
    await wallet.files.removeFile(jobFile);
    return { ...done, key_deleted: true };
  };
  const batches = bookBatches(books.closing);
  const shown = viewOf(books.closing, []);
  const steps = [settles.map((settle) => settle.instruction), closing, ...batches.map((batch) => batch.map(({ instruction }) => instruction)), sweep.instructions].filter((step) => step.length > 0);
  const [first] = steps;
  if (first === undefined) {
    return send === true ? finish({ ...shown, sent: false, next: NOTHING_LEFT }) : { ...shown, sent: false, next: NOTHING_LEFT };
  }
  if (steps.length > 1) {
    oneAtATime(signer);
  }
  if (send !== true) {
    return sent(ctx, signer, { ...shown, prepared: preparedView(await prepare(ctx.transport, first, signer.address)) }, false, call);
  }
  let signature: string | undefined;
  for (const step of [settles.map((settle) => settle.instruction), closing].filter((one) => one.length > 0)) {
    signature = await execute(ctx.transport, preparedView(await prepare(unmemoized(ctx.transport), step, signer.address)), signer);
  }
  const closed: BookClose[] = [];
  const unclosed: Address[] = [];
  for (const batch of batches) {
    try {
      signature = await execute(ctx.transport, preparedView(await prepare(unmemoized(ctx.transport), batch.map(({ instruction }) => instruction), signer.address)), signer);
      closed.push(...batch);
    } catch {
      unclosed.push(...batch.map(({ book }) => book));
    }
  }
  const landed = viewOf(closed, unclosed);
  const fresh = unmemoized(ctx.transport);
  const after = await sweepOf(fresh, worker, key, signer.address, keypair);
  if (after.instructions.length === 0) {
    return finish({ ...landed, sent: true, ...(signature === undefined ? {} : { signature }), next: RETURNED });
  }
  const swept = (await sent({ ...ctx, transport: fresh }, signer, { ...landed, prepared: preparedView(await prepare(fresh, after.instructions, signer.address)) }, true, call, { done: RETURNED })) as Record<string, unknown>;
  return finish({ ...swept, kept: landed.kept });
}
