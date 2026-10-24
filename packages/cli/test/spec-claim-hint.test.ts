import { createHash } from "node:crypto";
import { type Address, getBase64Encoder, getTransactionDecoder, partiallySignTransaction } from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { buildClaimJob, buildOpenClaims, specMemo } from "@intent-engine/core";
import type { SpecFetch } from "@intent-engine/client";
import { agentServer, servedText } from "../src/agent/mcp.js";
import { claimsOf } from "../src/agent/claims.js";
import { type Serving, servedActions } from "../src/agent/everyday.js";
import { SPEC_TAKES_CLAIMS, specClaimHeld } from "../src/agent/job-claims.js";
import { creation, funded, h, NOW, ownerSigned, send, transport, type World, world } from "./harness.js";

type Json = Record<string, unknown>;

const SPEC = "the acceptance spec a claimed job must pass\n";
const HOST = "example.org/jobs/";
const SPEC_URL = "https://" + HOST + "claimed.md";
const OTHER_URL = "https://" + HOST + "other.md";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const fetching: SpecFetch = async (url) => new Response(url === SPEC_URL ? SPEC : "something else");

const WITH_WALLET: Serving = { wallet: true, allTools: true, relay: false, agent: false };
const WITHOUT: Serving = { wallet: false, allTools: false, relay: false, agent: false };

async function linked(serving: Serving): Promise<{ client: Client; names: ReadonlySet<string> }> {
  const actions = servedActions(serving);
  const server = agentServer({ transport, relay: undefined, agent: undefined, claims: claimsOf(), fetch: fetching }, actions);
  const [near, far] = InMemoryTransport.createLinkedPair();
  await server.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return { client, names: new Set(actions.map(({ name }) => name)) };
}

async function ok(client: Client, name: string, args: object): Promise<Json> {
  const result = await client.callTool({ name: `solive_${name}`, arguments: args as Record<string, unknown> });
  expect(result.isError === true, JSON.stringify(result.structuredContent)).toBe(false);
  return result.structuredContent as Json;
}

describe("solive_get_spec on a job that takes claims", () => {
  let w: World;

  const escrow = async (client: Client, specUrl: string): Promise<Address> => {
    const order = { kind: "attested", amount_in: "100", min_result: "1", max_result: "1", attestor: w.authority.address, spec_hash: sha(SPEC) };
    const made = await ok(client, "prepare_create", { owner: w.owner.address, input_mint: w.inputMint, output_mint: w.outputMint, order, expires_in: 3_600, spec_url: specUrl });
    const prepared = made["prepared"] as { transaction: string };
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(prepared.transaction));
    const sent = h.svm.sendTransaction(await partiallySignTransaction([w.owner.keyPair], tx));
    if (sent instanceof FailedTransactionMetadata) {
      throw new Error(sent.toString());
    }
    const intent = made["intent"] as Address;
    h.engineLog.push({ ...creation(intent), ...ownerSigned(intent, [specMemo(specUrl)]) });
    return intent;
  };

  const claimable = async (client: Client, specUrl = SPEC_URL) => {
    const intent = await escrow(client, specUrl);
    await send(w.owner, [await buildOpenClaims({ owner: w.owner, intent, maxSecs: 3_600, stake: 1_000_000n })]);
    return intent;
  };

  beforeEach(async () => {
    w = await world();
    h.watched.push(w.owner.address);
  });

  for (const [label, serving] of [
    ["with a wallet", WITH_WALLET],
    ["without a wallet", WITHOUT],
  ] as const) {
    it(`tells a worker to claim a free job before working on it, and names the worker holding a claim: ${label}`, async () => {
      const { client, names } = await linked(serving);
      const free = await claimable(client);
      expect((await ok(client, "get_spec", { intent: free }))["next"]).toBe(servedText(SPEC_TAKES_CLAIMS, names));
      const worker = await funded();
      await send(worker, [await buildClaimJob({ worker, intent: free, owner: w.owner.address, secs: 600 })]);
      const held = await ok(client, "get_spec", { intent: free });
      expect(held["next"]).toBe(servedText(specClaimHeld(worker.address, NOW + 600n), names));
      expect(held["next"]).toContain(`${worker.address} holds this job's claim until ${new Date(Number(NOW + 600n) * 1000).toISOString()}`);
      expect(held["matches"]).toBe(true);
    });
  }

  it("names the claim tool only where it is served", async () => {
    expect(servedText(SPEC_TAKES_CLAIMS, new Set(servedActions(WITH_WALLET).map(({ name }) => name)))).toContain("claim it with solive_wallet_claim before working on it or hosting the work");
    expect(servedText(SPEC_TAKES_CLAIMS, new Set(servedActions(WITHOUT).map(({ name }) => name)))).toBe("this job takes claims: while one holds, only its worker can be paid");
  });

  it("gives no claim hint for a job that takes no claims or a spec that does not match", async () => {
    const { client } = await linked(WITH_WALLET);
    const plain = await escrow(client, SPEC_URL);
    expect(await ok(client, "get_spec", { intent: plain })).not.toHaveProperty("next");
    const other = await claimable(client, OTHER_URL);
    const read = await ok(client, "get_spec", { intent: other });
    expect(read["matches"]).toBe(false);
    expect(read).not.toHaveProperty("next");
  });
});
