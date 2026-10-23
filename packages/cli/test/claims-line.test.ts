import { createHash } from "node:crypto";
import { type Address, generateKeyPairSigner, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, formatAmount, getStandbySize, Kind, NATIVE_MINT } from "@intent-engine/core";
import { createClient } from "@intent-engine/client";
import { SIGNATURE_FEE } from "../src/agent/budget.js";
import { tool } from "../src/agent/names.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { EXIT_OK } from "../src/main.js";
import { LAMPORTS_PER_SOL } from "../src/wallet.js";
import { cli, funded, h, NOW, setNow, transport, world } from "./harness.js";

type Json = Record<string, unknown>;

const SPEC = new Uint8Array(createHash("sha256").update("a job with a line").digest());
const STAKE = LAMPORTS_PER_SOL / 20n;
const FEE = `Costs: ${formatAmount(SIGNATURE_FEE, 9)} SOL network fee, paid by this wallet`;

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
  const started = await cli(["mcp", "--url", "devnet", "--wallet"], {});
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

const sol = (address: Address) => h.svm.getBalance(address) ?? 0n;

const entryRent = () => h.svm.minimumBalanceForRentExemption(BigInt(getStandbySize()));

async function job() {
  const w = await world();
  h.files.clear();
  preset(NATIVE_MINT);
  preset(DEVNET_TEST_MINT);
  const holder = await funded();
  const judge = (await generateKeyPairSigner()).address;
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge, specHash: SPEC, judgeFee: 0n } as const;
  const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  const keys = { "owner.json": w.owner, "holder.json": holder };
  const run = async (args: string[]) => {
    const result = await cli(args, keys);
    expect([result.code, result.err]).toEqual([EXIT_OK, ""]);
  };
  await run(["claims", "open", "--keypair", "owner.json", "--nonce", "0", "--max-secs", "3600", "--stake", "0.05", "--yes"]);
  const client = await connect();
  const wallet = (await call(client, "wallet_setup")).value["address"] as Address;
  const escrow = { owner: w.owner.address, nonce: "0" };
  const ok = async (name: string, args: object) => {
    const done = await call(client, name, args);
    expect(done.error, JSON.stringify(done.value)).toBe(false);
    return done.value;
  };
  const sent = async (args: object) => {
    const shown = await ok("wallet_claim", { ...escrow, ...args });
    return ok("wallet_claim", { ...escrow, ...args, approval: shown["approval"], send: true });
  };
  const take = () => run(["claims", "take", "--keypair", "holder.json", "--owner", w.owner.address, "--nonce", "0", "--secs", "600", "--yes"]);
  return { owner: w.owner.address, intent, holder, wallet, client, escrow, ok, sent, take };
}

