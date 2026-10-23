import { type Address, generateKeyPairSigner, lamports, none } from "@solana/kit";
import { AccountState, getMintEncoder, getMintSize, getTokenEncoder, getTokenSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import {
  DEVNET_TEST_MINT,
  EVENT_IX_TAG,
  findAssociatedTokenAddress,
  findIntentPda,
  formatAmount,
  getIntentAttestedEventEncoder,
  getIntentCreatedEventEncoder,
  NATIVE_MINT,
  splitFee,
} from "@intent-engine/core";
import type { EngineTransaction } from "@intent-engine/client";
import { tool } from "../src/agent/names.js";
import { WALLET_ACTIONS } from "../src/agent/wallet.js";
import { EARLIEST_MEANS, escrowClosed, noEscrow } from "../src/agent/wallet/delivery.js";
import { ALSO_MAX, noneKnown, noneReleased, paidOther, stillUnreleased } from "../src/agent/wallet/receipt.js";
import { EXIT_OK } from "../src/main.js";
import { LAMPORTS_PER_SOL } from "../src/wallet.js";
import { cli, FEE_BPS, h, world } from "./harness.js";

type Json = Record<string, unknown> & { [key: string]: any };

const tag = (body: ArrayLike<number>) => new Uint8Array([...EVENT_IX_TAG, ...Array.from(body)]);

function preset(at: Address): void {
  const space = BigInt(getMintSize());
  h.svm.setAccount({
    address: at,
    data: Uint8Array.from(getMintEncoder().encode({ mintAuthority: none(), supply: 0n, decimals: 9, isInitialized: true, freezeAuthority: none() })),
    executable: false,
    lamports: lamports(h.svm.minimumBalanceForRentExemption(space)),
    programAddress: TOKEN_PROGRAM_ADDRESS,
    space,
  });
}

function tokenAccountAt(address: Address, holder: Address): void {
  const space = BigInt(getTokenSize());
  h.svm.setAccount({
    address,
    data: Uint8Array.from(
      getTokenEncoder().encode({ mint: NATIVE_MINT, owner: holder, amount: 0n, delegate: none(), state: AccountState.Initialized, isNative: none(), delegatedAmount: 0n, closeAuthority: none() }),
    ),
    executable: false,
    lamports: lamports(h.svm.minimumBalanceForRentExemption(space)),
    programAddress: TOKEN_PROGRAM_ADDRESS,
    space,
  });
}

async function connect(flags: string[]): Promise<Client> {
  h.served.length = 0;
  const started = await cli(["mcp", "--url", "devnet", ...flags], {});
  expect(started.code).toBe(EXIT_OK);
  const [near, far] = InMemoryTransport.createLinkedPair();
  await h.served[0]?.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return client;
}

async function call(client: Client, name: string, args: object = {}) {
  const result = await client.callTool({ name: tool(name), arguments: args as Record<string, unknown> });
  return { error: result.isError === true, value: result.structuredContent as Json };
}

async function ok(client: Client, name: string, args: object = {}): Promise<Json> {
  const { error, value } = await call(client, name, args);
  expect(error, JSON.stringify(value)).toBe(false);
  return value;
}

type Escrow = { owner: Address; nonce: bigint; intent: Address };

const createdOf = ({ owner, nonce, intent }: Escrow): EngineTransaction => ({
  signature: `create-${intent}`,
  slot: 1n,
  blockTime: null,
  failed: false,
  emitted: [
    tag(
      getIntentCreatedEventEncoder().encode({
        intent,
        owner,
        nonce,
        kind: 4,
        inputMint: NATIVE_MINT,
        outputMint: DEVNET_TEST_MINT,
        receiver: owner,
        escrowed: LAMPORTS_PER_SOL / 20n,
        expiresAt: 0n,
        rentPayer: owner,
        flags: 0,
        bounty: 0,
        createFee: 0,
      }),
    ),
  ],
});

const { fee, net } = splitFee(LAMPORTS_PER_SOL / 20n, FEE_BPS);

const releaseOf = ({ owner, intent }: Escrow, payee: Address, attestor: Address): EngineTransaction => ({
  signature: `release-${intent}`,
  slot: 3n,
  blockTime: null,
  failed: false,
  emitted: [
    tag(
      getIntentAttestedEventEncoder().encode({
        intent,
        owner,
        solver: attestor,
        payee,
        attestor,
        amountIn: LAMPORTS_PER_SOL / 20n,
        result: 1n,
        fee,
        net,
        filled: LAMPORTS_PER_SOL / 20n,
        remaining: 0n,
        partnerFee: 0n,
      }),
    ),
  ],
});

async function escrowOf(nonce: bigint): Promise<Escrow> {
  const owner = (await generateKeyPairSigner()).address;
  const [intent] = await findIntentPda({ owner, nonce });
  return { owner, nonce, intent };
}

async function setUp(flags = ["--wallet", "--all-tools"]) {
  await world();
  h.files.clear();
  preset(NATIVE_MINT);
  preset(DEVNET_TEST_MINT);
  const client = await connect(flags);
  const self = flags.includes("--wallet") ? ((await ok(client, "wallet_setup"))["address"] as Address) : undefined;
  if (self !== undefined) {
    h.watched.push(self);
  }
  const worker = (await generateKeyPairSigner()).address;
  const judge = (await generateKeyPairSigner()).address;
  const payee = await findAssociatedTokenAddress({ owner: worker, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  tokenAccountAt(payee, worker);
  const jobs = [await escrowOf(1n), await escrowOf(2n), await escrowOf(3n)];
  h.engineLog = [];
  h.rounds = 10;
  return { client, worker, judge, payee, jobs, self: self as Address };
}

const named = ({ owner, nonce }: Escrow) => ({ owner, nonce: String(nonce) });

const unreleased = (job: Escrow) => ({ ...named(job), intent: job.intent, released: false });

describe("waiting on several escrows at once", () => {
  it("returns the escrow released among several, naming it and whom it paid, whichever place it has", async () => {
    const { client, worker, judge, payee, jobs, self } = await setUp();
    const [first, second, third] = jobs as [Escrow, Escrow, Escrow];
    const created = jobs.map(createdOf);
    const args = { ...named(first), also: [named(second), named(third)] };
    for (const name of ["wallet_receipt", "get_receipt"]) {
      const own = name === "wallet_receipt" ? { paid_this_wallet: false } : {};
      for (const released of [second, third]) {
        h.engineLog = [releaseOf(released, payee, judge), ...created];
        h.sleeps.length = 0;
        expect(await ok(client, name, args)).toEqual({
          ...own,
          ...(name === "wallet_receipt" ? { next: paidOther([worker], self) } : {}),
          escrows: jobs.map((job) => (job === released ? { ...named(job), intent: job.intent, released: true, paid_to: worker, ...own } : unreleased(job))),
          intent: released.intent,
          released: true,
          owner: released.owner,
          nonce: String(released.nonce),
          paid_to: worker,
          payee,
          paid: formatAmount(net, 9),
          mint: NATIVE_MINT,
          attestor: judge,
          result: "1",
          signature: `release-${released.intent}`,
        });
        h.engineLog = [...created];
        h.onSleep = [() => undefined, () => (h.engineLog = [releaseOf(released, payee, judge), ...created])];
        expect(await ok(client, name, { ...args, wait: 5 })).toMatchObject({ intent: released.intent, released: true, owner: released.owner, nonce: String(released.nonce), paid_to: worker });
        expect(h.sleeps).toEqual([1, 1]);
      }
    }
  });

  it("says none of them is released yet with the same text whether or not it waited, and that the read was partial when it was", async () => {
    const { client, jobs } = await setUp();
    const [first, second, third] = jobs as [Escrow, Escrow, Escrow];
    const args = { ...named(first), also: [named(second), named(third)] };
    for (const name of ["wallet_receipt", "get_receipt"]) {
      h.engineLog = jobs.map(createdOf);
      const none = { intent: first.intent, released: false, next: noneReleased(name, 3), escrows: jobs.map(unreleased) };
      expect(await ok(client, name, args)).toEqual(none);
      h.sleeps.length = 0;
      expect(await ok(client, name, { ...args, wait: 3 })).toEqual(none);
      expect(h.sleeps).toEqual([1, 1, 1]);
      h.engineLog = [createdOf(first), createdOf(second)];
      const partial = await ok(client, name, args);
      expect(partial).toMatchObject({ intent: first.intent, released: false, complete: false, next: noneKnown(name, 3) });
      expect(partial["escrows"]).toContainEqual({ ...unreleased(third), complete: false });
      h.engineLog = [createdOf(first)];
      const alone = { intent: first.intent, released: false, next: stillUnreleased(name) };
      expect(await ok(client, name, named(first))).toEqual(alone);
      expect(await ok(client, name, { ...named(first), also: [] })).toEqual(alone);
      h.sleeps.length = 0;
      expect(await ok(client, name, { ...named(first), wait: 2 })).toEqual(alone);
      expect(h.sleeps.length).toBeGreaterThan(0);
    }
    expect(stillUnreleased("wallet_receipt")).toContain("again with wait, in seconds");
    expect(noneReleased("wallet_receipt", 3)).toContain("again with wait, in seconds");
  });

  it("takes at most ten escrows, each by owner and nonce", async () => {
    const { client, jobs } = await setUp();
    const [first, second] = jobs as [Escrow, Escrow];
    const many = Array.from({ length: ALSO_MAX + 1 }, () => named(second));
    expect(ALSO_MAX + 1).toBe(10);
    expect((await call(client, "wallet_receipt", { ...named(first), also: many })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "also" }] });
    expect((await call(client, "wallet_receipt", { ...named(first), also: [{ nonce: "2" }] })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "also.0.owner" }] });
    h.engineLog = [createdOf(first), createdOf(second)];
    expect(await ok(client, "wallet_receipt", { ...named(first), also: many.slice(1) })).toMatchObject({ released: false, next: noneReleased("wallet_receipt", ALSO_MAX + 1) });
  });
});

