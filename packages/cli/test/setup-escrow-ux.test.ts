import { type Address, lamports, none, some } from "@solana/kit";
import { AccountState, getMintEncoder, getMintSize, getTokenEncoder, getTokenSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import {
  DEVNET_TEST_MINT as TEST_TOKEN,
  EVENT_IX_TAG,
  findAssociatedTokenAddress,
  formatAmount,
  getIntentAttestedEventEncoder,
  getIntentDecoder,
  getIntentEncoder,
  IntentStatus,
  NATIVE_MINT,
  splitFee,
} from "@intent-engine/core";
import { beforeEach, describe, expect, it } from "vitest";
import { WALLET_SMALL_START, WALLET_START } from "../src/agent/wallet/account.js";
import { PIECE_ONE, recordAccountWhy, SPEC_MUST } from "../src/agent/wallet/escrow.js";
import { RELEASE_LANDING, stillUnknown, stillUnreleased } from "../src/agent/wallet/receipt.js";
import { unwrapped, unwrapReturns } from "../src/agent/wallet/unwrap.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { EXIT_OK } from "../src/main.js";
import { AIRDROPS, airdropRefused, CLI_START, ENOUGH_TO_START, heldRefused, holdsEnough, LAMPORTS_PER_SOL, refusedEnough } from "../src/wallet.js";
import { cli, creation, FEE_BPS, h, world } from "./harness.js";

type Json = Record<string, unknown> & { [key: string]: any };

const OLD_NEXT = "your wallet is ready; try offering 0.05 SOL for at least 5 TEST";

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

function tokenAccount(address: Address, mint: Address, owner: Address, amount: bigint, native: boolean): bigint {
  const space = BigInt(getTokenSize());
  const rent = h.svm.minimumBalanceForRentExemption(space);
  h.svm.setAccount({
    address,
    data: Uint8Array.from(
      getTokenEncoder().encode({
        mint,
        owner,
        amount,
        delegate: none(),
        state: AccountState.Initialized,
        isNative: native ? some(rent) : none(),
        delegatedAmount: 0n,
        closeAuthority: none(),
      }),
    ),
    executable: false,
    lamports: lamports(native ? rent + amount : rent),
    programAddress: TOKEN_PROGRAM_ADDRESS,
    space,
  });
  return rent;
}

async function connect(argv: string[]): Promise<Client> {
  h.served.length = 0;
  const started = await cli(argv, {});
  expect([started.code, started.err]).toEqual([EXIT_OK, WALLET_NOTICE.join("\n")]);
  const server = h.served[0];
  if (server === undefined) {
    throw new Error("no server was started");
  }
  const [near, far] = InMemoryTransport.createLinkedPair();
  await server.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return client;
}

async function call(client: Client, name: string, args: object = {}) {
  const result = await client.callTool({ name: `solive_${name}`, arguments: args as Record<string, unknown> });
  return { error: result.isError === true, value: result.structuredContent as Json };
}

async function ok(client: Client, name: string, args: object = {}): Promise<Json> {
  const { error, value } = await call(client, name, args);
  expect(error, JSON.stringify(value)).toBe(false);
  return value;
}

describe("setup, escrow and balance explain themselves", () => {
  let client: Client;

  beforeEach(async () => {
    await world();
    h.files.clear();
    for (const name of Object.keys(h.env)) {
      delete h.env[name];
    }
    preset(NATIVE_MINT);
    preset(TEST_TOKEN);
    client = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
  });

  it("says what a wallet holds when devnet refuses the airdrop, and whether that is enough to start", async () => {
    h.airdropRefused = true;
    const empty = await ok(client, "wallet_setup");
    const address = empty["address"] as Address;
    expect(empty).toMatchObject({ sol: "0", next: airdropRefused(address) });
    h.svm.airdrop(address, lamports(LAMPORTS_PER_SOL / 50n));
    const low = await ok(client, "wallet_setup");
    expect(low).toMatchObject({ sol: "0.02", next: heldRefused("0.02", address) });
    expect(low["next"]).toContain(`your wallet holds 0.02 SOL, less than the ${formatAmount(ENOUGH_TO_START, 9)} SOL setup counts as enough to start`);
    expect(low["next"]).not.toContain("--faucet");
    h.svm.airdrop(address, lamports(ENOUGH_TO_START - LAMPORTS_PER_SOL / 50n));
    const small = await ok(client, "wallet_setup");
    expect(small).toMatchObject({ sol: "0.06", next: refusedEnough("0.06", WALLET_SMALL_START) });
    h.svm.airdrop(address, lamports(LAMPORTS_PER_SOL / 4n));
    const held = await ok(client, "wallet_setup");
    expect(held["next"]).not.toBe(OLD_NEXT);
    expect(held).toMatchObject({ sol: "0.31", next: refusedEnough("0.31", WALLET_START) });
    expect(held["next"]).toMatch(/^devnet refused more free SOL, but your wallet holds 0\.31 SOL, enough to start; /);
    expect(h.airdrops).toHaveLength(4 * AIRDROPS.length);
  });

  it("points a funded wallet at trading, hiring and earning, also when only the everyday tools are served", async () => {
    const made = await ok(client, "wallet_setup");
    expect(made).toMatchObject({ sol: "1", next: holdsEnough("1", WALLET_START) });
    for (const name of ["solive_wallet_swap", "solive_wallet_escrow", "solive_find_jobs"]) {
      expect(made["next"]).toContain(name);
    }
    const everyday = await connect(["mcp", "--url", "devnet", "--wallet"]);
    const again = await ok(everyday, "wallet_setup");
    expect(again).toMatchObject({ sol: "1", next: holdsEnough("1", WALLET_START) });
    expect(holdsEnough("1", CLI_START)).toBe("your wallet holds 1 SOL, enough to start; try offering 0.05 SOL for at least 5 TEST");
    const { tools } = await client.listTools();
    const setup = tools.find((t) => t.name === "solive_wallet_setup")?.description ?? "";
    expect(setup).toContain("asks devnet for free SOL below 0.5 SOL. Devnet may refuse; next says what the wallet holds and whether that is enough to start");
    expect(setup).not.toContain("tops it up");
  });

  it("tells a hirer it may judge its own escrow and what a spec must say", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    const { tools } = await client.listTools();
    const escrow = tools.find((t) => t.name === "solive_wallet_escrow");
    expect(escrow?.description).toContain("this wallet may be the attestor");
    expect(escrow?.description).toContain(`${SPEC_MUST}.`);
    const properties = (escrow?.inputSchema as { properties: Record<string, { description?: string }> }).properties;
    expect(properties["attestor"]?.description).toContain("this wallet's own address to judge the work yourself");
    expect(properties["spec_hash"]?.description).toContain(SPEC_MUST);
    const own = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: owner, spec_hash: "61".repeat(32) });
    expect(own).toMatchObject({ sent: false });
  });

  it("says why a SOL escrow creates a token account for the token it only records, and stays quiet once it exists", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    const creates = `Setup: creates your token account for ${TEST_TOKEN} (you pay its rent)`;
    const preview = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: owner, spec_hash: "62".repeat(32) });
    const summary = preview["summary"] as string[];
    expect(summary.indexOf(recordAccountWhy(TEST_TOKEN))).toBe(summary.indexOf(creates) + 1);
    expect(recordAccountWhy(TEST_TOKEN)).toContain("even though an escrow pays nothing into it");
    const plan = await ok(client, "wallet_escrow_plan", {
      sell: "SOL",
      attestor: owner,
      spec_hash: "63".repeat(32),
      pieces: [
        { name: "one", amount: "0.02" },
        { name: "two", amount: "0.02" },
      ],
    });
    expect(plan["summary"]).toContain(`${PIECE_ONE}: ${recordAccountWhy(TEST_TOKEN)}`);
    const mine = await findAssociatedTokenAddress({ owner, mint: TEST_TOKEN, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const sent = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: owner, spec_hash: "64".repeat(32), send: true });
    expect(sent).toMatchObject({ sent: true });
    expect(h.svm.getAccount(mine).exists).toBe(true);
    const later = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: owner, spec_hash: "65".repeat(32) });
    expect(later["summary"]).not.toContain(creates);
    expect(later["summary"]).not.toContain(recordAccountWhy(TEST_TOKEN));
  });

  it("names the rent an unwrap returns, and the balance stops listing the closed account", async () => {
    const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
    const wrapped = await findAssociatedTokenAddress({ owner: wallet, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const held = 48_500_000n;
    const rent = tokenAccount(wrapped, NATIVE_MINT, wallet, held, true);
    const [kept, total] = [formatAmount(rent, 9), formatAmount(rent + held, 9)];
    expect((await ok(client, "wallet_balance"))["tokens"][0]).toEqual({ mint: NATIVE_MINT, name: "wrapped SOL", account: wrapped, balance: "0.0485" });
    const preview = await ok(client, "wallet_unwrap");
    expect(preview).toMatchObject({ account: wrapped, wrapped: "0.0485", rent: kept, sent: false });
    expect(preview["summary"]).toContain(unwrapReturns("0.0485", kept, total));
    expect(unwrapReturns("0.0485", kept, total)).toBe(`Returns: ${total} SOL to this wallet, the 0.0485 wrapped plus the account's ${kept} SOL rent deposit`);
    const before = h.svm.getBalance(wallet) ?? 0n;
    const done = await ok(client, "wallet_unwrap", { send: true });
    expect(done).toMatchObject({ sent: true, next: unwrapped("0.0485", kept, total) });
    const gained = (h.svm.getBalance(wallet) ?? 0n) - before;
    expect(gained).toBeLessThan(rent + held);
    expect(gained).toBeGreaterThan(rent + held - 100_000n);
    expect(h.svm.getAccount(wrapped).exists).toBe(false);
    const after = await ok(client, "wallet_balance");
    expect(after["tokens"][0]).toEqual({ mint: NATIVE_MINT, name: "wrapped SOL", balance: "0" });
    expect(JSON.stringify(after)).not.toContain(wrapped);
  });

  it("says a release landed but is not readable yet, instead of not released, and waits until the node returns it", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    const escrow = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: owner, spec_hash: "66".repeat(32), send: true });
    const intent = escrow["intent"] as Address;
    const nonce = escrow["nonce"] as string;
    h.engineLog = [creation(intent)];
    expect(await ok(client, "wallet_receipt", { nonce })).toMatchObject({ released: false, next: stillUnreleased("wallet_receipt") });
    const account = h.svm.getAccount(intent);
    if (!account.exists) {
      throw new Error("the escrow was not created");
    }
    h.svm.setAccount({ ...account, data: Uint8Array.from(getIntentEncoder().encode({ ...getIntentDecoder().decode(account.data), status: IntentStatus.Filled })) });
    expect(await ok(client, "wallet_receipt", { nonce })).toEqual({ intent, released: false, complete: false, next: RELEASE_LANDING });
    h.rounds = 10;
    h.sleeps.length = 0;
    const { net, fee } = splitFee(LAMPORTS_PER_SOL / 20n, FEE_BPS);
    const attested = getIntentAttestedEventEncoder().encode({
      intent,
      owner,
      solver: owner,
      payee: owner,
      attestor: owner,
      amountIn: LAMPORTS_PER_SOL / 20n,
      result: 1n,
      fee,
      net,
      filled: LAMPORTS_PER_SOL / 20n,
      remaining: 0n,
      partnerFee: 0n,
    });
    const release = { signature: "release", slot: 3n, blockTime: null, failed: false, emitted: [new Uint8Array([...EVENT_IX_TAG, ...Array.from(attested)])] };
    h.onSleep = [() => undefined, () => (h.engineLog = [release])];
    expect(await ok(client, "wallet_receipt", { nonce, wait: 5 })).toMatchObject({ intent, released: true, signature: "release" });
    expect(h.sleeps).toEqual([1, 1]);
    h.engineLog = [creation(intent)];
    h.sleeps.length = 0;
    h.rounds = 2;
    expect(await ok(client, "wallet_receipt", { nonce, wait: 3 })).toEqual({ intent, released: false, complete: false, next: stillUnknown("wallet_receipt") });
    expect(stillUnknown("wallet_receipt")).not.toBe(stillUnreleased("wallet_receipt"));
  });
});