describe("the stand-by line from wallet_claim", () => {
  it("joins the line behind a held claim, and holds the job once the lapsed claim is advanced", async () => {
    const j = await job();
    await j.take();
    const held = await j.ok("get_claims", j.escrow);
    expect(held).toMatchObject({ escrow: "open", state: "held", worker: j.holder.address });
    expect(held["next"]).toBe(`${j.holder.address} holds this job's claim for 600 more seconds; ${tool("wallet_claim")} action standby joins the line that gets the job next`);
    const preview = await j.ok("wallet_claim", { ...j.escrow, action: "standby", secs: 900 });
    expect(preview["summary"]).toEqual([
      `Stands by: for escrow ${j.intent} as entry 0, place 1 in its line; when the job reaches this wallet ${j.wallet} it holds the claim for 900 seconds`,
      `Locks: a stake of 0.05 SOL and ${formatAmount(entryRent(), 9)} SOL of the entry's rent from this wallet; the stake moves onto the claim when the job reaches it, the rent returns then, and both return when it leaves the line`,
      `${FEE} ${j.wallet}`,
    ]);
    const before = sol(j.wallet);
    expect(await j.sent({ action: "standby", secs: 900 })).toMatchObject({ sent: true, next: `you stand by for ${j.intent} as entry 0; ${tool("get_claims")} shows this wallet as worker once the job reaches it` });
    expect(before - sol(j.wallet)).toBe(STAKE + entryRent() + SIGNATURE_FEE);
    expect(await j.ok("get_claims", j.escrow)).toMatchObject({ waiting: 1, worker: j.holder.address });
    expect((await call(j.client, "wallet_claim", { ...j.escrow, action: "advance" })).value).toMatchObject({ code: "ClaimHeld" });
    setNow(NOW + 600n);
    const lapsed = await j.ok("get_claims", j.escrow);
    expect(lapsed).toMatchObject({ state: "lapsed", waiting: 1 });
    expect(lapsed["next"]).toContain(`${tool("wallet_claim")} action advance hands it to the first`);
    const shown = await j.ok("wallet_claim", { ...j.escrow, action: "advance" });
    expect(shown["summary"]).toEqual([
      `Ends: the lapsed claim of ${j.holder.address}, whose stake of 0.05 SOL goes to the owner ${j.owner}`,
      `Hands: the job to ${j.wallet}, first in the line`,
      `${FEE} ${j.wallet}`,
    ]);
    const owner = sol(j.owner);
    const mine = sol(j.wallet);
    expect(await j.sent({ action: "advance" })).toMatchObject({ sent: true, next: `advanced; ${j.wallet} now holds the claim` });
    expect(sol(j.owner) - owner).toBe(STAKE);
    expect(sol(j.wallet) - mine).toBe(entryRent() - SIGNATURE_FEE);
    expect(await j.ok("get_claims", j.escrow)).toMatchObject({ state: "held", worker: j.wallet, waiting: 0, seconds_left: "900" });
  });

  it("leaves the line and gets the stake and the entry's rent back", async () => {
    const j = await job();
    await j.take();
    await j.sent({ action: "standby", secs: 600 });
    const preview = await j.ok("wallet_claim", { ...j.escrow, action: "leave" });
    expect(preview["summary"]).toEqual([
      `Leaves: entry 0 in the line of escrow ${j.intent}`,
      `Returns: the entry's stake and rent, ${formatAmount(STAKE + entryRent(), 9)} SOL in all, to ${j.wallet}`,
      `${FEE} ${j.wallet}`,
    ]);
    const before = sol(j.wallet);
    expect(await j.sent({ action: "leave" })).toMatchObject({ sent: true, next: `left the line; entry 0's stake and rent returned to ${j.wallet}` });
    expect(sol(j.wallet) - before).toBe(STAKE + entryRent() - SIGNATURE_FEE);
    expect((await call(j.client, "wallet_claim", { ...j.escrow, action: "leave" })).value).toMatchObject({ code: "NotFound" });
  });

  it("refuses to stand by for a free job or without secs, and to advance an empty line", async () => {
    const j = await job();
    const free = await j.ok("get_claims", j.escrow);
    expect(free["next"]).toBe(`the job is free to claim; claim it with ${tool("wallet_claim")} action take before working on it or hosting the work`);
    expect((await call(j.client, "wallet_claim", { ...j.escrow, action: "standby", secs: 60 })).value).toMatchObject({ code: "JobNotHeld" });
    expect((await call(j.client, "wallet_claim", { ...j.escrow, action: "advance" })).value).toMatchObject({ code: "LineEmpty" });
    await j.take();
    expect((await call(j.client, "wallet_claim", { ...j.escrow, action: "standby" })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "secs", message: "give secs with action standby" }] });
    expect((await call(j.client, "wallet_claim", { ...j.escrow, action: "standby", secs: 7200 })).value).toMatchObject({ code: "ClaimTerms" });
    const refused = await call(j.client, "wallet_claim", { ...j.escrow, action: "take", secs: 60 });
    expect(refused.value).toMatchObject({ code: "ClaimHeld" });
    expect(String(refused.value["hint"])).toContain(`join the line with ${tool("wallet_claim")} action standby`);
  });
});
