import { type Address, generateKeyPairSigner, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { findConfigPda, getConfigDecoder, getConfigEncoder, getIntentDecoder, getIntentEncoder, Kind, kindBit, NATIVE_MINT, PAUSE_FILL } from "@intent-engine/core";
import { createClient } from "@intent-engine/client";
import { agentServer } from "../src/agent/mcp.js";
import { claimsOf } from "../src/agent/claims.js";
import { EXIT_OK } from "../src/main.js";
import { ata, cli, h, NOW, transport, type World, world } from "./harness.js";

type Json = Record<string, unknown>;
type Pay = { intent: Address; net_pay: string; payable: boolean };

const specHash = new Uint8Array(32).fill(9);

function preset(at: Address, decimals: number): void {
  const space = BigInt(getMintSize());
  h.svm.setAccount({
    address: at,
    data: Uint8Array.from(getMintEncoder().encode({ mintAuthority: none(), supply: 0n, decimals, isInitialized: true, freezeAuthority: none() })),
    executable: false,
    lamports: lamports(h.svm.minimumBalanceForRentExemption(space)),
    programAddress: TOKEN_PROGRAM_ADDRESS,
    space,
  });
}

function edit<T>(address: Address, decode: (data: Uint8Array) => T, encode: (value: T) => Uint8Array, change: Partial<T>): void {
  const view = h.svm.getAccount(address);
  if (!view.exists) {
    throw new Error("account missing");
  }
  h.svm.setAccount({ ...view, data: Uint8Array.from(encode({ ...decode(view.data), ...change })) });
}

const editIntent = (address: Address, change: { partner?: Address; partnerBps?: number; partnerCutBps?: number }) =>
  edit(address, (data) => getIntentDecoder().decode(data), (value) => Uint8Array.from(getIntentEncoder().encode(value)), change);

type ConfigChange = { paused?: number; fillDisabledKinds?: bigint; feeBps?: number; kindFeeMask?: number; kindFeeBps?: number[]; partnerCutBps?: number };

async function editConfig(change: ConfigChange): Promise<void> {
  const [address] = await findConfigPda();
  edit(address, (data) => getConfigDecoder().decode(data), (value) => Uint8Array.from(getConfigEncoder().encode(value)), change);
}

async function linked(): Promise<Client> {
  const server = agentServer({ transport, relay: undefined, agent: undefined, claims: claimsOf() });
  const [near, far] = InMemoryTransport.createLinkedPair();
  await server.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return client;
}

const pays = (jobs: Pay[]) => jobs.map(({ intent, net_pay, payable }) => ({ intent, net_pay, payable }));

describe("jobs show what they pay after fees", () => {
  let w: World;
  let token: Address;
  let sol: Address;
  let stuck: Address;

  beforeEach(async () => {
    w = await world();
    h.watched.push(w.owner.address);
    preset(NATIVE_MINT, 9);
    await ata(w.authority, w.owner.address, w.inputMint, 2_000_000n);
    const attestor = (await generateKeyPairSigner()).address;
    const partner = (await generateKeyPairSigner()).address;
    const proof = (amountIn: bigint, judgeFee: bigint) => ({ kind: Kind.AttestedResult, amountIn, minResult: 1n, maxResult: 1n, attestor, specHash, judgeFee }) as const;
    const client = createClient({ url: "http://cluster", transport });
    const selling = { signer: w.owner, inputMint: w.inputMint, outputMint: w.outputMint };
    token = (await client.createIntent({ ...selling, params: proof(1_000_000n, 10_000n), nonce: 1n, expiresAt: NOW + 3_602n })).intent;
    sol = (await client.createIntent({ signer: w.owner, inputMint: NATIVE_MINT, outputMint: w.outputMint, params: proof(50_000_000n, 0n), nonce: 2n, expiresAt: NOW + 3_601n })).intent;
    stuck = (await client.createIntent({ ...selling, params: proof(1_000n, 0n), nonce: 3n, expiresAt: NOW + 3_600n })).intent;
    editIntent(token, { partner, partnerBps: 25, partnerCutBps: 2_000 });
    editIntent(stuck, { partner, partnerBps: 10_000 });
  });

  const command = async () => {
    const result = await cli(["jobs"], {});
    expect([result.code, result.err]).toEqual([EXIT_OK, ""]);
    return pays(result.json()["jobs"] as Pay[]);
  };

  const found = async () => {
    const client = await linked();
    const result = await client.callTool({ name: "solive_find_jobs", arguments: {} });
    expect(result.isError, JSON.stringify(result.structuredContent)).not.toBe(true);
    return pays((result.structuredContent as Json)["jobs"] as Pay[]);
  };

  it("pays a token job less judge, protocol and partner fees, a SOL job in SOL, and nothing on a job that cannot settle", async () => {
    const expected = [
      { intent: token, net_pay: "0.98703", payable: true },
      { intent: sol, net_pay: "0.049975", payable: true },
      { intent: stuck, net_pay: "0", payable: false },
    ];
    expect(await command()).toEqual(expected);
    expect(await found()).toEqual(expected);
  });

  it("the command keeps every field it listed before", async () => {
    const result = await cli(["jobs", "--mint", w.inputMint], {});
    const [first] = result.json()["jobs"] as Json[];
    expect(first).toMatchObject({ intent: token, owner: w.owner.address, nonce: "1", sells: "1000000", judgeFee: "10000", inputMint: w.inputMint, net_pay: "0.98703", payable: true });
  });

  it("no job is payable while fills are paused or attested fills are stopped", async () => {
    const none = [token, sol, stuck].map((intent) => ({ intent, net_pay: "0", payable: false }));
    await editConfig({ paused: PAUSE_FILL });
    expect(await command()).toEqual(none);
    expect(await found()).toEqual(none);
    await editConfig({ paused: 0, fillDisabledKinds: kindBit(Kind.AttestedResult) });
    expect(await command()).toEqual(none);
    expect(await found()).toEqual(none);
  });

  it("a fee change after create leaves what each job pays and the fee it shows as the job recorded them", async () => {
    const before = await command();
    const recorded = [token, sol, stuck].map((intent) => {
      const view = h.svm.getAccount(intent);
      if (!view.exists) {
        throw new Error("intent missing");
      }
      return getIntentDecoder().decode(view.data).feeBps;
    });
    await editConfig({ feeBps: 100, kindFeeMask: 1 << Kind.AttestedResult, kindFeeBps: [0, 0, 0, 300], partnerCutBps: 10_000 });
    expect(await command()).toEqual(before);
    expect(await found()).toEqual(before);
    const client = await linked();
    const result = await client.callTool({ name: "solive_find_jobs", arguments: {} });
    const listed = (result.structuredContent as Json)["jobs"] as { intent: Address; fee_bps: number }[];
    const order = [token, sol, stuck];
    expect(listed.map(({ intent, fee_bps }) => [intent, fee_bps])).toEqual(order.map((intent, i) => [intent, recorded[i]]));
    expect((result.structuredContent as Json)["fee_bps"]).toBe(300);
    expect(recorded.every((bps) => bps !== 300)).toBe(true);
  });

  it("reads the config and each mint once per call, not once per job", async () => {
    const [config] = await findConfigPda();
    const watched = [config, w.inputMint, NATIVE_MINT];
    const reads = async (run: () => Promise<unknown>) => {
      const before = watched.map((address) => h.reads.get(address) ?? 0);
      await run();
      return watched.map((address, i) => (h.reads.get(address) ?? 0) - (before[i] ?? 0));
    };
    expect(await reads(command)).toEqual([1, 1, 1]);
    expect(await reads(found)).toEqual([1, 1, 1]);
    expect(await reads(() => cli(["jobs", "--min-pay", "0.0001"], {}))).toEqual([1, 1, 1]);
    expect(await reads(async () => (await linked()).callTool({ name: "solive_find_jobs", arguments: { min_pay: "0.0001" } }))).toEqual([1, 1, 1]);
  });
});
