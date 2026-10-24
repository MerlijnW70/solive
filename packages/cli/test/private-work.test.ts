import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Address, type KeyPairSigner, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEVNET_TEST_MINT,
  EVENT_IX_TAG,
  findAssociatedTokenAddress,
  getIntentCreatedEventEncoder,
  getIntentDecoder,
  NATIVE_MINT,
  NotInvited,
  specMemo,
  unseal,
} from "@intent-engine/core";
import type { EngineTransaction } from "@intent-engine/client";
import { tool } from "../src/agent/names.js";
import { EVERYDAY_TOOLS } from "../src/agent/everyday.js";
import { NONE_OPENS, WORK_DIFFERS, WORK_OPENS } from "../src/agent/wallet/work.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { EXIT_OK } from "../src/main.js";
import { defaultWallet } from "../src/wallet.js";
import { balance, cli, funded, h, HOME, world } from "./harness.js";

vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "93.184.215.14", family: 4 }] }));

type Json = Record<string, unknown>;

const SPEC = "# Answer\n\nDeliver answer.txt holding 42.\n";
const WORK = "answer.txt: 42\n";
const SPEC_URL = "https://" + "files.example.com/jobs/7d1c5e0a9b3f4e62.sealed";
const WORK_URL = "https://" + "files.example.com/work/c41e9a07d2b85f36c41e9a07d2b85f36.txt";
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const bytesOf = (text: unknown) => new TextEncoder().encode(text as string);

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

async function ok(client: Client, name: string, args: object = {}): Promise<Json> {
  const { error, value } = await call(client, name, args);
  expect(error, JSON.stringify(value)).toBe(false);
  return value;
}

const useKey = (signer: KeyPairSigner) => h.files.set(defaultWallet(HOME), JSON.stringify(Array.from(h.keypairs.get(signer.address) ?? [])));

const keyOf = (signer: KeyPairSigner): Uint8Array => h.keypairs.get(signer.address) ?? new Uint8Array();

function createdFrom(intent: Address, memos: string[]): EngineTransaction {
  const held = h.svm.getAccount(intent);
  if (!held.exists) {
    throw new Error("the escrow was not created");
  }
  const { owner, nonce, kind, inputMint, outputMint, escrowed, expiresAt } = getIntentDecoder().decode(held.data);
  const event = getIntentCreatedEventEncoder().encode({ intent, owner, nonce, kind, inputMint, outputMint, receiver: owner, escrowed, expiresAt, rentPayer: owner, flags: 0, bounty: 0, createFee: 0 });
  return { signature: `made-${intent}`, slot: 1n, blockTime: null, failed: false, emitted: [new Uint8Array([...EVENT_IX_TAG, ...event])], memos, memoSigners: memos.map(() => [owner]), feePayer: owner };
}

