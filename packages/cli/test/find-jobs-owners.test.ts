import { type Address, generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { Kind } from "@intent-engine/core";
import { createClient } from "@intent-engine/client/node";
import { openProofEscrows } from "@intent-engine/client/internal";
import { agentServer } from "../src/agent/mcp.js";
import { claimsOf } from "../src/agent/claims.js";
import { servedActions } from "../src/agent/everyday.js";
import { EXCLUDED_MAX, findJobs, JOBS_FOUND, NO_JOB_NOW, PUBLISH_PROFILE } from "../src/agent/jobs.js";
import { tool } from "../src/agent/names.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { EXIT_OK } from "../src/main.js";
import { ata, cli, funded, h, NOW, runtime, transport, type World, world } from "./harness.js";

type Json = Record<string, unknown>;

const specHash = new Uint8Array(32).fill(7);

describe("find_jobs by owner", () => {
  let w: World;
  let other: KeyPairSigner;
  let judge: Address;

  const openJob = async (owner: KeyPairSigner) => {
    const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge, specHash, judgeFee: 0n } as const;
    const made = await createClient({ url: "http://cluster", transport }).createIntent({
      signer: owner,
      inputMint: w.inputMint,
      outputMint: w.outputMint,
      params,
      nonce: 0n,
      expiresAt: NOW + 3_600n,
    });
    return made.intent;
  };

  async function linked(): Promise<Client> {
    const rt = runtime({});
    const server = agentServer(
      { transport, relay: undefined, agent: undefined, claims: claimsOf(), clock: { now: rt.now, sleep: rt.sleep } },
      servedActions({ wallet: false, allTools: false, relay: false, agent: false }),
    );
    const [near, far] = InMemoryTransport.createLinkedPair();
    await server.connect(near);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(far);
    return client;
  }

  const listed = async (client: Client, args: Json): Promise<Address[]> => {
    const result = await client.callTool({ name: tool("find_jobs"), arguments: { attestor: judge, ...args } });
    expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
    return ((result.structuredContent as Json)["jobs"] as { intent: Address }[]).map(({ intent }) => intent);
  };

  beforeEach(async () => {
    w = await world();
    other = await funded();
    await ata(w.authority, other.address, w.inputMint, 1_000n);
    await ata(w.authority, other.address, w.outputMint);
    await ata(w.authority, w.owner.address, w.outputMint, 1_000n);
    judge = (await generateKeyPairSigner()).address;
    h.watched.push(w.owner.address, other.address);
  });

  it("leaves out a job whose owner exclude_owners names, and keeps only one owner's jobs with owner", async () => {
    const client = await linked();
    const skipped = await openJob(w.owner);
    const kept = await openJob(other);
    expect(new Set(await listed(client, {}))).toEqual(new Set([skipped, kept]));
    expect(await listed(client, { exclude_owners: [w.owner.address] })).toEqual([kept]);
    expect(await listed(client, { exclude_owners: [w.owner.address, other.address] })).toEqual([]);
    expect(await listed(client, { owner: w.owner.address })).toEqual([skipped]);
    expect(await listed(client, { owner: other.address, exclude_owners: [other.address] })).toEqual([]);
    expect(await listed(client, { exclude_owners: [w.owner.address], min_pay: "0.0001" })).toEqual([kept]);
    expect((await openProofEscrows(transport, { excludeOwners: [other.address] })).map(({ address }) => address)).toEqual([skipped]);
  });

  it("describes both filters and caps the excluded list", () => {
    expect(findJobs.description).toContain("made by one owner, not made by exclude_owners");
    const input = JSON.stringify(findJobs.input.json);
    expect(input).toContain("only escrows this wallet made");
    expect(input).toContain("leave out escrows any of these wallets made");
    expect(input).toContain(`"maxItems":${EXCLUDED_MAX}`);
  });
});

describe("find_jobs on a wallet with no profile", () => {
  it("points the worker to publishing a profile until it has one", async () => {
    await world();
    h.files.clear();
    h.served.length = 0;
    const started = await cli(["mcp", "--url", "devnet", "--wallet"], {});
    expect([started.code, started.err]).toEqual([EXIT_OK, WALLET_NOTICE.join("\n")]);
    const [near, far] = InMemoryTransport.createLinkedPair();
    await h.served[0]?.connect(near);
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(far);
    const ok = async (name: string, args: Json = {}): Promise<Json> => {
      const result = await client.callTool({ name: tool(name), arguments: args });
      expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
      return result.structuredContent as Json;
    };
    expect((await ok("find_jobs"))["next"]).toBe(NO_JOB_NOW);
    await ok("wallet_setup");
    expect((await ok("find_jobs"))["next"]).toBe(`${NO_JOB_NOW}; ${PUBLISH_PROFILE}`);
    expect(PUBLISH_PROFILE).toContain(tool("wallet_profile"));
    expect(JOBS_FOUND).not.toContain(tool("wallet_profile"));
    const profile = { skills: ["rust"], endpoint: "https://" + "worker.example.org/jobs" };
    const shown = await ok("wallet_profile", profile);
    expect(await ok("wallet_profile", { ...profile, approval: shown["approval"], send: true })).toMatchObject({ sent: true });
    expect((await ok("find_jobs"))["next"]).toBe(NO_JOB_NOW);
  });
});
