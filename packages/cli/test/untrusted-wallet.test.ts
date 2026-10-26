import { createHash } from "node:crypto";
import type { Address } from "@solana/kit";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, NATIVE_MINT } from "@intent-engine/core";
import { NO_JOB_NOW } from "../src/agent/jobs.js";
import { tool } from "../src/agent/names.js";
import { SERVER_PROBLEMS } from "../src/agent/problems.js";
import { SECOND_NODE_UNREAD, WALLET_NOTICE } from "../src/agent/wallet.js";
import { WORK_OPENS } from "../src/agent/wallet/work.js";
import { EXIT_OK } from "../src/main.js";
import { fresh, preset } from "./agent-wallet-kit.js";
import { announced, keyed } from "./announce.js";
import { approved } from "./approved.js";
import { cliWith, SECOND, secondNode } from "./confirm-node.js";
import { h, world } from "./harness.js";
import { CANARY, HOSTILE, heldTo, hostileProfile, plainAbout, PROSE, refusalHeld, served } from "./untrusted-kit.js";

const WORK_URL = "https://" + "example.org/" + PROSE + "/work.md";
const GONE_URL = "https://" + "example.org/" + PROSE + "/gone.md";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

async function judging(client: Client) {
  const wallet = (await served(client, "wallet_setup")).value["address"] as Address;
  h.watched.push(wallet);
  h.engineLog = [];
  const escrow = await served(client, "wallet_escrow", await approved(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: wallet, spec_hash: "5c".repeat(32) }));
  expect(escrow.error, JSON.stringify(escrow.value)).toBe(false);
  return { wallet, intent: escrow.value["intent"] as Address, nonce: escrow.value["nonce"] as string };
}

