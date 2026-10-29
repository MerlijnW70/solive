import { createHash } from "node:crypto";
import { type Address, getBase58Decoder, signBytes } from "@solana/kit";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, NATIVE_MINT } from "@intent-engine/core";
import { sortMembers } from "@intent-engine/core/internal";
import { svmTransport } from "@intent-engine/client/svm";
import { tool } from "../src/agent/names.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { NO_BOOK } from "../src/agent/wallet/openings.js";
import { WORK_DIFFERS } from "../src/agent/wallet/work.js";
import { EXIT_OK, main } from "../src/main.js";
import { ENV_KEYPAIR } from "../src/clusters.js";
import { preset } from "./agent-wallet-kit.js";
import { announced, keyed } from "./announce.js";
import { approved } from "./approved.js";
import { announce, call as callTool, COUNT, KEY_FILE, LEVELS, logged, PATH, publish, served, sha, job, WORK_URL as COUNT_URL } from "./encryption-job.js";
import { cli, DOMAIN, funded, h, runtime, world } from "./harness.js";
import { keyOf } from "./held-kit.js";
import { device, found } from "./ledger-device.js";

type Json = Record<string, unknown> & { [key: string]: any };

const WORK_TEXT = "the delivered work\n";
const WORK = createHash("sha256").update(WORK_TEXT).digest("hex");
const WORK_URL = "https://" + "work.example.org/" + "c".repeat(32);

async function server(home: string): Promise<Client> {
  h.served.length = 0;
  const err: string[] = [];
  const code = await main(["mcp", "--url", "devnet", "--wallet", "--all-tools"], { ...runtime({}), home }, { out: () => undefined, err: (t) => err.push(t) });
  expect([code, err.join("\n")]).toEqual([EXIT_OK, WALLET_NOTICE.join("\n")]);
  const [near, far] = InMemoryTransport.createLinkedPair();
  await h.served[0]?.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return client;
}

async function ok(client: Client, name: string, args: object = {}): Promise<Json> {
  const result = await client.callTool({ name: tool(name), arguments: args as Record<string, unknown> });
  expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
  return result.structuredContent as Json;
}

