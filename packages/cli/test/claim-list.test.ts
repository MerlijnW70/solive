import { createHash, generateKeyPairSync } from "node:crypto";
import { type Address, getAddressDecoder, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import {
  buildClaimJob,
  buildClaimsWithList,
  buildExtendClaimants,
  buildOpenClaimsListed,
  buildStandBy,
  CLAIM_LIST_CHUNK,
  claimListAddress,
  computeUnitLimit,
  computeUnitPrice,
  DEVNET_TEST_MINT,
  IntentStatus,
  Kind,
  MAX_CLAIMANTS,
  MAX_COMPUTE_UNITS,
  NATIVE_MINT,
  seal,
  specMemo,
} from "@intent-engine/core";
import { createClient, PACKET_DATA_SIZE, transactionBytes } from "@intent-engine/client";
import { tool } from "../src/agent/names.js";
import { ENGINE_ERROR_BASE, ENGINE_ERROR_NAMES } from "../src/agent/problems.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { listedOnly } from "../src/agent/work-claims.js";
import { limitsLine, listDiffers, listIncomplete, notListed } from "../src/claim-lists.js";
import { EXIT_FAILED, EXIT_OK } from "../src/main.js";
import { announced } from "./announce.js";
import { cli, creation, funded, h, NOW, ownerSigned, send, transport, world } from "./harness.js";

type Json = Record<string, unknown> & { [key: string]: any };

const SPEC = "# Listed job\n\nDeliver the report as one text file.\n";
const SPEC_URL = "https://" + "example.org/jobs/listed.sealed";
const WORK = "5e".repeat(32);
const WORK_URL = "https://" + "example.org/work/fedcba9876543210fedcba9876543210";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const encoded = (text: string) => new TextEncoder().encode(text);
const onChain = (name: string) => new RegExp(`code: ${ENGINE_ERROR_BASE + ENGINE_ERROR_NAMES.indexOf(name as never)}\\b`);

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

async function post(s: Setup, invited: Address[]): Promise<Address> {
  h.specPages.set(SPEC_URL, await seal(encoded(SPEC), invited));
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: s.wallet, specHash: Uint8Array.from(Buffer.from(sha(SPEC), "hex")), judgeFee: 0n } as const;
  const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: s.w.owner, params, inputMint: s.w.inputMint, outputMint: s.w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  h.engineLog = [{ ...creation(intent), ...ownerSigned(intent, [specMemo(SPEC_URL)]) }];
  return intent;
}

const open = (workers: readonly Address[]) => ["claims", "open", "--keypair", "owner.json", "--nonce", "0", "--max-secs", "3600", "--stake", "0.05", "--workers", workers.join(","), "--yes"];

