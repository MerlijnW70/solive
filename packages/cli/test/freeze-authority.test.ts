import { createHash } from "node:crypto";
import { type Address, generateKeyPairSigner, type KeyPairSigner, lamports } from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { findAssociatedTokenAddress, Kind, specMemo, TOKEN_2022_PROGRAM_ADDRESS } from "@intent-engine/core";
import { createClient, type SpecFetch } from "@intent-engine/client";
import { agentServer } from "../src/agent/mcp.js";
import { claimsOf } from "../src/agent/claims.js";
import { findJobs } from "../src/agent/jobs.js";
import { getSpec } from "../src/agent/spec.js";
import { EXIT_OK } from "../src/main.js";
import { cli, creation, h, NOW, ownerSigned, send, transport, type World, world } from "./harness.js";

type Json = Record<string, unknown>;

const SPEC = "the acceptance spec\n";
const SPEC_URL = "https://example.org/jobs/freeze.md";
const specHash = createHash("sha256").update(SPEC).digest();
const serve: SpecFetch = async () => new Response(SPEC);

async function tokenMint(payer: KeyPairSigner, programAddress: Address, freezeAuthority: Address | null): Promise<Address> {
  const m = await generateKeyPairSigner();
  const space = BigInt(getMintSize());
  await send(payer, [
    getCreateAccountInstruction({ payer, newAccount: m, lamports: lamports(h.svm.minimumBalanceForRentExemption(space)), space, programAddress }),
    getInitializeMint2Instruction({ mint: m.address, decimals: 6, mintAuthority: payer.address, freezeAuthority }, { programAddress }),
  ]);
  return m.address;
}

async function funds(payer: KeyPairSigner, owner: Address, m: Address, tokenProgram: Address): Promise<void> {
  const token = await findAssociatedTokenAddress({ owner, mint: m, tokenProgram });
  await send(payer, [
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner, mint: m, tokenProgram }),
    getMintToInstruction({ mint: m, token, mintAuthority: payer, amount: 1_000_000n }, { programAddress: tokenProgram }),
  ]);
}

async function linked(): Promise<Client> {
  const server = agentServer({ transport, relay: undefined, agent: undefined, claims: claimsOf(), fetch: serve });
  const [near, far] = InMemoryTransport.createLinkedPair();
  await server.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return client;
}

type Freeze = { freeze_authority: Address | null; freeze_warning?: string };

const freezeOf = ({ freeze_authority, freeze_warning }: Json): Freeze =>
  freeze_warning === undefined
    ? { freeze_authority: freeze_authority as Address | null }
    : { freeze_authority: freeze_authority as Address | null, freeze_warning: freeze_warning as string };