describe("text other parties control, through the wallet server", () => {
  it("keeps a profile's endpoint out of find_jobs' next and every other field, on a wallet whose own profile is hostile", async () => {
    const client = await fresh();
    const wallet = (await served(client, "wallet_setup")).value["address"] as Address;
    h.watched.push(wallet);
    await hostileProfile(wallet);
    const jobs = await served(client, "find_jobs", {});
    expect(jobs.value).toMatchObject({ jobs: [], next: NO_JOB_NOW });
    expect(heldTo(tool("find_jobs"), jobs.value)).toEqual([]);
    const profile = await served(client, "get_profile", { wallet });
    expect(heldTo(tool("get_profile"), profile.value).sort()).toEqual(["doc_url", "endpoint", "skills[]"]);
    expect(heldTo(tool("wallet_balance"), (await served(client, "wallet_balance")).value)).toEqual([]);
    const update = await served(client, "wallet_profile", { skills: ["rust"], endpoint: "https://" + "example.org/work" });
    expect(update.value).toMatchObject({ wallet, action: "update", sent: false });
    expect(heldTo(tool("wallet_profile"), update.value)).toEqual([]);
    const close = await served(client, "wallet_profile", { close: true });
    expect(close.value).toMatchObject({ wallet, action: "close", sent: false });
    expect(heldTo(tool("wallet_profile"), close.value)).toEqual([]);
    await plainAbout(client);
  });

  it("wallet_fetch_work shows hostile work only in untrusted_text, its url only in url, and the release still binds the same terms", async () => {
    const client = await fresh();
    const { wallet, intent, nonce } = await judging(client);
    const worker = await keyed();
    const sha256 = sha(HOSTILE);
    h.specPages.set(WORK_URL, new TextEncoder().encode(HOSTILE));
    const first = await announced(intent, worker, sha256, WORK_URL);
    const listed = await served(client, "wallet_check_delivery", { intent });
    expect(listed.value["announcements"]).toMatchObject([{ announcement: first.announcement, worker: worker.address, state: "announced" }]);
    expect(heldTo(tool("wallet_check_delivery"), listed.value)).toEqual([]);
    const fetched = await served(client, "wallet_fetch_work", { intent });
    expect(fetched.value).toMatchObject({
      announcement: first.announcement,
      worker: worker.address,
      url: WORK_URL,
      sha256,
      opens_commitment: true,
      untrusted_text: HOSTILE,
      first: { announcement: first.announcement, worker: worker.address },
      next: WORK_OPENS,
    });
    expect(heldTo(tool("wallet_fetch_work"), fetched.value).sort()).toEqual(["untrusted_text", "url"]);
    const release = { owner: wallet, nonce, delivered_sha256: sha256 };
    const preview = await served(client, "wallet_attest", release);
    expect(preview.value).toMatchObject({ pay_to: worker.address, announcement: first.announcement, delivered_sha256: sha256, sent: false });
    expect(heldTo(tool("wallet_attest"), preview.value)).toEqual([]);
    expect((await served(client, "wallet_attest", release)).value["approval"]).toBe(preview.value["approval"]);
    const sent = await served(client, "wallet_attest", { ...release, approval: preview.value["approval"], send: true });
    expect(sent.value).toMatchObject({ pay_to: worker.address, delivered_sha256: sha256, approval: preview.value["approval"], sent: true });
    expect(heldTo(tool("wallet_attest"), sent.value)).toEqual([]);
    for (const name of ["wallet_receipt", "get_receipt"]) {
      const receipt = await served(client, name, { owner: wallet, nonce, sha256 });
      expect(receipt.error, JSON.stringify(receipt.value)).toBe(false);
      expect(heldTo(tool(name), receipt.value)).toEqual([]);
    }
    const checked = await served(client, "check_delivery", { intent });
    expect(heldTo(tool("check_delivery"), checked.value)).toEqual([]);
    await plainAbout(client);
  });

  it("wallet_fetch_work keeps a work host's answer out of its hint, reduced in untrustedDetail", async () => {
    const client = await fresh();
    const { intent } = await judging(client);
    h.specReplies.set(GONE_URL, async () => new Response(HOSTILE, { status: 404 }));
    await announced(intent, await keyed(), sha(HOSTILE), GONE_URL);
    const refused = await served(client, "wallet_fetch_work", { intent });
    expect(refused).toMatchObject({ error: true, value: { code: "WorkUnfetchable", retryable: false, hint: SERVER_PROBLEMS.WorkUnfetchable.hint } });
    expect(refusalHeld(refused.value as never)).toEqual(["untrustedDetail"]);
  });

  it("names how far a schedule got when the node fails it, keeping the node's error reduced in untrusted_detail and out of next", async () => {
    const client = await fresh();
    const owner = (await served(client, "wallet_setup")).value["address"] as Address;
    h.engineLog = [];
    h.watched.push(owner);
    const plan = { sell: "SOL", buy: "TEST", amount: "0.05", min_receive: "5", every: 600, times: 2, send: true };
    h.sendFails = { error: new Error(HOSTILE), landed: false, after: 1 };
    const partly = await served(client, "wallet_recurring", await approved(client, "wallet_recurring", plan));
    expect(partly.value).toMatchObject({ sent: true, next: expect.stringContaining(`Failed: ${SERVER_PROBLEMS.Failed.hint}`) });
    expect(partly.value["orders"][0]).toHaveProperty("intent");
    expect(partly.value["orders"][1]).not.toHaveProperty("intent");
    expect(heldTo(tool("wallet_recurring"), partly.value)).toEqual(["untrusted_detail"]);
  });

  it("names how far an escrow plan got when the node fails it, keeping the node's error reduced in untrusted_detail and out of next", async () => {
    const client = await fresh();
    const owner = (await served(client, "wallet_setup")).value["address"] as Address;
    h.engineLog = [];
    h.watched.push(owner);
    const pieces = [
      { name: "first", amount: "0.01" },
      { name: "second", amount: "0.01" },
    ];
    h.sendFails = { error: new Error(HOSTILE), landed: false, after: 1 };
    const partly = await served(client, "wallet_escrow_plan", await approved(client, "wallet_escrow_plan", { sell: "SOL", attestor: owner, pieces, send: true }));
    expect(partly.value).toMatchObject({ sent: true, total: "0.02", next: expect.stringContaining(`Failed: ${SERVER_PROBLEMS.Failed.hint}`) });
    expect(partly.value["pieces"][0]).toHaveProperty("intent");
    expect(partly.value["pieces"][1]).not.toHaveProperty("intent");
    expect(heldTo(tool("wallet_escrow_plan"), partly.value)).toEqual(["untrusted_detail"]);
  });

  it("keeps a second node's error out of the ConfirmMismatch hint and signs nothing", async () => {
    await world();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    const node = secondNode();
    node.transport = { ...node.transport, genesisHash: async () => Promise.reject(new Error(HOSTILE)) };
    h.served.length = 0;
    const started = await cliWith(["mcp", "--url", "devnet", "--wallet", "--all-tools", "--confirm-url", SECOND], {}, node);
    expect([started.code, started.err]).toEqual([EXIT_OK, WALLET_NOTICE.join("\n")]);
    const [near, far] = InMemoryTransport.createLinkedPair();
    await h.served[0]?.connect(near);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(far);
    const { wallet, intent, nonce } = await judging(client);
    const sha256 = sha(HOSTILE);
    h.specPages.set(WORK_URL, new TextEncoder().encode(HOSTILE));
    await announced(intent, await keyed(), sha256, WORK_URL);
    const wires = h.wires.length;
    const refused = await served(client, "wallet_attest", { owner: wallet, nonce, delivered_sha256: sha256 });
    expect(refused).toMatchObject({ error: true, value: { code: "ConfirmMismatch", hint: SECOND_NODE_UNREAD } });
    expect(refusalHeld(refused.value as never)).toEqual(["untrustedDetail"]);
    expect(refused.value["untrustedDetail"]).toContain(CANARY);
    expect(h.wires.length).toBe(wires);
    await plainAbout(client);
  });
});