describe("a claim list on chain", () => {
  it("refuses an unlisted wallet's own claim_job and stand_by, with and without the list, while a listed worker claims and wallet_attest pays it", async () => {
    const s = await setup();
    const [worker, stranger] = [await funded(), await funded()];
    const intent = await post(s, [s.wallet, worker.address]);
    await s.run(open([worker.address]), { "owner.json": s.w.owner });
    const owner = s.w.owner.address;
    const claimList = await claimListAddress(intent);
    const claim = (who: typeof worker, listed: boolean) => buildClaimJob({ worker: who, intent, owner, secs: 600, ...(listed ? { claimList } : {}) });
    const standBy = (who: typeof worker, listed: boolean) => buildStandBy({ worker: who, intent, seq: 0, secs: 60, ...(listed ? { claimList } : {}) });
    await expect(send(stranger, [await claim(stranger, true)])).rejects.toThrow(onChain("NotListed"));
    await expect(send(stranger, [await claim(stranger, false)])).rejects.toThrow(onChain("ClaimListMissing"));
    await send(worker, [await claim(worker, true)]);
    await expect(send(stranger, [await standBy(stranger, true)])).rejects.toThrow(onChain("NotListed"));
    await expect(send(stranger, [await standBy(stranger, false)])).rejects.toThrow(onChain("ClaimListMissing"));
    await announced(intent, worker, WORK, WORK_URL);
    const release = { owner, nonce: "0", delivered_sha256: WORK };
    const shown = await ok(s.client, "wallet_attest", release);
    expect(await ok(s.client, "wallet_attest", { ...release, approval: shown["approval"], send: true })).toMatchObject({ sent: true });
    const found = await createClient({ url: "http://cluster", transport }).intent({ owner, nonce: 0n });
    expect(found?.intent.status).toBe(IntentStatus.Filled);
  });

  it("claims open --workers sends a long list in parts, claims show and get_claims show it, and claims take refuses an unlisted wallet", async () => {
    const s = await setup();
    const stranger = await funded();
    const workers = Array.from({ length: 30 }, () => address());
    const intent = await post(s, [s.wallet, ...workers]);
    const preview = await cli(open(workers).slice(0, -1), { "owner.json": s.w.owner });
    expect(preview.code).toBe(EXIT_OK);
    expect(preview.json()["summary"]).toContain(limitsLine(workers));
    expect(preview.json()["summary"]).toContain("Sends: 2 transactions, the list in parts; the escrow takes no claim until the last lands");
    const opened = await s.run(open(workers), { "owner.json": s.w.owner });
    expect(opened.json()["signatures"]).toHaveLength(2);
    const claimList = await claimListAddress(intent);
    const shown = await s.run(["claims", "show", "--owner", s.w.owner.address, "--nonce", "0"], {});
    expect(shown.json()["claim_list"]).toEqual({ address: claimList, size: 30, workers, complete: true });
    const read = await ok(s.client, "get_claims", { owner: s.w.owner.address, nonce: "0" });
    expect(read).toMatchObject({ claim_list: { workers, size: 30, complete: true } });
    expect(read["next"]).toBe(listedOnly({ address: claimList, size: 30, workers, complete: true }));
    h.specPages.set(SPEC_URL, encoded(SPEC));
    const taken = await cli(["claims", "take", "--keypair", "stranger.json", "--owner", s.w.owner.address, "--nonce", "0", "--secs", "600", "--yes"], { "stranger.json": stranger });
    expect(taken).toMatchObject({ code: EXIT_FAILED, err: notListed(stranger.address, intent) });
  });

  it("fits every part of a 32-wallet list in one transaction with its compute budget", async () => {
    const s = await setup();
    const intent = await post(s, [s.wallet]);
    const workers = Array.from({ length: MAX_CLAIMANTS }, () => address());
    const sends = await buildClaimsWithList({ owner: s.w.owner, intent, maxSecs: 3600, stake: 1n, workers });
    const extend = await buildExtendClaimants({ owner: s.w.owner, intent, workers: workers.slice(0, CLAIM_LIST_CHUNK) });
    for (const instructions of [...sends, [extend]]) {
      const size = await transactionBytes(transport, [...instructions, computeUnitLimit(MAX_COMPUTE_UNITS), computeUnitPrice(1n)], s.w.owner.address);
      expect(size).toBeLessThanOrEqual(PACKET_DATA_SIZE);
    }
  });

  it("claims open --workers finishes a list left unfinished, and nobody can claim until it is complete", async () => {
    const s = await setup();
    const [first, second, third] = [address(), address(), s.wallet];
    const intent = await post(s, [s.wallet, first, second]);
    await send(s.w.owner, [await buildOpenClaimsListed({ owner: s.w.owner, intent, maxSecs: 3600, stake: 50_000_000n, size: 3, workers: [first] })]);
    const ref = { owner: s.w.owner.address, nonce: "0" };
    const list = { address: await claimListAddress(intent), size: 3, workers: [first], complete: false };
    expect((await ok(s.client, "get_claims", ref))["next"]).toBe(listedOnly(list));
    h.specPages.set(SPEC_URL, encoded(SPEC));
    const refused = await call(s.client, "wallet_claim", { ...ref, action: "take", secs: 600 });
    expect(refused).toEqual({ error: true, value: { code: "ClaimListIncomplete", retryable: true, hint: listIncomplete(intent, list) } });
    const keys = { "owner.json": s.w.owner };
    expect(await cli(open([second, first, third]), keys)).toMatchObject({ code: EXIT_FAILED, err: listDiffers(intent, list) });
    const finished = await s.run(open([first, second, third]), keys);
    expect(finished.json()["summary"]).toContain(`Finishes: the claim list ${list.address} of escrow ${intent}, adding 2 of its 3 wallets`);
    expect((await ok(s.client, "get_claims", ref))["claim_list"]).toEqual({ workers: [first, second, third], size: 3, complete: true });
    const taken = await ok(s.client, "wallet_claim", { ...ref, action: "take", secs: 600 });
    expect(await ok(s.client, "wallet_claim", { ...ref, action: "take", secs: 600, approval: taken["approval"], send: true })).toMatchObject({ sent: true });
  });
});