describe("an invite-only job with wallet tools only", () => {
  let client: Client;
  let judge: KeyPairSigner;
  let worker: KeyPairSigner;
  let stranger: KeyPairSigner;

  beforeEach(async () => {
    await world();
    h.files.clear();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    client = await connect();
    await ok(client, "wallet_setup");
    [judge, worker, stranger] = [await funded(), await funded(), await funded()];
    h.watched.push(judge.address, worker.address);
  });

  const post = async () => {
    useKey(judge);
    const spec = await ok(client, "wallet_seal_spec", { text: SPEC, invite: [worker.address] });
    h.specPages.set(SPEC_URL, bytesOf(spec["sealed"]));
    const escrow = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: judge.address, spec_hash: spec["sha256"], spec_url: SPEC_URL, send: true });
    const intent = escrow["intent"] as Address;
    const made = createdFrom(intent, [specMemo(SPEC_URL)]);
    h.engineLog = [made];
    return { intent, nonce: escrow["nonce"] as string, made };
  };

  const announce = async (intent: Address, hosted: Uint8Array, sha256: string) => {
    useKey(worker);
    h.specPages.set(WORK_URL, hosted);
    return (await ok(client, "wallet_deliver", { intent, sha256, url: WORK_URL, send: true }))["announcement"] as Address;
  };

  it("seals the spec, escrows it, lets the invited worker read it and announce work, and lets the judge fetch, check and release it", async () => {
    expect([tool("wallet_fetch_work"), tool("wallet_deliver")].every((name) => EVERYDAY_TOOLS.has(name))).toBe(true);
    const { intent, nonce } = await post();

    useKey(worker);
    expect(await ok(client, "get_spec", { intent })).toMatchObject({ url: SPEC_URL, matches: true, text: SPEC, sealed_to: [worker.address, judge.address] });
    const announcement = await announce(intent, bytesOf(WORK), sha(WORK));

    useKey(stranger);
    expect((await call(client, "get_spec", { intent })).value).toMatchObject({ code: "SpecSealed" });
    expect((await call(client, "wallet_fetch_work", { intent, announcement })).value).toMatchObject({ code: "WorkUnfetchable", hint: NONE_OPENS });
    await expect(unseal(h.specPages.get(SPEC_URL) ?? new Uint8Array(), keyOf(stranger))).rejects.toBeInstanceOf(NotInvited);

    useKey(judge);
    const listed = await ok(client, "wallet_check_delivery", { intent });
    expect(listed["announcements"]).toMatchObject([{ announcement, worker: worker.address, seq: "1", state: "announced" }]);
    const before = h.wires.length;
    const fetched = await ok(client, "wallet_fetch_work", { intent, announcement });
    expect(h.wires.length).toBe(before);
    expect(fetched).toEqual({
      intent,
      announcement,
      seq: "1",
      worker: worker.address,
      url: WORK_URL,
      sha256: sha(WORK),
      opens_commitment: true,
      bytes: WORK.length,
      untrusted_text: WORK,
      first: { announcement, seq: "1", worker: worker.address, commitment: expect.any(String) },
      next: WORK_OPENS,
    });
    const release = { owner: judge.address, nonce, delivered_sha256: fetched["sha256"] };
    const shown = await ok(client, "wallet_attest", release);
    expect(await ok(client, "wallet_attest", { ...release, approval: shown["approval"], send: true })).toMatchObject({ sent: true, pay_to: worker.address });
    const payee = await findAssociatedTokenAddress({ owner: worker.address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(balance(payee)).toBeGreaterThan(0n);
  }, 60_000);

  it("reports work that does not open the announcement's commitment, and takes no input that skips the check", async () => {
    const { intent } = await post();
    const swapped = "answer.txt: 41\n";
    const announcement = await announce(intent, bytesOf(swapped), sha(WORK));

    useKey(judge);
    const fetched = await ok(client, "wallet_fetch_work", { intent, announcement });
    expect(fetched).toMatchObject({ worker: worker.address, sha256: sha(swapped), opens_commitment: false, next: WORK_DIFFERS });
    expect(WORK_DIFFERS).toContain("do not release for it");
    for (const skip of [{ check: false }, { opens_commitment: true }, { skip_check: true }]) {
      expect((await call(client, "wallet_fetch_work", { intent, announcement, ...skip })).value).toMatchObject({ code: "InvalidInput" });
    }
    h.specPages.set(WORK_URL, bytesOf(WORK));
    expect(await ok(client, "wallet_fetch_work", { intent, announcement })).toMatchObject({ sha256: sha(WORK), opens_commitment: true, next: WORK_OPENS });
  }, 60_000);
});

describe("the private job guide", () => {
  it("shows the whole invite-only job with served wallet tools, in the order the job runs", () => {
    const root = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
    const page = readFileSync(join(root, "docs/private-jobs.md"), "utf8");
    const section = page.slice(page.indexOf("## Invite-only with wallet tools only"), page.indexOf("## Next"));
    const rows = [...section.matchAll(/^\| (Owner|Worker|Judge) \| `([a-z_]+)` \|/gm)].map((m) => [m[1], m[2]]);
    expect(rows).toEqual([
      ["Owner", tool("wallet_seal_spec")],
      ["Owner", tool("wallet_escrow")],
      ["Worker", tool("get_spec")],
      ["Worker", tool("wallet_deliver")],
      ["Judge", tool("wallet_check_delivery")],
      ["Judge", tool("wallet_fetch_work")],
      ["Judge", tool("wallet_attest")],
    ]);
    expect(rows.every(([, name]) => EVERYDAY_TOOLS.has(name ?? ""))).toBe(true);
    expect(section).not.toContain("intent-engine seal");
    expect(page).toContain("An AI agent announces it with `solive_wallet_deliver` instead of `deliver`.");
    expect(page).toContain("An AI agent judge opens and fetches the work with `solive_wallet_fetch_work`.");
    expect(page).not.toContain("seal_work");
  });
});
