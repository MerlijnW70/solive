import { type Address, lamports, none, some } from "@solana/kit";
import { AccountState, getTokenEncoder, getTokenSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import type { Client } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findAssociatedTokenAddress, IntentStatus, NATIVE_MINT } from "@intent-engine/core";
import { getAnnouncementSize } from "@intent-engine/core/internal";
import { sol } from "../src/agent/wallet/costs.js";
import { NOTHING_LEFT, settleLine } from "../src/agent/wallet/worker-return.js";
import { h, NOW, setNow } from "./harness.js";
import { commandNamed, forced, hireWith, lamportsOf, makeWorker, ok, removeWorkFiles, rentOf, run, server, SOLUTION, STAKE, startHirer, tokensAt, workFile } from "./local-worker-kit.js";

const WRAPPED = 5_000_000n;
const SYSTEM = "11111111111111111111111111111111" as Address;
const PAYS = "Pays: the network fee, from this wallet";

const returns = (amount: bigint, worker: Address) => `Returns: ${sol(amount)} from ${worker} to this wallet`;

const drained = (at: Address) => h.svm.setAccount({ address: at, data: new Uint8Array(), executable: false, lamports: lamports(0n), programAddress: SYSTEM, space: 0n });

describe("a local worker's leftovers, counted exactly", () => {
  let hirer: Client;
  let wallet: Address;
  let wires: number;

  const hire = (claims: boolean) => hireWith(hirer, wallet, claims);

  const made = (intent: Address) => makeWorker(hirer, intent);

  const counting = async (after: (count: number) => void = () => undefined) => {
    const live = h.through as NonNullable<typeof h.through>;
    wires = 0;
    h.through = {
      ...live,
      sendWire: async (wire, latest) => {
        const signature = await live.sendWire(wire, latest);
        wires += 1;
        after(wires);
        return signature;
      },
    };
    return server();
  };

  const lapsed = async () => {
    const job = await hire(true);
    const worker = await made(job.intent);
    await run(commandNamed(worker.brief, "claims", "take").map((word, at, args) => (args[at - 1] === "--secs" ? "60" : word)));
    setNow(NOW + 600n);
    forced(job.intent, IntentStatus.Cancelled);
    return { ...job, ...worker };
  };

  beforeEach(async () => {
    ({ hirer, wallet } = await startHirer());
  });

  afterEach(removeWorkFiles);

  it("returns the worker's SOL and the stake its settled claim gives back, names both, and sends the settle and the sweep only", async () => {
    const job = await hire(true);
    const { worker, brief, keypair } = await made(job.intent);
    await run(commandNamed(brief, "claims", "take"));
    const held = lamportsOf(worker);
    forced(job.intent, IntentStatus.Filled);
    const preview = await ok(hirer, "wallet_worker", { return_leftovers: worker });
    expect(preview).toMatchObject({ returned: sol(held + STAKE), kept: [], key_deleted: false, sent: false });
    expect(preview["summary"]).toEqual([settleLine(worker, job.intent, STAKE, worker), returns(held + STAKE, worker), PAYS, `Deletes: ${keypair}, once it holds nothing`]);
    const sending = await counting();
    expect(await ok(sending, "wallet_worker", { return_leftovers: worker, send: true })).toMatchObject({ sent: true, key_deleted: true });
    expect(wires).toBe(2);
    expect(lamportsOf(worker)).toBe(0n);
    expect(h.files.has(keypair)).toBe(false);
  }, 60_000);

  it("counts no stake back when a lapsed claim's stake goes to the job's owner", async () => {
    const { worker, intent } = await lapsed();
    const held = lamportsOf(worker);
    const preview = await ok(hirer, "wallet_worker", { return_leftovers: worker });
    expect(preview).toMatchObject({ returned: sol(held), kept: [] });
    expect(preview["summary"]).toEqual([settleLine(worker, intent, STAKE, wallet), returns(held, worker), PAYS, expect.stringMatching(/^Deletes: /)]);
  }, 60_000);

  it("settles a lapsed claim of a worker that holds no SOL in one send, reports its signature, then deletes the key", async () => {
    const { worker, keypair } = await lapsed();
    drained(worker);
    const preview = await ok(hirer, "wallet_worker", { return_leftovers: worker });
    expect(preview).toMatchObject({ returned: sol(0n), sent: false });
    const sending = await counting();
    const done = await ok(sending, "wallet_worker", { return_leftovers: worker, send: true });
    expect(done).toMatchObject({ sent: true, signature: expect.any(String), next: "returned to this wallet", key_deleted: true });
    expect(wires).toBe(1);
    expect(h.files.has(keypair)).toBe(false);
  }, 60_000);

  it("previews nothing to send for a worker that holds nothing, keeps its key on preview, and deletes it on send", async () => {
    const job = await hire(false);
    const { worker, keypair } = await made(job.intent);
    await ok(hirer, "wallet_cancel", { nonce: job.nonce, close: false, send: true });
    drained(worker);
    const preview = await ok(hirer, "wallet_worker", { return_leftovers: worker });
    expect(preview).toMatchObject({ returned: sol(0n), kept: [], sent: false, key_deleted: false, next: NOTHING_LEFT });
    expect(preview["prepared"]).toBeUndefined();
    expect(h.files.has(keypair)).toBe(true);
    const done = await ok(hirer, "wallet_worker", { return_leftovers: worker, send: true });
    expect(done).toMatchObject({ returned: sol(0n), sent: false, key_deleted: true, next: NOTHING_LEFT });
    expect(done["prepared"]).toBeUndefined();
    expect(h.files.has(keypair)).toBe(false);
  });

  it("counts the rent of the wrapped SOL account it closes, and keeps the key when another token stays, even once that token is gone", async () => {
    const job = await hire(false);
    const { worker, keypair } = await made(job.intent);
    await ok(hirer, "wallet_cancel", { nonce: job.nonce, close: false, send: true });
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
    const held = lamportsOf(worker);
    const preview = await ok(hirer, "wallet_worker", { return_leftovers: worker });
    expect(preview["returned"]).toBe(sol(held + rent + WRAPPED));
    expect(preview["summary"][0]).toBe(`${returns(held + rent + WRAPPED, worker)}, including ${sol(WRAPPED)} of wrapped SOL, which holds any pay the worker received`);
    expect(preview["summary"][2]).toBe(`Keeps: ${keypair}, since the worker still holds something`);
    const sending = await counting(() => drained(test));
    expect(await ok(sending, "wallet_worker", { return_leftovers: worker, send: true })).toMatchObject({ sent: true, key_deleted: false });
    expect(h.svm.getAccount(test).exists).toBe(false);
    expect(h.files.has(keypair)).toBe(true);
  });

  it("counts the rent of the announcements it closes", async () => {
    const job = await hire(false);
    const { worker, brief } = await made(job.intent);
    const artifact = workFile(SOLUTION);
    await run(commandNamed(brief, "deliver").map((word) => (word === "<your" ? artifact : word)).filter((word) => word !== "file>"));
    await ok(hirer, "wallet_cancel", { nonce: job.nonce, close: false, send: true });
    const held = lamportsOf(worker);
    const preview = await ok(hirer, "wallet_worker", { return_leftovers: worker });
    expect(preview).toMatchObject({ returned: sol(held + rentOf(getAnnouncementSize())), kept: [] });
  }, 60_000);

  it("closes five announcements at a time and says how many more can close", async () => {
    const job = await hire(false);
    const { worker, brief } = await made(job.intent);
    h.svm.airdrop(worker, lamports(1_000_000_000n));
    const deliver = commandNamed(brief, "deliver");
    for (let n = 0; n < 6; n += 1) {
      const artifact = workFile(new TextEncoder().encode(`export default () => ${n};\n`), `work-${n}.mjs`);
      await run(deliver.map((word) => (word === "<your" ? artifact : word)).filter((word) => word !== "file>"));
    }
    await ok(hirer, "wallet_cancel", { nonce: job.nonce, close: false, send: true });
    const held = lamportsOf(worker);
    const preview = await ok(hirer, "wallet_worker", { return_leftovers: worker });
    expect(preview["kept"]).toEqual(["1 more announcements can close; call again"]);
    expect(preview["returned"]).toBe(sol(held + 5n * rentOf(getAnnouncementSize())));
  }, 120_000);
});
