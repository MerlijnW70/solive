import { createClient, type SpecSource, type Transport } from "@intent-engine/client";
import { type SpecFetch, SpecUnreadable } from "@intent-engine/client/internal";
import { testSignature } from "@intent-engine/client/testing";
import { Kind } from "@intent-engine/core";
import { EVENT_IX_TAG, getIntentCreatedEventEncoder, INTENT_ENGINE_PROGRAM_ADDRESS, specMemo } from "@intent-engine/core/internal";
import { getBase58Decoder, type Address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { mirror, type MirrorDeps } from "../src/mirror.js";
import { harness, intentBytes, key, OWNER, proofIntent, sha } from "./harness.js";

const SPEC = "deliver a module whose tests pass\n";
const HEX = sha(SPEC);
const INTENT = key(91);
const MEMO_URL = "https://" + "specs.example/job.md";
const BASE = "https://" + "mirror.example";
const GENESIS = getBase58Decoder().decode(new Uint8Array(32).fill(7));

const created = (intent: Address, owner: Address): Uint8Array =>
  new Uint8Array([
    ...EVENT_IX_TAG,
    ...getIntentCreatedEventEncoder().encode({
      intent,
      owner,
      nonce: 0n,
      kind: Kind.AttestedResult,
      inputMint: key(7),
      outputMint: key(7),
      receiver: owner,
      escrowed: 100n,
      expiresAt: 1_000n,
      rentPayer: owner,
      flags: 0,
      bounty: 0,
    } as never),
  ]);

const chain = (): Transport =>
  ({
    getAccount: async (address: Address) => (address === INTENT ? { owner: INTENT_ENGINE_PROGRAM_ADDRESS, data: intentBytes(proofIntent(HEX)), lamports: 1n } : null),
    engineTransactions: async () => [
      { signature: testSignature("made"), slot: 1n, blockTime: null, failed: false, emitted: [created(INTENT, OWNER)], memos: [specMemo(MEMO_URL)], memoSigners: [[OWNER]] },
    ],
    genesisHash: async () => GENESIS,
  }) as unknown as Transport;

function fetchThrough(deps: MirrorDeps, asked: string[]): SpecFetch {
  return async (url) => {
    asked.push(url);
    if (!url.startsWith(BASE)) return new Response("gone", { status: 500 });
    const parsed = new URL(url);
    const answer = await mirror({ method: "GET", url: parsed.pathname + parsed.search, caller: "reader", body: async () => null }, deps);
    return new Response(Uint8Array.from(answer.body), { status: answer.status, headers: answer.headers });
  };
}

const sources: SpecSource[] = [{ kind: "memo" }, { kind: "mirror", base: BASE }];

describe("a client with this mirror as a source", () => {
  it("reads a spec whose memo url fails, after the spec was uploaded through the handler", async () => {
    const h = harness();
    h.node.holds(proofIntent(HEX));
    const bytes = new TextEncoder().encode(SPEC);
    const put = await mirror({ method: "PUT", url: `/sha256/${HEX}`, caller: "hirer", body: async () => bytes }, h.deps);
    expect(put.status).toBe(201);
    const asked: string[] = [];
    const client = createClient({ url: BASE, transport: chain(), fetch: fetchThrough(h.deps, asked), specSources: sources });
    const spec = await client.spec(INTENT);
    expect(spec).toMatchObject({ url: `${BASE}/sha256/${HEX}`, source: "mirror", text: SPEC, sha256: HEX, matches: true });
    expect(asked).toStrictEqual([MEMO_URL, `${BASE}/sha256/${HEX}`]);
  });

  it("asks the mirror and reads no spec before the upload", async () => {
    const asked: string[] = [];
    const client = createClient({ url: BASE, transport: chain(), fetch: fetchThrough(harness().deps, asked), specSources: sources });
    await expect(client.spec(INTENT)).rejects.toBeInstanceOf(SpecUnreadable);
    expect(asked).toStrictEqual([MEMO_URL, `${BASE}/sha256/${HEX}`]);
  });
});
