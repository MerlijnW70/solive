import { createHash, generateKeyPairSync } from "node:crypto";
import { type Address, getAddressDecoder, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, formatTime, Kind, NATIVE_MINT, seal, specMemo } from "@intent-engine/core";
import { createClient } from "@intent-engine/client";
import { tool } from "../src/agent/names.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { inviteOnly } from "../src/agent/work-claims.js";
import { claimNotInvited, deliverNotInvited } from "../src/invites.js";
import { EXIT_FAILED, EXIT_OK } from "../src/main.js";
import { cli, creation, funded, h, NOW, ownerSigned, transport, world } from "./harness.js";

type Json = Record<string, unknown> & { [key: string]: any };

const SPEC = "# Private job\n\nDeliver the report as one text file.\n";
const SPEC_URL = "https://" + "example.org/jobs/private.sealed";
const WORK = "7c".repeat(32);
const WORK_URL = "https://" + "example.org/work/0123456789abcdef0123456789abcdef";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const encoded = (text: string) => new TextEncoder().encode(text);

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
  const w = await world();
  h.files.clear();
  preset(NATIVE_MINT);
  preset(DEVNET_TEST_MINT);
  h.served.length = 0;
  const started = await cli(["mcp", "--url", "devnet", "--wallet", "--all-tools"], {});
  expect([started.code, started.err]).toEqual([EXIT_OK, WALLET_NOTICE.join("\n")]);
  const [near, far] = InMemoryTransport.createLinkedPair();
  await h.served[0]?.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
  h.watched.push(wallet);
  const run = async (args: string[], keys: Record<string, unknown>) => {
    const result = await cli(args, keys as never);
    expect([result.code, result.err]).toEqual([EXIT_OK, ""]);
    return result;
  };
  return { w, client, wallet, run };
}

type Setup = Awaited<ReturnType<typeof setup>>;

async function post(s: Setup, invited: Address[], claims: boolean): Promise<Address> {
  h.specPages.set(SPEC_URL, await seal(encoded(SPEC), invited));
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: address(), specHash: Uint8Array.from(Buffer.from(sha(SPEC), "hex")), judgeFee: 0n } as const;
  const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: s.w.owner, params, inputMint: s.w.inputMint, outputMint: s.w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  h.engineLog = [{ ...creation(intent), ...ownerSigned(intent, [specMemo(SPEC_URL)]) }];
  if (claims) {
    await s.run(["claims", "open", "--keypair", "owner.json", "--nonce", "0", "--max-secs", "3600", "--stake", "0.05", "--yes"], { "owner.json": s.w.owner });
  }
  return intent;
}

describe("claims on an invite-only job", () => {
  it("wallet_claim refuses a take and a standby from a wallet the spec is not sealed to", async () => {
    const s = await setup();
    const worker = await funded();
    const intent = await post(s, [address(), worker.address], true);
    const job = { owner: s.w.owner.address, nonce: "0", secs: 600 };
    expect(await call(s.client, "wallet_claim", { ...job, action: "take" })).toEqual({
      error: true,
      value: { code: "NotInvited", retryable: false, hint: claimNotInvited(s.wallet, intent) },
    });
    await s.run(["claims", "take", "--keypair", "worker.json", "--owner", s.w.owner.address, "--nonce", "0", "--secs", "600", "--yes"], { "worker.json": worker });
    expect(await call(s.client, "wallet_claim", { ...job, action: "standby" })).toEqual({
      error: true,
      value: { code: "NotInvited", retryable: false, hint: claimNotInvited(s.wallet, intent) },
    });
  });

  it("claims take and claims standby refuse a wallet the spec is not sealed to before sending", async () => {
    const s = await setup();
    const [worker, stranger] = [await funded(), await funded()];
    const intent = await post(s, [address(), worker.address], true);
    const keys = { "worker.json": worker, "stranger.json": stranger };
    const claim = (action: string, key: string) => cli(["claims", action, "--keypair", key, "--owner", s.w.owner.address, "--nonce", "0", "--secs", "600", "--yes"], keys);
    expect(await claim("take", "stranger.json")).toMatchObject({ code: EXIT_FAILED, err: claimNotInvited(stranger.address, intent) });
    expect((await claim("take", "worker.json")).code).toBe(EXIT_OK);
    expect(await claim("standby", "stranger.json")).toMatchObject({ code: EXIT_FAILED, err: claimNotInvited(stranger.address, intent) });
  });

  it("lets an invited wallet take the claim and gives the claim's end as a time and as seconds from now", async () => {
    const s = await setup();
    await post(s, [address(), s.wallet], true);
    const shown = await ok(s.client, "wallet_claim", { owner: s.w.owner.address, nonce: "0", action: "take", secs: 600 });
    expect(shown["summary"][0]).toContain(`until ${formatTime(NOW + 600n)}, 600 seconds from now;`);
    const worker = await funded();
    h.specPages.set(SPEC_URL, await seal(encoded(SPEC), [worker.address]));
    const taken = await cli(["claims", "take", "--keypair", "worker.json", "--owner", s.w.owner.address, "--nonce", "0", "--secs", "600"], { "worker.json": worker });
    expect((taken.json()["summary"] as string[])[0]).toContain(`until ${formatTime(NOW + 600n)}, 600 seconds from now;`);
  });

  it("get_claims names the invited wallets instead of calling the job free to anyone", async () => {
    const s = await setup();
    const invited = [address(), address()];
    await post(s, invited, true);
    const claims = await ok(s.client, "get_claims", { owner: s.w.owner.address, nonce: "0" });
    expect(claims).toMatchObject({ state: "free", invited, next: inviteOnly(invited) });
    expect(claims["next"]).not.toMatch(/free to claim/);
    h.specPages.set(SPEC_URL, encoded(SPEC));
    const open = await ok(s.client, "get_claims", { owner: s.w.owner.address, nonce: "0" });
    expect(open).not.toHaveProperty("invited");
    expect(open["next"]).toMatch(/free to claim/);
  });
});

describe("delivering to an invite-only job", () => {
  it("warns an uninvited wallet in the deliver preview that it cannot be paid, and not an invited one", async () => {
    const s = await setup();
    const intent = await post(s, [address(), address()], false);
    const shown = await ok(s.client, "wallet_deliver", { intent, sha256: WORK, url: WORK_URL });
    expect(shown["warnings"]).toContain(deliverNotInvited(s.wallet, intent));
    h.specPages.set(SPEC_URL, await seal(encoded(SPEC), [address(), s.wallet]));
    const invited = await ok(s.client, "wallet_deliver", { intent, sha256: WORK, url: WORK_URL });
    expect(invited["warnings"]).not.toContain(deliverNotInvited(s.wallet, intent));
  });
});
