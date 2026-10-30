import { createHash } from "node:crypto";
import { type Address, generateKeyPairSigner, getBase64Encoder, getTransactionDecoder, partiallySignTransaction } from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { seal, specMemo } from "@intent-engine/core/internal";
import type { SpecFetch } from "@intent-engine/client";
import { agentServer } from "../src/agent/mcp.js";
import { claimsOf } from "../src/agent/claims.js";
import { MORE_JOBS, NOT_CURSOR } from "../src/agent/jobs.js";
import { creation, h, ownerSigned, transport, type World, world } from "./harness.js";
import { served } from "./untrusted-kit.js";

vi.mock("node:dns/promises", () => ({ lookup: async () => [{ address: "93.184.215.14", family: 4 }] }));

const SPEC = "deliver a file that passes the tests";
const OPEN_URL = "https://" + "example.org/open.md";
const GONE_URL = "https://" + "example.org/gone.md";
const SEALED_URL = "https://" + "example.org/sealed.md";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("find_jobs lists only jobs whose spec reads", () => {
  let w: World;
  let client: Client;
  let sealed: Uint8Array;

  const specFetch: SpecFetch = async (url) => (url === OPEN_URL ? new Response(SPEC) : url === SEALED_URL ? new Response(sealed) : new Response("gone", { status: 404 }));

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
    sealed = await seal(new TextEncoder().encode(SPEC), [(await generateKeyPairSigner()).address]);
    const server = agentServer({ transport, relay: undefined, agent: undefined, claims: claimsOf(), fetch: specFetch });
    const [near, far] = InMemoryTransport.createLinkedPair();
    await server.connect(near);
    client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(far);
  });

  it("drops a job with no spec url, a spec url that does not answer and a spec sealed to another wallet, unless all is set", async () => {
    const none = await escrow();
    const open = await escrow(OPEN_URL);
    const gone = await escrow(GONE_URL);
    const closed = await escrow(SEALED_URL);
    const listed = async (args: Record<string, unknown>) => ((await served(client, "find_jobs", { attestor: w.authority.address, ...args })).value["jobs"] as { intent: Address }[]).map(({ intent }) => intent);
    expect(await listed({})).toEqual([open]);
    expect(new Set(await listed({ all: true }))).toEqual(new Set([none, open, gone, closed]));
  });

  it("pages with limit and more, and refuses a more it did not write", async () => {
    const made = [await escrow(OPEN_URL), await escrow(OPEN_URL), await escrow(OPEN_URL)];
    const first = await served(client, "find_jobs", { attestor: w.authority.address, limit: 2 });
    expect(first.value["jobs"]).toHaveLength(2);
    expect(String(first.value["next"])).toContain(MORE_JOBS);
    const rest = await served(client, "find_jobs", { attestor: w.authority.address, limit: 2, more: first.value["more"] });
    expect(rest.value["more"]).toBeUndefined();
    const seen = [...(first.value["jobs"] as { intent: Address }[]), ...(rest.value["jobs"] as { intent: Address }[])].map(({ intent }) => intent);
    expect(new Set(seen)).toEqual(new Set(made));
    expect(seen).toHaveLength(3);
    const refused = await served(client, "find_jobs", { more: "page two" });
    expect(refused).toMatchObject({ error: true, value: { code: "InvalidInput", issues: [{ path: "more", message: NOT_CURSOR }] } });
  });
});
