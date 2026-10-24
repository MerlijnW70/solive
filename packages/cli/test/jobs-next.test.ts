import { type Address, generateKeyPairSigner } from "@solana/kit";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { Kind } from "@intent-engine/core";
import { createClient } from "@intent-engine/client";
import { agentServer } from "../src/agent/mcp.js";
import { claimsOf } from "../src/agent/claims.js";
import { type Serving, servedActions } from "../src/agent/everyday.js";
import { checkDelivery, DELIVER_NEXT, prepareDeliver, UNGUESSABLE_URL, walletCheckDelivery, walletDeliver } from "../src/agent/wallet/delivery.js";
import { NO_JOB_NOW } from "../src/agent/jobs.js";
import { ata, h, NOW, runtime, transport, type World, world } from "./harness.js";

type Json = Record<string, unknown>;

const SPEC_STEP = "read a job's spec with solive_get_spec and work on it only when matches is true";
const CLAIMS_STEP = "a job with takes_claims true pays only the worker holding its claim while the claim holds";
const CLAIM_STEP = "claim one with solive_wallet_claim before working on it or hosting the work";

const MODES: { label: string; serving: Serving; next: string }[] = [
  { label: "no wallet", serving: { wallet: false, allTools: false, relay: false, agent: false }, next: `${SPEC_STEP}; ${CLAIMS_STEP}` },
  { label: "wallet", serving: { wallet: true, allTools: false, relay: false, agent: false }, next: `${SPEC_STEP}; ${CLAIMS_STEP}; ${CLAIM_STEP}` },
  { label: "wallet, relay and agent", serving: { wallet: true, allTools: false, relay: true, agent: true }, next: `${SPEC_STEP}; ${CLAIMS_STEP}; ${CLAIM_STEP}` },
  { label: "wallet, all tools", serving: { wallet: true, allTools: true, relay: false, agent: false }, next: `${SPEC_STEP}; ${CLAIMS_STEP}; ${CLAIM_STEP}` },
];

const specHash = new Uint8Array(32).fill(9);

describe("solive_find_jobs next hint", () => {
  let w: World;
  let judge: Address;

  const openJob = async () => {
    const client = createClient({ url: "http://cluster", transport });
    const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge, specHash, judgeFee: 0n } as const;
    return (await client.createIntent({ signer: w.owner, inputMint: w.inputMint, outputMint: w.outputMint, params, nonce: 1n, expiresAt: NOW + 3_600n })).intent;
  };

  async function linked(serving: Serving): Promise<Client> {
    const rt = runtime({});
    const server = agentServer({ transport, relay: undefined, agent: undefined, claims: claimsOf(), clock: { now: rt.now, sleep: rt.sleep } }, servedActions(serving));
    const [near, far] = InMemoryTransport.createLinkedPair();
    await server.connect(near);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(far);
    return client;
  }

  const found = async (client: Client, args: Json) => {
    const result = await client.callTool({ name: "solive_find_jobs", arguments: { attestor: judge, ...args } });
    expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
    return result.structuredContent as Json;
  };

  beforeEach(async () => {
    w = await world();
    h.watched.push(w.owner.address);
    await ata(w.authority, w.owner.address, w.outputMint, 1_000n);
    judge = (await generateKeyPairSigner()).address;
    h.rounds = 10;
  });

  for (const { label, serving, next } of MODES) {
    it(`names the next served steps once it finds a job: ${label}`, async () => {
      const client = await linked(serving);
      expect(await found(client, {})).toEqual({ fee_bps: expect.any(Number), jobs: [], next: NO_JOB_NOW });
      const job = await openJob();
      const listed = await found(client, {});
      expect((listed["jobs"] as { intent: Address }[]).map(({ intent }) => intent)).toEqual([job]);
      expect(listed["next"]).toBe(next);
      expect((await found(client, { wait: 3 }))["next"]).toBe(next);
      const served = new Set(servedActions(serving).map((action) => action.name));
      expect([...`${next} ${NO_JOB_NOW}`.matchAll(/solive_\w+/g)].map(([name]) => name).filter((name) => !served.has(name))).toEqual([]);
    });
  }
});

describe("delivery tool texts", () => {
  it("tell the worker to keep the url unguessable without private hosting and to announce right after hosting", () => {
    expect(walletDeliver.description).toContain("Host the work at a url nobody can guess and announce right after hosting.");
    expect(UNGUESSABLE_URL).toBe("without private hosting, use a public host under a long random path or file name, such as 32 random hex characters, so nobody can guess it, and announce right after hosting");
    expect(JSON.stringify(walletDeliver.input.json)).toContain(UNGUESSABLE_URL);
    expect(prepareDeliver.description).toContain("so host it where nobody can guess, give its exact sha256 and send promptly");
    for (const text of [walletDeliver.description, prepareDeliver.description]) {
      expect(text).not.toContain("keep it private");
      expect(text).not.toContain("make the work public");
    }
  });

  it("tell the judge the sha256 is hidden and how it gets the work to release for", () => {
    expect(walletCheckDelivery.description).toContain("read from accounts");
    expect(walletCheckDelivery.description).toContain("A judge opens and fetches work with solive_wallet_fetch_work.");
    expect(checkDelivery.description).toContain("Each hides the work's sha256 in its commitment and seals its url to the judge.");
    expect(checkDelivery.description).toContain("This tool fetches and opens nothing and needs no wallet.");
  });

  it("say in the deliver preview that only send: true is passed back", () => {
    expect(DELIVER_NEXT).toBe("not sent; show the summary, then resend with send: true after approval; the commitment is shown only, never passed back");
    expect(JSON.stringify(walletDeliver.output.json)).toContain("the chain holds it in place of the hash");
  });
});