describe("a job names the freeze authority of its mint", () => {
  let w: World;
  let stranger: Address;
  const escrows = new Map<string, Address>();
  const mintsOf = new Map<string, Address>();

  beforeEach(async () => {
    w = await world();
    h.watched.push(w.owner.address);
    stranger = (await generateKeyPairSigner()).address;
    const owner = w.owner.address;
    const mints: [string, Address, Address | null][] = [
      ["none", TOKEN_PROGRAM_ADDRESS, null],
      ["third party", TOKEN_PROGRAM_ADDRESS, stranger],
      ["owner", TOKEN_PROGRAM_ADDRESS, owner],
      ["token-2022", TOKEN_2022_PROGRAM_ADDRESS, stranger],
    ];
    const client = createClient({ url: "http://cluster", transport });
    escrows.clear();
    mintsOf.clear();
    for (const [i, [name, program, freeze]] of mints.entries()) {
      const inputMint = await tokenMint(w.authority, program, freeze);
      await funds(w.authority, owner, inputMint, program);
      const params = { kind: Kind.AttestedResult, amountIn: 1_000n, minResult: 1n, maxResult: 1n, attestor: w.authority.address, specHash, judgeFee: 0n } as const;
      const nonce = BigInt(i + 1);
      const made = await client.createIntent({ signer: w.owner, inputMint, outputMint: w.outputMint, params, nonce, expiresAt: NOW + 3_600n + nonce });
      h.engineLog.push({ ...creation(made.intent), ...ownerSigned(made.intent, [specMemo(SPEC_URL)]) });
      escrows.set(name, made.intent);
      mintsOf.set(name, inputMint);
    }
  });

  const expected = (): Record<string, Freeze> => ({
    none: { freeze_authority: null },
    "third party": { freeze_authority: stranger, freeze_warning: `${stranger} holds the freeze authority of this job's token and can freeze the payment` },
    owner: {
      freeze_authority: w.owner.address,
      freeze_warning: `the escrow's owner ${w.owner.address} holds the freeze authority of this job's token and can freeze the payment`,
    },
    "token-2022": { freeze_authority: stranger, freeze_warning: `${stranger} holds the freeze authority of this job's token and can freeze the payment` },
  });

  const byName = (jobs: Json[]): Record<string, Freeze> =>
    Object.fromEntries([...escrows].map(([name, intent]) => [name, freezeOf(jobs.find((job) => job["intent"] === intent) ?? {})]));

  it("lists the same freeze authority and sentence in the command, find_jobs and get_spec", async () => {
    const command = await cli(["jobs"], {});
    expect([command.code, command.err]).toEqual([EXIT_OK, ""]);
    expect(byName(command.json()["jobs"] as Json[])).toEqual(expected());
    const client = await linked();
    const found = await client.callTool({ name: "solive_find_jobs", arguments: {} });
    expect(found.isError, JSON.stringify(found.structuredContent)).not.toBe(true);
    expect(byName((found.structuredContent as Json)["jobs"] as Json[])).toEqual(expected());
    for (const [name, intent] of escrows) {
      const spec = await client.callTool({ name: "solive_get_spec", arguments: { intent } });
      expect(spec.isError, JSON.stringify(spec.structuredContent)).not.toBe(true);
      expect(freezeOf(spec.structuredContent as Json), name).toEqual(expected()[name]);
      expect((spec.structuredContent as Json)["matches"]).toBe(true);
    }
  });

  it("reads a Token-2022 mint at the same offsets as a Token mint", () => {
    const owners = [...mintsOf].map(([name, mint]) => {
      const view = h.svm.getAccount(mint);
      return [name, view.exists ? view.programAddress : null];
    });
    expect(Object.fromEntries(owners)).toEqual({
      none: TOKEN_PROGRAM_ADDRESS,
      "third party": TOKEN_PROGRAM_ADDRESS,
      owner: TOKEN_PROGRAM_ADDRESS,
      "token-2022": TOKEN_2022_PROGRAM_ADDRESS,
    });
  });

  it("names a mint it cannot read as having no freeze authority", async () => {
    const intent = escrows.get("third party") ?? stranger;
    const held = h.svm.getAccount(mintsOf.get("third party") ?? stranger);
    if (!held.exists) {
      throw new Error("mint missing");
    }
    h.svm.setAccount({ ...held, programAddress: stranger });
    const command = await cli(["jobs"], {});
    expect(byName(command.json()["jobs"] as Json[])["third party"]).toEqual({ freeze_authority: null });
    const client = await linked();
    const found = await client.callTool({ name: "solive_find_jobs", arguments: {} });
    expect(byName((found.structuredContent as Json)["jobs"] as Json[])["third party"]).toEqual({ freeze_authority: null });
    const spec = await client.callTool({ name: "solive_get_spec", arguments: { intent } });
    expect(freezeOf(spec.structuredContent as Json)).toEqual({ freeze_authority: null });
  });

  it("adds one sentence to each tool description", () => {
    expect(findJobs.description).toContain("freeze_authority is the wallet that can freeze the payment in input_mint, or null, and freeze_warning names it.");
    expect(getSpec.description).toContain("freeze_authority is the wallet that can freeze the payment in the escrow's token, or null, and freeze_warning names it.");
  });
});
