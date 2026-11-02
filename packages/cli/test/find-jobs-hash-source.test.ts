import { createHash } from "node:crypto";
import { type Address, getBase64Encoder, getTransactionDecoder, partiallySignTransaction } from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { seal, specMemo } from "@intent-engine/core/internal";
import type { SpecFetch, SpecSource } from "@intent-engine/client";
import { agentServer } from "../src/agent/mcp.js";
import { claimsOf } from "../src/agent/claims.js";
import { invitesOf } from "../src/invites.js";
import { workerSpec } from "../src/agent/wallet/worker.js";
import { creation, h, ownerSigned, transport, type World, world } from "./harness.js";
import { served } from "./untrusted-kit.js";

vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "93.184.215.14", family: 4 }] }));

const SPEC = "deliver a parser whose tests pass";
const GONE_URL = "https://" + "example.org/gone.md";
const MIRROR = "https://" + "mirror.example";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const MIRRORED = MIRROR + "/sha256/" + sha(SPEC);
const SOURCES: SpecSource[] = [{ kind: "memo" }, { kind: "mirror", base: MIRROR }];
const OPEN_URL = "https://" + "example.org/open.md";
const SEALED_URL = "https://" + "example.org/sealed.md";

describe("a job whose spec only a hash source serves", () => {
  let w: World;
  let client: Client;
  let mirrored: boolean;
  let asked: string[];
  let sealed: Uint8Array;

  const specFetch: SpecFetch = async (url) => {
    asked.push(url);
    if (url === OPEN_URL) {
      return new Response(SPEC);
    }
    if (url === SEALED_URL) {
      return new Response(Uint8Array.from(sealed));
    }
    return url === MIRRORED && mirrored ? new Response(SPEC) : new Response("gone", { status: 404 });
  };

  const escrow = async (specUrl?: string): Promise<Address> => {
    const made = await served(client, "prepare_create", {
      owner: w.owner.address,
      input_mint: w.inputMint,
      output_mint: w.outputMint,
      order: { kind: "attested", amount_in: "100", min_result: "1", max_result: "1", attestor: w.authority.address, spec_hash: sha(SPEC) },
      expires_in: 3_600,
      ...(specUrl === undefined ? {} : { spec_url: specUrl }),
    });
    expect(made.error, JSON.stringify(made.value)).toBe(false);
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode((made.value["prepared"] as { transaction: string }).transaction));
    const sent = h.svm.sendTransaction(await partiallySignTransaction([w.owner.keyPair], tx));
    if (sent instanceof FailedTransactionMetadata) {
      throw new Error(sent.toString());
    }
    const intent = made.value["intent"] as Address;
    h.engineLog.push({ ...creation(intent), ...ownerSigned(intent, specUrl === undefined ? [] : [specMemo(specUrl)]) });
    return intent;
  };

  beforeEach(async () => {
    w = await world();
    h.watched.push(w.owner.address);
    mirrored = true;
    asked = [];
    sealed = await seal(new TextEncoder().encode(SPEC), [w.authority.address]);
    const server = agentServer({ transport, relay: undefined, agent: undefined, claims: claimsOf(), fetch: specFetch, specSources: SOURCES });
    const [near, far] = InMemoryTransport.createLinkedPair();
    await server.connect(near);
    client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(far);
  });

  const listed = async () => ((await served(client, "find_jobs", { attestor: w.authority.address })).value["jobs"] as { intent: Address; spec_url: string | null }[]).map(({ intent, spec_url }) => [intent, spec_url]);

  it("lists a job with no memo url and one whose memo url is gone, and drops them when no source serves", async () => {
    const none = await escrow();
    const gone = await escrow(GONE_URL);
    expect(Object.fromEntries(await listed())).toStrictEqual({ [none]: null, [gone]: GONE_URL });
    mirrored = false;
    expect(await listed()).toStrictEqual([]);
  });

  it("says get_spec read it from the mirror, then from the cache without a request", async () => {
    const intent = await escrow();
    const first = await served(client, "get_spec", { intent });
    expect(first).toMatchObject({ error: false, value: { url: MIRRORED, source: "mirror", sha256: sha(SPEC), matches: true, text: SPEC } });
    expect(asked).toStrictEqual([MIRRORED]);
    mirrored = false;
    asked.length = 0;
    expect(await served(client, "get_spec", { intent })).toMatchObject({ error: false, value: { source: "cache", matches: true, text: SPEC } });
    expect(asked).toStrictEqual([]);
  });

  it("checks invites on the memo url alone, so a hash source never opens a job it cannot see sealed", async () => {
    const intent = await escrow(GONE_URL);
    const invites = await invitesOf(transport, specFetch, intent, { lookup: async () => ["93.184.215.14"] });
    expect(invites).toStrictEqual({ kind: "unread", reason: `the spec at ${GONE_URL} answered 404` });
    expect(asked).toStrictEqual([GONE_URL]);
  });

  it("never answers an invite-only job with the cached spec of an open job that shares its hash", async () => {
    const open = await escrow(OPEN_URL);
    const closed = await escrow(SEALED_URL);
    expect(await served(client, "get_spec", { intent: open })).toMatchObject({ error: false, value: { source: "memo", matches: true } });
    expect(await served(client, "get_spec", { intent: open })).toMatchObject({ error: false, value: { source: "cache" } });
    expect(await served(client, "get_spec", { intent: closed })).toMatchObject({ error: true, value: { code: "SpecSealed" } });
  });

  it("checks a local worker's job with the sources the server was given", async () => {
    const gone = await escrow(GONE_URL);
    const ctx = { transport, relay: undefined, agent: undefined, claims: claimsOf(), fetch: specFetch, lookup: async () => ["93.184.215.14"] };
    expect(await workerSpec({ ...ctx, specSources: SOURCES }, gone)).toMatchObject({ url: MIRRORED, source: "mirror", matches: true });
    await expect(workerSpec(ctx, gone)).rejects.toMatchObject({ problem: { code: "WorkerUnfit" } });
  });
});
