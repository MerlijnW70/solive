import { createHash } from "node:crypto";
import { type Address, getBase64Encoder, getTransactionDecoder, partiallySignTransaction } from "@solana/kit";
import { FailedTransactionMetadata } from "litesvm";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { specMemo } from "@intent-engine/core";
import { DEVNET_GENESIS_HASH, type SpecFetch } from "@intent-engine/client";
import { agentServer } from "../../src/agent/mcp.js";
import { claimsOf } from "../../src/agent/claims.js";
import { creation, h, ownerSigned, transport, type World, world } from "../harness.js";

type Json = Record<string, unknown>;
type Fetched = { url: string };

const SPEC = "the acceptance spec the work must pass\n";
const METADATA_HOST = "169.254.169.254";
const METADATA_URL = "https://" + METADATA_HOST + "/jobs/spec.md";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function serving(fetched: Fetched[]): SpecFetch {
  return async (url) => {
    fetched.push({ url });
    return new Response(SPEC);
  };
}

async function linked(fetch: SpecFetch): Promise<Client> {
  const server = agentServer({ transport, relay: undefined, agent: undefined, claims: claimsOf(), fetch });
  const [near, far] = InMemoryTransport.createLinkedPair();
  await server.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return client;
}

async function call(client: Client, name: string, args: object): Promise<{ isError: boolean; value: Json }> {
  const result = await client.callTool({ name: `solive_${name}`, arguments: args as Record<string, unknown> });
  return { isError: result.isError === true, value: result.structuredContent as Json };
}

describe("get_spec against a private spec host on a public cluster", () => {
  let w: World;
  let client: Client;
  const fetched: Fetched[] = [];

  const escrow = async (specUrl: string): Promise<Address> => {
    const order = { kind: "attested", amount_in: "100", min_result: "1", max_result: "1", attestor: w.authority.address, spec_hash: sha(SPEC) };
    const terms = { owner: w.owner.address, input_mint: w.inputMint, output_mint: w.outputMint, order, expires_in: 3_600 };
    const made = await call(client, "prepare_create", { ...terms, spec_url: specUrl });
    expect(made.isError, JSON.stringify(made.value)).toBe(false);
    const prepared = made.value["prepared"] as { transaction: string };
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(prepared.transaction));
    const sent = h.svm.sendTransaction(await partiallySignTransaction([w.owner.keyPair], tx));
    if (sent instanceof FailedTransactionMetadata) {
      throw new Error(sent.toString());
    }
    const intent = made.value["intent"] as Address;
    h.engineLog.push({ ...creation(intent), ...ownerSigned(intent, [specMemo(specUrl)]) });
    return intent;
  };

  beforeEach(async () => {
    w = await world();
    h.watched.push(w.owner.address);
    h.genesis = DEVNET_GENESIS_HASH;
    fetched.length = 0;
    client = await linked(serving(fetched));
  });

  it("F-1: owner points a proof escrow's spec url at the cloud metadata address and get_spec fetches it", async () => {
    const intent = await escrow(METADATA_URL);
    await call(client, "get_spec", { intent });
    expect(fetched.map((f) => f.url)).not.toContain(METADATA_URL);
  });
});
