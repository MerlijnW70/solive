import { type Address, generateKeyPairSigner, type KeyPairSigner } from "@solana/kit";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { Kind } from "@intent-engine/core";
import { buildClaimJob, buildDropClaim, buildOpenClaims, claimBoardAddress } from "@intent-engine/core/internal";
import { type Transport } from "@intent-engine/client";
import { createClient } from "@intent-engine/client/node";
import { agentServer } from "../src/agent/mcp.js";
import { claimsOf } from "../src/agent/claims.js";
import { EXIT_OK } from "../src/main.js";
import { cli, funded, h, NOW, send, setNow, transport, type World, world } from "./harness.js";

type Json = Record<string, unknown>;
type Held = { intent: Address; takes_claims: boolean; claimed_by: Address | null; claim_ends: string | null };

const specHash = new Uint8Array(32).fill(7);
const batches: Address[][] = [];

const counted: Transport = {
  ...transport,
  getAccounts: async (addresses) => {
    batches.push([...addresses]);
    return transport.getAccounts(addresses);
  },
};

async function linked(): Promise<Client> {
  const server = agentServer({ transport: counted, relay: undefined, agent: undefined, claims: claimsOf() });
  const [near, far] = InMemoryTransport.createLinkedPair();
  await server.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return client;
}

const held = (jobs: Held[]) => jobs.map(({ intent, takes_claims, claimed_by, claim_ends }) => ({ intent, takes_claims, claimed_by, claim_ends }));

describe("jobs show which are claimed", () => {
  let w: World;
  let worker: KeyPairSigner;
  let never: Address;
  let open: Address;
  let live: Address;
  let lapsed: Address;
  let dropped: Address;

  beforeEach(async () => {
    w = await world();
    h.watched.push(w.owner.address);
    h.through = counted;
    batches.length = 0;
    worker = await funded();
    const attestor = (await generateKeyPairSigner()).address;
    const client = createClient({ url: "http://cluster", transport });
    const escrow = async (nonce: bigint, left: bigint) =>
      (
        await client.createIntent({
          signer: w.owner,
          inputMint: w.inputMint,
          outputMint: w.outputMint,
          params: { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor, specHash, judgeFee: 0n },
          nonce,
          expiresAt: NOW + left,
        })
      ).intent;
    const claimable = async (nonce: bigint, left: bigint) => {
      const intent = await escrow(nonce, left);
      await send(w.owner, [await buildOpenClaims({ owner: w.owner, intent, maxSecs: 3_600, stake: 1_000_000n })]);
      return intent;
    };
    const claim = async (intent: Address, secs: number) => send(worker, [await buildClaimJob({ worker, intent, owner: w.owner.address, secs })]);
    never = await escrow(1n, 3_605n);
    open = await claimable(2n, 3_604n);
    live = await claimable(3n, 3_603n);
    lapsed = await claimable(4n, 3_602n);
    dropped = await claimable(5n, 3_601n);
    await claim(live, 3_000);
    await claim(lapsed, 60);
    await claim(dropped, 3_000);
    await send(worker, [await buildDropClaim({ worker, intent: dropped })]);
    setNow(NOW + 100n);
  });

  const command = async (argv: string[] = []) => {
    const result = await cli(["jobs", ...argv], {});
    expect([result.code, result.err]).toEqual([EXIT_OK, ""]);
    return held(result.json()["jobs"] as Held[]);
  };

  const found = async (args: Json = {}) => {
    const client = await linked();
    const result = await client.callTool({ name: "solive_find_jobs", arguments: args });
    expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
    return held((result.structuredContent as Json)["jobs"] as Held[]);
  };

  it("say which jobs take claims, name the live claimant and when its claim ends, and no one for a job never claimed, lapsed or dropped", async () => {
    const free = (intent: Address) => ({ intent, takes_claims: true, claimed_by: null, claim_ends: null });
    const expected = [
      { ...free(never), takes_claims: false },
      free(open),
      { intent: live, takes_claims: true, claimed_by: worker.address, claim_ends: String(NOW + 3_000n) },
      free(lapsed),
      free(dropped),
    ];
    expect(await command()).toEqual(expected);
    expect(await found()).toEqual(expected);
  });

  it("unclaimed lists only the jobs no one holds", async () => {
    const intents = (jobs: Held[]) => jobs.map(({ intent }) => intent);
    const unheld = [never, open, lapsed, dropped];
    expect(intents(await command(["--unclaimed"]))).toEqual(unheld);
    expect(intents(await found({ unclaimed: true }))).toEqual(unheld);
    expect(intents(await found({ unclaimed: false }))).toEqual([never, open, live, lapsed, dropped]);
  });

  it("the command keeps every field it listed before", async () => {
    const result = await cli(["jobs"], {});
    const [first] = result.json()["jobs"] as Json[];
    expect(first).toMatchObject({ intent: never, owner: w.owner.address, nonce: "1", sells: "100", judgeFee: "0", inputMint: w.inputMint, payable: true, claimed_by: null, claim_ends: null });
  });

  it("reads every claim board once per listing, in one batch", async () => {
    const boards = await Promise.all([never, open, live, lapsed, dropped].map(claimBoardAddress));
    const reads = async (run: () => Promise<unknown>) => {
      const before = boards.map((address) => h.reads.get(address) ?? 0);
      batches.length = 0;
      await run();
      expect(batches.some((batch) => boards.every((board) => batch.includes(board)))).toBe(true);
      return boards.map((address, i) => (h.reads.get(address) ?? 0) - (before[i] ?? 0));
    };
    const once = boards.map(() => 1);
    expect(await reads(command)).toEqual(once);
    expect(await reads(found)).toEqual(once);
  });
});