describe("checking delivery on a closed escrow", () => {
  it("points to the receipt with the escrow's owner and nonce, and the receipt finds its release", async () => {
    const { client, judge, payee, worker, jobs } = await setUp();
    const [closed] = jobs as [Escrow];
    h.engineLog = [releaseOf(closed, payee, judge), createdOf(closed)];
    expect((await call(client, "wallet_check_delivery", { intent: closed.intent })).value).toMatchObject({
      code: "NotFound",
      hint: escrowClosed(closed.intent, closed.owner, closed.nonce, "wallet_receipt"),
    });
    expect((await call(client, "check_delivery", { intent: closed.intent })).value).toMatchObject({
      code: "NotFound",
      hint: escrowClosed(closed.intent, closed.owner, closed.nonce, "get_receipt"),
    });
    expect(escrowClosed(closed.intent, closed.owner, closed.nonce, "wallet_receipt")).toContain(`solive_wallet_receipt with owner ${closed.owner} and nonce ${closed.nonce}`);
    expect(await ok(client, "wallet_receipt", named(closed))).toMatchObject({ intent: closed.intent, released: true, paid_to: worker });
    h.engineLog = [];
    expect((await call(client, "wallet_check_delivery", { intent: closed.intent })).value).toMatchObject({ code: "NotFound", hint: noEscrow(closed.intent, "wallet_receipt") });
    expect(noEscrow(closed.intent, "wallet_receipt")).toContain("solive_wallet_receipt with the escrow's owner and nonce");
  });

  it("says own.earliest is about the given sha256, not the whole escrow", () => {
    const check = WALLET_ACTIONS.find((action) => action.name === tool("wallet_check_delivery"));
    const own = (check?.output.json as Json)["properties"]["own"];
    expect(own["properties"]["earliest"]["description"]).toBe(EARLIEST_MEANS);
    expect(EARLIEST_MEANS).toContain("about the given sha256, not the whole escrow");
    expect(EARLIEST_MEANS).toContain("no earlier announcement of that same work is known");
  });
});