describe("announcing work and judging it", () => {
  let judge: Client;
  let worker: Client;
  let judgeWallet: Address;
  let workerWallet: Address;

  beforeEach(async () => {
    await world();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    h.through = svmTransport(h.svm, { genesisHash: getBase58Decoder().decode(DOMAIN) });
    h.specPages.set(WORK_URL, new TextEncoder().encode(WORK_TEXT));
    judge = await server("/home/judge");
    judgeWallet = (await ok(judge, "wallet_setup"))["address"] as Address;
    worker = await server("/home/worker");
    workerWallet = (await ok(worker, "wallet_setup"))["address"] as Address;
    h.watched.push(judgeWallet);
  });

  const hire = async (attestor: Address, hint = "6d") => ok(judge, "wallet_escrow", await approved(judge, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor, spec_hash: hint.repeat(32) }));

  const prepare = async (intent: Address): Promise<Json> => {
    const args = { worker: workerWallet, intent, sha256: WORK, url: WORK_URL };
    const refused = await worker.callTool({ name: tool("prepare_deliver"), arguments: args });
    const message = /message ([0-9a-f]+),/.exec(JSON.stringify(refused.structuredContent))?.[1] ?? "";
    const signer = await keyOf(workerWallet);
    const signature = Buffer.from(await signBytes(signer.keyPair.privateKey, Uint8Array.from(Buffer.from(message, "hex")))).toString("hex");
    return ok(worker, "prepare_deliver", { ...args, salt_signature: signature });
  };

  it("names the announcement, the seal and the cost, and a committee key sync only when one is owed", async () => {
    const escrow = await hire(judgeWallet);
    const intent = escrow["intent"] as Address;
    const preview = await ok(worker, "wallet_deliver", { intent, sha256: WORK, url: WORK_URL });
    expect(preview["summary"]).toStrictEqual([
      `Announces: the work with sha256 ${WORK} to the proof escrow ${intent} in ${preview["announcement"]}, whose commitment ${preview["commitment"]} binds it to this wallet and a salt only its key derives`,
      `Seals: the salt and the url ${WORK_URL} to ${judgeWallet} (the key derived from its wallet), so only they can open it`,
      "Pays: the announcement's rent and the transaction fee from this wallet; the rent returns when the announcement closes, and no tokens move",
    ]);
    const prepared = await prepare(intent);
    expect(prepared["sync_first"]).toBe(false);
    expect(prepared["summary"]).toHaveLength(3);
    const other = await keyed();
    const members = sortMembers([judgeWallet, other.address]);
    const payer = await funded();
    const created = await cli(["committee", "create", "--url", "devnet", "--keypair", "payer.json", "--members", members.join(","), "--threshold", "2", "--fee-wallet", payer.address, "--yes"], { "payer.json": payer });
    expect([created.code, created.err]).toEqual([EXIT_OK, ""]);
    const committee = created.json()["committee"] as Address;
    const teamed = await hire(committee, "6e");
    const syncing = await ok(worker, "wallet_deliver", { intent: teamed["intent"], sha256: WORK, url: WORK_URL });
    expect(syncing["summary"]).toHaveLength(4);
    expect((syncing["summary"] as string[])[3]).toBe(`Syncs first, in its own transaction: the key snapshot of committee ${committee}`);
    const sync = await prepare(teamed["intent"] as Address);
    expect(sync["sync_first"]).toBe(true);
    expect(sync["next"]).toBe("sign and send this key sync, then call again for the announcement");
  });

  it("counts only the announcements of other wallets that came before each of this wallet's, and lists no skipped ones when none were skipped", async () => {
    const escrow = await hire(judgeWallet);
    const intent = escrow["intent"] as Address;
    const rival = await keyed();
    await announced(intent, rival, "a1".repeat(32), WORK_URL, h.through ?? undefined);
    await ok(worker, "wallet_deliver", { intent, sha256: "b1".repeat(32), url: WORK_URL, send: true });
    await announced(intent, rival, "a2".repeat(32), WORK_URL, h.through ?? undefined);
    await ok(worker, "wallet_deliver", { intent, sha256: "b2".repeat(32), url: WORK_URL, send: true });
    const listed = await ok(worker, "wallet_check_delivery", { intent });
    expect(listed["mine"]).toMatchObject([
      { seq: "2", earlier: 1 },
      { seq: "4", earlier: 2 },
    ]);
    expect(listed).not.toHaveProperty("skipped");
    expect(await ok(worker, "check_delivery", { intent })).not.toHaveProperty("skipped");
  });

  it("keeps the text of a work that starts with a byte order mark, and none of a work that is not text", async () => {
    const escrow = await hire(judgeWallet);
    const intent = escrow["intent"] as Address;
    const marked = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("marked")]);
    h.specPages.set(WORK_URL, marked);
    await ok(worker, "wallet_deliver", { intent, sha256: createHash("sha256").update(marked).digest("hex"), url: WORK_URL, send: true });
    const shown = await ok(judge, "wallet_fetch_work", { intent });
    expect(shown["untrusted_text"]).toBe("﻿marked");
    const binary = new Uint8Array([0x80, 0x81, 0x82]);
    const second = await hire(judgeWallet, "6f");
    h.specPages.set(WORK_URL, binary);
    await ok(worker, "wallet_deliver", { intent: second["intent"], sha256: createHash("sha256").update(binary).digest("hex"), url: WORK_URL, send: true });
    const raw = await ok(judge, "wallet_fetch_work", { intent: second["intent"] });
    expect(raw).not.toHaveProperty("untrusted_text");
    expect(raw["bytes"]).toBe(3);
  });

  it("says no announcement opens to a fetched work that is not the announced one, and that a worker announces first", async () => {
    const escrow = await hire(judgeWallet);
    const intent = escrow["intent"] as Address;
    await ok(worker, "wallet_deliver", { intent, sha256: WORK, url: WORK_URL, send: true });
    h.specPages.set(WORK_URL, new TextEncoder().encode("a different work\n"));
    const shown = await ok(judge, "wallet_fetch_work", { intent });
    expect(shown["opens_commitment"]).toBe(false);
    expect(shown["next"]).toBe(WORK_DIFFERS);
    expect(shown["refused"]).toMatchObject({ reason: "nothing-opens" });
    expect((shown["refused"] as Json)["message"]).toContain("no announcement opens to this work; its worker announces it first with deliver");
    expect((shown["refused"] as Json)["message"]).not.toContain(NO_BOOK);
    const attest = await judge.callTool({ name: tool("wallet_attest"), arguments: { owner: judgeWallet, nonce: escrow["nonce"], delivered_sha256: "aa".repeat(32) } });
    expect(attest.isError).toBe(true);
    const problem = attest.structuredContent as Json;
    expect(problem["code"]).toBe("NotAnnounced");
    expect(problem["hint"]).toContain("no announcement opens to this work; its worker announces it first with deliver");
    expect(problem["hint"]).not.toContain(NO_BOOK);
    const empty = await hire(judgeWallet, "70");
    const bare = await judge.callTool({ name: tool("wallet_attest"), arguments: { owner: judgeWallet, nonce: empty["nonce"], delivered_sha256: "aa".repeat(32) } });
    expect((bare.structuredContent as Json)["hint"]).toContain(NO_BOOK);
  });
});

describe("judging from a Ledger wallet", () => {
  it("names the Ledger limit when an earlier announcement was sealed to the key derived from the wallet", async () => {
    const j = await job();
    const [copier, other] = [await keyed(), await keyed()];
    await announce(j, copier, sha("other work").toString("hex"));
    logged(j, [await publish(j, j.publicKey, 0)]);
    await announce(j, other);
    h.env[ENV_KEYPAIR] = PATH;
    h.specPages.set(COUNT_URL, new TextEncoder().encode(COUNT));
    const client = await served(device(j.key, found(LEVELS, j.key)), ["--encryption-keypair", KEY_FILE]);
    const fetched = await callTool(client, "wallet_fetch_work", { intent: j.intent });
    expect(fetched.error, JSON.stringify(fetched.value)).toBe(false);
    expect(fetched.value["refused"]).toMatchObject({ reason: "key-not-given" });
    expect(String((fetched.value["refused"] as Json)["message"])).toContain("sealed to the key derived from this wallet, which a Ledger cannot use");
    expect(String(fetched.value["next"])).toContain("sealed to the key derived from this wallet, which a Ledger cannot use");
  });
});
