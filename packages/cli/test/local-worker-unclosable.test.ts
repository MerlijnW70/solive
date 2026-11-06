import { type Address, generateKeyPairSigner, lamports, none, some } from "@solana/kit";
import { AccountState, getTokenEncoder, getTokenSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import type { Client } from "@modelcontextprotocol/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, findAssociatedTokenAddress } from "@intent-engine/core";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@intent-engine/core/internal";
import { OTHER_CLOSE_AUTHORITY, FROZEN, unclosable, WITHHELD_FEES } from "../src/agent/wallet/worker-return.js";
import { h } from "./harness.js";
import { cancelledOver, hireWith, lamportsOf, makeWorker, ok, removeWorkFiles, startHirer } from "./local-worker-kit.js";

type Plant = { owner: Address; mint: Address; state?: AccountState; closeAuthority?: Address; program?: Address; tail?: Uint8Array };

const plant = async ({ owner, mint, state = AccountState.Initialized, closeAuthority, program = TOKEN_PROGRAM_ADDRESS, tail }: Plant): Promise<Address> => {
  const held = await findAssociatedTokenAddress({ owner, mint, tokenProgram: program });
  const base = Uint8Array.from(getTokenEncoder().encode({ mint, owner, amount: 0n, delegate: none(), state, isNative: none(), delegatedAmount: 0n, closeAuthority: closeAuthority === undefined ? none() : some(closeAuthority) }));
  const data = tail === undefined ? base : Uint8Array.from([...base, ...new Uint8Array(165 - base.length), 2, ...tail]);
  h.svm.setAccount({ address: held, data, executable: false, lamports: lamports(h.svm.minimumBalanceForRentExemption(BigInt(getTokenSize()))), programAddress: program, space: BigInt(data.length) });
  return held;
};

const fees = (withheld: number): Uint8Array => {
  const out = new Uint8Array(12);
  const view = new DataView(out.buffer);
  view.setUint16(0, 2, true);
  view.setUint16(2, 8, true);
  view.setBigUint64(4, BigInt(withheld), true);
  return out;
};

describe("a local worker's leftovers with an account that cannot close", () => {
  let hirer: Client;
  let wallet: Address;

  const ended = async () => {
    const job = await hireWith(hirer, wallet, false);
    const made = await makeWorker(hirer, job.intent);
    await cancelledOver(hirer, job.nonce);
    return made;
  };

  const anyMint = async () => (await generateKeyPairSigner()).address;

  beforeEach(async () => {
    ({ hirer, wallet } = await startHirer());
  });

  afterEach(removeWorkFiles);

  it("leaves out a frozen empty account and names it, sweeps the rest and keeps the key", async () => {
    const { worker, keypair } = await ended();
    const frozen = await plant({ owner: worker, mint: DEVNET_TEST_MINT, state: AccountState.Frozen });
    const empty = await plant({ owner: worker, mint: await anyMint() });
    const preview = await ok(hirer, "wallet_worker", { return_leftovers: worker });
    expect(preview["kept"]).toContain(unclosable(frozen, DEVNET_TEST_MINT, FROZEN, keypair));
    const done = await ok(hirer, "wallet_worker", { return_leftovers: worker, send: true });
    expect(done).toMatchObject({ sent: true, key_deleted: false });
    expect(done["kept"]).toContain(unclosable(frozen, DEVNET_TEST_MINT, FROZEN, keypair));
    expect(h.svm.getAccount(empty).exists).toBe(false);
    expect(h.svm.getAccount(frozen).exists).toBe(true);
    expect(lamportsOf(worker)).toBe(0n);
    expect(h.files.has(keypair)).toBe(true);
  });

  it("leaves out a Token-2022 account with withheld fees and closes one without", async () => {
    const { worker } = await ended();
    const mint = await anyMint();
    const withheld = await plant({ owner: worker, mint, program: TOKEN_2022_PROGRAM_ADDRESS, tail: fees(5) });
    const clean = await plant({ owner: worker, mint: await anyMint(), program: TOKEN_2022_PROGRAM_ADDRESS, tail: fees(0) });
    const preview = await ok(hirer, "wallet_worker", { return_leftovers: worker });
    expect(preview["kept"]).toEqual([expect.stringContaining(withheld)]);
    expect(preview["kept"][0]).toContain(WITHHELD_FEES);
    expect(preview["kept"].join(" ")).not.toContain(clean);
  });

  it("leaves out an account whose close authority is another address", async () => {
    const { worker, keypair } = await ended();
    const mint = await anyMint();
    const foreign = await plant({ owner: worker, mint, closeAuthority: wallet });
    const own = await plant({ owner: worker, mint: await anyMint(), closeAuthority: worker });
    const preview = await ok(hirer, "wallet_worker", { return_leftovers: worker });
    expect(preview["kept"]).toEqual([unclosable(foreign, mint, OTHER_CLOSE_AUTHORITY, keypair)]);
    const done = await ok(hirer, "wallet_worker", { return_leftovers: worker, send: true });
    expect(done).toMatchObject({ sent: true, key_deleted: false });
    expect(h.svm.getAccount(own).exists).toBe(false);
    expect(h.svm.getAccount(foreign).exists).toBe(true);
    expect(h.files.has(keypair)).toBe(true);
  });

  it("sweeps and deletes the key as before when every account can close", async () => {
    const { worker, keypair } = await ended();
    const empty = await plant({ owner: worker, mint: await anyMint() });
    const preview = await ok(hirer, "wallet_worker", { return_leftovers: worker });
    expect(preview["kept"]).toEqual([]);
    expect(await ok(hirer, "wallet_worker", { return_leftovers: worker, send: true })).toMatchObject({ sent: true, key_deleted: true });
    expect(h.svm.getAccount(empty).exists).toBe(false);
    expect(h.files.has(keypair)).toBe(false);
  });
});
