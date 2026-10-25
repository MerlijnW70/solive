import { type Address, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, formatAmount, NATIVE_MINT } from "@intent-engine/core";
import { buildClaimJob, claimBoardAddress, getClaimBoardSize } from "@intent-engine/core/internal";
import { SIGNATURE_FEE } from "../src/agent/budget.js";
import { closedEscrow, settleCall } from "../src/agent/claim-line.js";
import { tool } from "../src/agent/names.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { EXIT_OK } from "../src/main.js";
import { LAMPORTS_PER_SOL } from "../src/wallet.js";
import { cli, funded, h, NOW, send, setNow, world } from "./harness.js";
import { announced } from "./announce.js";
import { approved } from "./approved.js";

type Json = Record<string, unknown> & { [key: string]: any };

const SPEC_HASH = "5d".repeat(32);
const STAKE = LAMPORTS_PER_SOL / 20n;
const WORK = "e7".repeat(32);

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

async function connect(): Promise<Client> {
  h.served.length = 0;
  const started = await cli(["mcp", "--url", "devnet", "--wallet", "--all-tools"], {});
  expect([started.code, started.err]).toEqual([EXIT_OK, WALLET_NOTICE.join("\n")]);
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

const sol = (address: Address) => h.svm.getBalance(address) ?? 0n;

const rent = () => h.svm.minimumBalanceForRentExemption(BigInt(getClaimBoardSize()));

const leaves = (board: Address, owner: Address, nonce: string) =>
  `the claims board ${board} stays open afterwards, holding ${formatAmount(rent(), 9)} SOL of rent that ${owner} paid; ${settleCall(owner, BigInt(nonce))} closes it and returns that rent to ${owner}`;

describe("settling a claims board from the wallet tools", () => {
  let client: Client;
  let wallet: Address;

  beforeEach(async () => {
    await world();
    h.files.clear();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    client = await connect();
    wallet = (await ok(client, "wallet_setup"))["address"] as Address;
    h.watched.push(wallet);
    h.engineLog = [];
  });

  async function escrow() {
    const made = await ok(client, "wallet_escrow", await approved(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: wallet, spec_hash: SPEC_HASH, claim_stake: "0.05", claim_secs: 3600 }));
    const intent = made["intent"] as Address;
    const nonce = made["nonce"] as string;
    return { intent, nonce, board: await claimBoardAddress(intent), ref: { owner: wallet, nonce } };
  }

  async function sent(args: object): Promise<Json> {
    const shown = await ok(client, "wallet_claim", args);
    expect(shown["sent"]).toBe(false);
    return ok(client, "wallet_claim", { ...args, approval: shown["approval"], send: true });
  }

  it("wallet_attest names the settle call, and settling closes the board and returns its rent less the fee to the owner", async () => {
    const job = await escrow();
    const worker = await funded();
    await send(worker, [await buildClaimJob({ worker, intent: job.intent, owner: wallet, secs: 600 })]);
    await announced(job.intent, worker, WORK);
    const release = { ...job.ref, delivered_sha256: WORK };
    const shown = await ok(client, "wallet_attest", release);
    expect(shown["summary"]).toContain(`Leaves: ${leaves(job.board, wallet, job.nonce)}`);
    const released = await ok(client, "wallet_attest", { ...release, approval: shown["approval"], send: true });
    expect(released["next"]).toBe(`released to ${worker.address}; ${tool("wallet_feedback")} to rate; ${leaves(job.board, wallet, job.nonce)}`);
    expect(sol(job.board)).toBe(rent());
    const read = await ok(client, "get_claims", job.ref);
    expect(read).toMatchObject({ takes_claims: true, escrow: "released", state: "free" });
    expect(read["next"]).toBe(`${closedEscrow(job.intent, "released")}; ${settleCall(wallet, BigInt(job.nonce))} closes its claims board and returns the rent to ${wallet}`);
    expect(read["next"]).not.toContain("action take");
    const preview = await ok(client, "wallet_claim", { ...job.ref, action: "settle" });
    expect(preview["summary"]).toEqual([
      "Moves: no stake; nobody holds the claim",
      `Closes: the claims board ${job.board}, returning its ${formatAmount(rent(), 9)} SOL of rent to the owner ${wallet}`,
      `Costs: ${formatAmount(SIGNATURE_FEE, 9)} SOL network fee, paid by this wallet ${wallet}`,
    ]);
    const before = sol(wallet);
    const settled = await sent({ ...job.ref, action: "settle" });
    expect(settled).toMatchObject({ sent: true, action: "settle", next: `settled; the claims board is closed and its rent returned to ${wallet}` });
    expect(sol(wallet) - before).toBe(rent() - SIGNATURE_FEE);
    expect(sol(job.board)).toBe(0n);
    expect(await ok(client, "get_claims", job.ref)).toEqual({ intent: job.intent, takes_claims: false, escrow: "released", next: closedEscrow(job.intent, "released") });
    expect((await call(client, "wallet_claim", { ...job.ref, action: "settle" })).value).toMatchObject({ code: "ClaimsMissing" });
  });

  it("wallet_attest_split names the settle call for the board it leaves", async () => {
    const job = await escrow();
    const worker = await funded();
    await announced(job.intent, worker, WORK);
    const shown = await ok(client, "wallet_attest_split", { ...job.ref, delivered_sha256: WORK, recipients: [{ wallet: worker.address, weight: 10000 }] });
    expect(shown["summary"]).toContain(`Leaves: ${leaves(job.board, wallet, job.nonce)}`);
  });

  it("wallet_cancel names the settle call, and settle closes the board of the cancelled escrow", async () => {
    const job = await escrow();
    const shown = await ok(client, "wallet_cancel", { nonce: job.nonce });
    expect(shown["summary"]).toContain(`Leaves: ${leaves(job.board, wallet, job.nonce)}`);
    const cancelled = await ok(client, "wallet_cancel", { nonce: job.nonce, send: true });
    expect(cancelled["next"]).toBe(`cancelled; ${tool("wallet_balance")} to see the refund; ${leaves(job.board, wallet, job.nonce)}`);
    expect(await ok(client, "get_claims", job.ref)).toMatchObject({ takes_claims: true, escrow: "gone" });
    const before = sol(wallet);
    expect(await sent({ ...job.ref, action: "settle" })).toMatchObject({ sent: true });
    expect(sol(wallet) - before).toBe(rent() - SIGNATURE_FEE);
    expect(sol(job.board)).toBe(0n);
  });

  it("settle on an open escrow takes a lapsed claim's stake for the owner and keeps the board, and refuses while there is nothing to settle", async () => {
    const job = await escrow();
    expect((await call(client, "wallet_claim", { ...job.ref, action: "settle" })).value).toMatchObject({ code: "InvalidTransition" });
    const worker = await funded();
    await send(worker, [await buildClaimJob({ worker, intent: job.intent, owner: wallet, secs: 600 })]);
    expect((await call(client, "wallet_claim", { ...job.ref, action: "settle" })).value).toMatchObject({ code: "ClaimHeld" });
    setNow(NOW + 600n);
    const preview = await ok(client, "wallet_claim", { ...job.ref, action: "settle" });
    expect(preview["summary"]).toEqual([`Moves: the claim stake of 0.05 SOL to ${wallet}`, `Costs: ${formatAmount(SIGNATURE_FEE, 9)} SOL network fee, paid by this wallet ${wallet}`]);
    const before = sol(wallet);
    expect(await sent({ ...job.ref, action: "settle" })).toMatchObject({ sent: true, next: `settled; the lapsed claim's stake went to ${wallet}` });
    expect(sol(wallet) - before).toBe(STAKE - SIGNATURE_FEE);
    expect(sol(job.board)).toBe(rent());
    expect(await ok(client, "get_claims", job.ref)).toMatchObject({ takes_claims: true, escrow: "open", state: "free" });
  });

  it("refuses a settle send that differs from its preview", async () => {
    const job = await escrow();
    await ok(client, "wallet_cancel", { nonce: job.nonce, send: true });
    expect((await call(client, "wallet_claim", { ...job.ref, action: "settle", approval: "0".repeat(16), send: true })).value).toMatchObject({ code: "ReleaseChanged" });
    expect(sol(job.board)).toBe(rent());
  });
});
