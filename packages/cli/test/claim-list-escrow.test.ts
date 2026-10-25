import { createHash, generateKeyPairSync } from "node:crypto";
import { type Address, getAddressDecoder, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, formatAmount, NATIVE_MINT } from "@intent-engine/core";
import { claimBoardAddress, claimListAddress, getClaimBoardSize, getClaimListSize, seal } from "@intent-engine/core/internal";
import { SIGNATURE_FEE } from "../src/agent/budget.js";
import { tool } from "../src/agent/names.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { claimsTooLarge } from "../src/agent/create.js";
import { claimsAfter, NO_LISTED_WORKER, sealedLimits } from "../src/agent/wallet/escrow-claims.js";
import { EXIT_OK } from "../src/main.js";
import { cli, h, world } from "./harness.js";

type Json = Record<string, unknown> & { [key: string]: any };

const SPEC = "# Listed job\n\nDeliver the report as one text file.\n";
const SPEC_URL = "https://" + "example.org/jobs/escrow-listed.sealed";
const OTHER_URL = "https://" + "example.org/jobs/escrow-other.sealed";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const encoded = (text: string) => new TextEncoder().encode(text);
const sol = (at: Address) => h.svm.getBalance(at) ?? 0n;
const rentOf = (space: number) => h.svm.minimumBalanceForRentExemption(BigInt(space));

function address(): Address {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  return getAddressDecoder().decode(Uint8Array.from(Buffer.from(jwk.x ?? "", "base64url")));
}

