import { dirname, join } from "node:path";
import { type Address, generateKeyPairSigner, lamports, none, some } from "@solana/kit";
import { AccountState, getTokenEncoder, getTokenSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import type { Client } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, findAssociatedTokenAddress, IntentStatus, NATIVE_MINT } from "@intent-engine/core";
import { claimBoardAddress } from "@intent-engine/core/internal";
import { testSignature } from "@intent-engine/client/testing";
import { jobLine } from "../src/agent/wallet/worker.js";
import { claimHeldOpen, jobStillOpen, lineStillOpen, noWorker, settleLine, workerJobPath } from "../src/agent/wallet/worker-return.js";
import { h, NOW, setNow } from "./harness.js";
import {
  call,
  claimsOn,
  commandNamed,
  forced,
  hireWith,
  lamportsOf,
  makeWorker,
  ok,
  removeWorkFiles,
  run,
  server,
  STAKE,
  startHirer,
  tokensAt,
  WALLET,
  workerFiles,
  cancelledOver,
} from "./local-worker-kit.js";

const WRAPPED = 5_000_000n;

describe("a local worker's leftovers", () => {
  let hirer: Client;
  let wallet: Address;

  const hire = (claims: boolean) => hireWith(hirer, wallet, claims);

  const made = (intent: Address) => makeWorker(hirer, intent);

  const boardOf = async (intent: Address) => h.svm.getAccount(await claimBoardAddress(intent)).exists;

  beforeEach(async () => {
    ({ hirer, wallet } = await startHirer());
  });

  afterEach(removeWorkFiles);

  it("refuses while the worker holds a claim on an open job, moving nothing and keeping its key", async () => {
    const job = await hire(true);
    const { worker, brief, keypair } = await made(job.intent);
    await run(commandNamed(brief, "claims", "take"));
    const held = lamportsOf(worker);
    expect((await call(hirer, "wallet_worker", { return_leftovers: worker, send: true })).value).toMatchObject({ code: "WorkerBusy", hint: claimHeldOpen(worker, job.intent) });
    expect(lamportsOf(worker)).toBe(held);
    expect(h.files.has(keypair)).toBe(true);
  }, 60_000);

  it("refuses while a claim on another escrow holds, even once its own job ended", async () => {
    const own = await hire(true);
    const other = await hire(true);
    const { worker, brief, keypair } = await made(own.intent);
    await run(claimsOn(commandNamed(brief, "claims", "take"), wallet, other.nonce));
    await cancelledOver(hirer, own.nonce);
    const held = lamportsOf(worker);
    expect((await call(hirer, "wallet_worker", { return_leftovers: worker, send: true })).value).toMatchObject({ code: "WorkerBusy", hint: claimHeldOpen(worker, other.intent) });
    expect(lamportsOf(worker)).toBe(held);
    expect(h.files.has(keypair)).toBe(true);
    expect(await boardOf(other.intent)).toBe(true);
  }, 60_000);

  it("settles a held claim on an ended job first, so its stake returns to the worker and on to this wallet, then deletes the key", async () => {
    const job = await hire(true);
    const { worker, brief, keypair } = await made(job.intent);
    await run(commandNamed(brief, "claims", "take"));
    const held = lamportsOf(worker);
    forced(job.intent, IntentStatus.Filled);
    const preview = await ok(hirer, "wallet_worker", { return_leftovers: worker });
    expect(preview["summary"]).toContain(settleLine(worker, job.intent, STAKE, worker));
    expect(lamportsOf(worker)).toBe(held);
    const before = lamportsOf(wallet);
    expect(await ok(hirer, "wallet_worker", { return_leftovers: worker, send: true })).toMatchObject({ sent: true, key_deleted: true });
    expect(await boardOf(job.intent)).toBe(false);
    expect(lamportsOf(worker)).toBe(0n);
    expect(lamportsOf(wallet) - before).toBeGreaterThan(held + STAKE - 100_000n);
    expect(h.files.has(keypair)).toBe(false);
  }, 60_000);

  it("settles a lapsed claim on an ended job, whose stake goes to the job's owner, before deleting the key", async () => {
    const job = await hire(true);
    const { worker, brief, keypair } = await made(job.intent);
    await run(commandNamed(brief, "claims", "take").map((word, at, args) => (args[at - 1] === "--secs" ? "60" : word)));
    setNow(NOW + 600n);
    forced(job.intent, IntentStatus.Cancelled);
    const preview = await ok(hirer, "wallet_worker", { return_leftovers: worker });
    expect(preview["summary"]).toContain(settleLine(worker, job.intent, STAKE, wallet));
    expect(await ok(hirer, "wallet_worker", { return_leftovers: worker, send: true })).toMatchObject({ sent: true, key_deleted: true });
    expect(await boardOf(job.intent)).toBe(false);
    expect(h.files.has(keypair)).toBe(false);
  }, 60_000);

  it("gets the stake back when the hirer cancels under a held claim, since the program refunds it, and only then deletes the key", async () => {
    const job = await hire(true);
    const { worker, brief, keypair } = await made(job.intent);
    await run(commandNamed(brief, "claims", "take"));
    const held = lamportsOf(worker);
    await cancelledOver(hirer, job.nonce);
    expect(lamportsOf(worker)).toBe(held + STAKE);
    expect(await ok(hirer, "wallet_worker", { return_leftovers: worker, send: true })).toMatchObject({ sent: true, key_deleted: true });
    expect(lamportsOf(worker)).toBe(0n);
    expect(h.files.has(keypair)).toBe(false);
    expect(workerFiles()).toEqual([]);
  }, 60_000);

  it("refuses a job whose line waits behind a lapsed claim, and leftovers of a worker standing in that line", async () => {
    const job = await hire(true);
    const first = await made(job.intent);
    const second = await made(job.intent);
    const secs = (args: string[]) => args.map((word, at) => (args[at - 1] === "--secs" ? "60" : word));
    await run(secs(commandNamed(first.brief, "claims", "take")));
    const take = commandNamed(second.brief, "claims", "take");
    await run(secs(["claims", "standby", ...take.slice(2)]));
    setNow(NOW + 600n);
    const funded = lamportsOf(wallet);
    expect((await call(hirer, "wallet_worker", { intent: job.intent, send: true })).value).toMatchObject({ code: "WorkerUnfit", hint: jobLine(job.intent, 1) });
    expect(lamportsOf(wallet)).toBe(funded);
    forced(job.intent, IntentStatus.Filled);
    const held = lamportsOf(second.worker);
    expect((await call(hirer, "wallet_worker", { return_leftovers: second.worker, send: true })).value).toMatchObject({ code: "WorkerBusy", hint: lineStillOpen(second.worker, job.intent) });
    expect(lamportsOf(second.worker)).toBe(held);
    expect(h.files.has(second.keypair)).toBe(true);
  }, 60_000);

  it("refuses while the worker's own job is still open, moving nothing", async () => {
    const job = await hire(false);
    const { worker, keypair } = await made(job.intent);
    const held = lamportsOf(worker);
    expect((await call(hirer, "wallet_worker", { return_leftovers: worker, send: true })).value).toMatchObject({ code: "WorkerBusy", hint: jobStillOpen(job.intent) });
    expect(lamportsOf(worker)).toBe(held);
    expect(h.files.has(keypair)).toBe(true);
  });

  it("returns wrapped SOL and names it as possible pay, but keeps the key and names every other token it cannot move, whatever the job's token", async () => {
    const job = await hire(false);
    const { worker, keypair } = await made(job.intent);
    await cancelledOver(hirer, job.nonce);
    const test = await tokensAt(worker, 7n);
    const wrapped = await findAssociatedTokenAddress({ owner: worker, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const space = BigInt(getTokenSize());
    const rent = h.svm.minimumBalanceForRentExemption(space);
    h.svm.setAccount({
      address: wrapped,
      data: Uint8Array.from(getTokenEncoder().encode({ mint: NATIVE_MINT, owner: worker, amount: WRAPPED, delegate: none(), state: AccountState.Initialized, isNative: some(rent), delegatedAmount: 0n, closeAuthority: none() })),
      executable: false,
      lamports: lamports(rent + WRAPPED),
      programAddress: TOKEN_PROGRAM_ADDRESS,
      space,
    });
    const preview = await ok(hirer, "wallet_worker", { return_leftovers: worker });
    expect(preview["summary"].join(" ")).toContain("including 0.005 SOL of wrapped SOL");
    expect(preview["kept"].join(" ")).toContain(DEVNET_TEST_MINT);
    const done = await ok(hirer, "wallet_worker", { return_leftovers: worker, send: true });
    expect(done).toMatchObject({ sent: true, key_deleted: false });
    expect(done["kept"].join(" ")).toContain(test);
    expect(lamportsOf(worker)).toBe(0n);
    expect(h.svm.getAccount(wrapped).exists).toBe(false);
    expect(h.svm.getAccount(test).exists).toBe(true);
    expect(h.files.has(keypair)).toBe(true);
  });

  it("refuses a worker this wallet did not make, a key file that holds another key, and the wallet's own key", async () => {
    const other = (await generateKeyPairSigner()).address;
    expect((await call(hirer, "wallet_worker", { return_leftovers: other })).value).toMatchObject({ code: "NotFound", hint: noWorker(other) });
    const job = await hire(false);
    const { worker, keypair } = await made(job.intent);
    const dir = dirname(keypair);
    h.files.set(join(dir, `${other}.json`), h.files.get(keypair) as string);
    h.files.set(workerJobPath(dir, other), h.files.get(workerJobPath(dir, worker)) as string);
    expect((await call(hirer, "wallet_worker", { return_leftovers: other })).value).toMatchObject({ code: "NotFound", hint: noWorker(other) });
    h.files.set(join(dir, `${wallet}.json`), h.files.get(WALLET) as string);
    h.files.set(workerJobPath(dir, wallet), h.files.get(workerJobPath(dir, worker)) as string);
    await cancelledOver(hirer, job.nonce);
    const before = lamportsOf(wallet);
    expect((await call(hirer, "wallet_worker", { return_leftovers: wallet, send: true })).value).toMatchObject({ code: "NotFound", hint: noWorker(wallet) });
    expect(lamportsOf(wallet)).toBe(before);
  });

  it("reads the worker's balance again before deleting its key, and keeps it when the sweep did not land", async () => {
    const job = await hire(false);
    const { worker, keypair } = await made(job.intent);
    await cancelledOver(hirer, job.nonce);
    const live = h.through as NonNullable<typeof h.through>;
    h.through = { ...live, sendWire: async () => testSignature("dropped") };
    const dropping = await server();
    const held = lamportsOf(worker);
    expect(await ok(dropping, "wallet_worker", { return_leftovers: worker, send: true })).toMatchObject({ sent: true, key_deleted: false });
    expect(lamportsOf(worker)).toBe(held);
    expect(h.files.has(keypair)).toBe(true);
  });
});