function preset(at: Address): void {
  if (h.svm.getAccount(at).exists) {
    return;
  }
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

async function call(client: Client, name: string, args: object = {}) {
  const result = await client.callTool({ name: tool(name), arguments: args as Record<string, unknown> });
  return { error: result.isError === true, value: result.structuredContent as Json };
}

async function ok(client: Client, name: string, args: object = {}): Promise<Json> {
  const { error, value } = await call(client, name, args);
  expect(error, JSON.stringify(value)).toBe(false);
  return value;
}

async function setup() {
  await world();
  h.files.clear();
  preset(NATIVE_MINT);
  preset(DEVNET_TEST_MINT);
  h.served.length = 0;
  h.engineLog = [];
  const started = await cli(["mcp", "--url", "devnet", "--wallet", "--all-tools"], {});
  expect([started.code, started.err]).toEqual([EXIT_OK, WALLET_NOTICE.join("\n")]);
  const [near, far] = InMemoryTransport.createLinkedPair();
  await h.served[0]?.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
  h.watched.push(wallet);
  return { client, wallet };
}

const terms = (attestor: Address) => ({ sell: "SOL", amount: "0.05", attestor, spec_hash: sha(SPEC), spec_url: SPEC_URL, claim_stake: "0.01", claim_secs: 600 });

describe("wallet escrows on a sealed spec", () => {
  it("wallet_escrow lists the workers the sealed spec invites, leaving out the owner and the attestor, and settle returns the list's rent", async () => {
    const { client, wallet } = await setup();
    const [judge, worker, mate] = [address(), address(), address()];
    h.specPages.set(SPEC_URL, await seal(encoded(SPEC), [wallet, judge, worker, mate]));
    const shown = await ok(client, "wallet_escrow", terms(judge));
    expect(shown["summary"]).toContain(sealedLimits([worker, mate]));
    const made = await ok(client, "wallet_escrow", { ...terms(judge), send: true });
    const ref = { owner: wallet, nonce: made["nonce"] };
    const intent = made["intent"] as Address;
    const read = await ok(client, "get_claims", ref);
    expect(read["claim_list"]).toEqual({ workers: [worker, mate], size: 2, complete: true });
    const list = await claimListAddress(intent);
    expect(sol(list)).toBe(rentOf(getClaimListSize()));
    await ok(client, "wallet_cancel", { nonce: made["nonce"], send: true });
    const settle = { ...ref, action: "settle" };
    const preview = await ok(client, "wallet_claim", settle);
    expect(preview["summary"]).toContain(
      `Closes: the claims board ${await claimBoardAddress(intent)} and its claim list ${list}, returning ${formatAmount(rentOf(getClaimBoardSize()) + rentOf(getClaimListSize()), 9)} SOL of rent to the owner ${wallet}`,
    );
    const before = sol(wallet);
    expect(await ok(client, "wallet_claim", { ...settle, approval: preview["approval"], send: true })).toMatchObject({ sent: true });
    expect(sol(list)).toBe(0n);
    expect(sol(wallet) - before).toBe(rentOf(getClaimBoardSize()) + rentOf(getClaimListSize()) - SIGNATURE_FEE);
  });

  it("wallet_escrow_plan lists each piece's invited workers and says so once when they agree", async () => {
    const { client, wallet } = await setup();
    const [worker, mate] = [address(), address()];
    h.specPages.set(SPEC_URL, await seal(encoded(SPEC), [wallet, worker]));
    h.specPages.set(OTHER_URL, await seal(encoded(SPEC), [wallet, mate]));
    const plan = { sell: "SOL", attestor: wallet, spec_hash: sha(SPEC), spec_url: SPEC_URL, claim_stake: "0.01", claim_secs: 600 };
    const same = await ok(client, "wallet_escrow_plan", { ...plan, pieces: [{ name: "a", amount: "0.01" }, { name: "b", amount: "0.01" }] });
    expect((same["summary"] as string[]).filter((line) => line.includes("Limits:"))).toEqual([sealedLimits([worker])]);
    const pieces = [{ name: "a", amount: "0.01" }, { name: "b", amount: "0.01", spec_url: OTHER_URL }];
    const split = await ok(client, "wallet_escrow_plan", { ...plan, pieces });
    expect((split["summary"] as string[]).filter((line) => line.includes("Limits:"))).toEqual([`Piece 1 (a): ${sealedLimits([worker])}`, `Piece 2 (b): ${sealedLimits([mate])}`]);
    const sent = await ok(client, "wallet_escrow_plan", { ...plan, pieces, send: true });
    const lists = await Promise.all((sent["pieces"] as Json[]).map(async (piece) => (await ok(client, "get_claims", { owner: wallet, nonce: piece["nonce"] }))["claim_list"]));
    expect(lists).toEqual([
      { workers: [worker], size: 1, complete: true },
      { workers: [mate], size: 1, complete: true },
    ]);
  });

  it("refuses claims it cannot limit: an unreadable spec and a spec sealed to no worker", async () => {
    const { client, wallet } = await setup();
    const judge = address();
    const unread = await call(client, "wallet_escrow", { ...terms(judge), send: true });
    expect(unread).toMatchObject({ error: true, value: { code: "SpecUnreadable" } });
    expect(unread.value["hint"]).toMatch(/^spec_url .+, so the wallets its spec invites cannot be read to limit who may claim; nothing was sent; /);
    h.specPages.set(SPEC_URL, await seal(encoded(SPEC), [wallet, judge]));
    expect(await call(client, "wallet_escrow", terms(judge))).toMatchObject({ error: true, value: { code: "ClaimListInvalid", hint: NO_LISTED_WORKER } });
  });

  it("sends a list too long to fit beside the escrow in transactions right after it", async () => {
    const { client, wallet } = await setup();
    const judge = address();
    const workers = Array.from({ length: 30 }, () => address());
    h.specPages.set(SPEC_URL, await seal(encoded(SPEC), [wallet, ...workers]));
    const shown = await ok(client, "wallet_escrow", terms(judge));
    expect(shown["summary"]).toContain(claimsAfter(2));
    expect(shown["summary"]).toContain(sealedLimits(workers));
    const wires = h.wires.length;
    const made = await ok(client, "wallet_escrow", { ...terms(judge), send: true });
    expect(h.wires.length - wires).toBe(3);
    expect(JSON.stringify(made["warnings"])).not.toContain("claims did not all open");
    const read = await ok(client, "get_claims", { owner: wallet, nonce: made["nonce"] });
    expect(read["claim_list"]).toEqual({ workers, size: 30, complete: true });
    expect(claimsTooLarge(1_300)).toContain("intent-engine claims open --workers");
  });
});
