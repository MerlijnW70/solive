import { type Address, generateKeyPairSigner, type KeyPairSigner, lamports, none } from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { findIntentPda, Kind, NATIVE_MINT } from "@intent-engine/core";
import { createClient, FUNDING_PAGES, type ListedSignature, type Transport } from "@intent-engine/client";
import { svmTransport } from "@intent-engine/client/svm";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { EXIT_OK } from "../src/main.js";
import { cli, funded, h, world } from "./harness.js";

type Json = Record<string, unknown> & { [key: string]: any };

const SOL = 1_000_000_000n;
const PAY = 1_000_000n;
const SPEC = new Uint8Array(32).fill(7);

function presetNative(): void {
  const space = BigInt(getMintSize());
  h.svm.setAccount({
    address: NATIVE_MINT,
    data: Uint8Array.from(getMintEncoder().encode({ mintAuthority: none(), supply: 0n, decimals: 9, isInitialized: true, freezeAuthority: none() })),
    executable: false,
    lamports: lamports(h.svm.minimumBalanceForRentExemption(space)),
    programAddress: TOKEN_PROGRAM_ADDRESS,
    space,
  });
}

async function served(): Promise<Client> {
  h.served.length = 0;
  const started = await cli(["mcp", "--url", "devnet", "--wallet"], {});
  expect([started.code, started.err]).toEqual([EXIT_OK, WALLET_NOTICE.join("\n")]);
  const server = h.served[0];
  if (server === undefined) {
    throw new Error("no server was started");
  }
  const [near, far] = InMemoryTransport.createLinkedPair();
  await server.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return client;
}

async function both(worker: Address) {
  const command = await cli(["reputation", "--worker", worker], {});
  expect([command.code, command.err]).toEqual([EXIT_OK, ""]);
  const mcp = await served();
  const result = await mcp.callTool({ name: "solive_get_reputation", arguments: { worker } });
  expect(result.isError).not.toBe(true);
  return { command: command.json() as Json, tool: result.structuredContent as Json };
}

const marksOf = (records: readonly Json[], field: string) => Object.fromEntries(records.map((r) => [r["intent"], r[field]]));

describe("reputation funded by the worker, in the command and the tool", () => {
  it("marks the same releases and leaves the same ones out", async () => {
    const w = await world();
    presetNative();
    const transport = svmTransport(h.svm);
    h.through = transport;
    const client = createClient({ url: "http://cluster", transport });
    const [worker, judge, stranger] = await Promise.all([funded(), funded(), funded()]);
    const fundedBy = async (source: KeyPairSigner, amount = 3n * SOL) => {
      const signer = await generateKeyPairSigner();
      await transport.send([getTransferSolInstruction({ source, destination: signer.address, amount })], source);
      return signer;
    };
    const job = async (owner: KeyPairSigner, sha256: string) => {
      const { nonce } = await client.createIntent({
        signer: owner,
        params: { kind: Kind.AttestedResult, amountIn: PAY, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: SPEC, judgeFee: 0n },
        inputMint: NATIVE_MINT,
        outputMint: w.outputMint,
      });
      const [intent] = await findIntentPda({ owner: owner.address, nonce });
      const made = await client.announce({ worker, intent, sha256, url: "https://" + "example.org/work" });
      await client.settleProof({ judge, intent: { owner: owner.address, nonce }, announcement: made.announcement, opening: { sha256, salt: made.salt }, result: 1n });
      return intent;
    };
    const direct = await job(await fundedBy(worker), "a1".repeat(32));
    const through = await job(await fundedBy(await fundedBy(worker, 6n * SOL)), "b2".repeat(32));
    const clean = await job(await fundedBy(stranger), "c3".repeat(32));
    const expected = { [direct]: "yes", [through]: "yes", [clean]: "no" };

    const read = await both(worker.address);
    expect(read.command).toMatchObject({ complete: true, announced: 3, paid: 1, paidVerified: 1, selfDealt: 0, fundedByWorker: 2, payers: 1 });
    expect(read.tool).toMatchObject({ complete: true, announced: 3, paid: 1, paid_verified: 1, self_dealt: 0, funded_by_worker: 2, payers: 1 });
    expect(marksOf(read.command["records"], "fundedByWorker")).toEqual(expected);
    expect(marksOf(read.tool["records"], "funded_by_worker")).toEqual(expected);

    h.through = { ...transport, firstAvailableSlot: async () => 5n } satisfies Transport;
    const pruned = await both(worker.address);
    const unknown = { [direct]: "yes", [through]: "unknown", [clean]: "unknown" };
    expect(pruned.command).toMatchObject({ complete: false, paid: 2, paidVerified: 0, fundedByWorker: 1, fundingUnknown: 2 });
    expect(pruned.tool).toMatchObject({ complete: false, paid: 2, paid_verified: 0, funded_by_worker: 1, funding_unknown: 2 });
    expect(marksOf(pruned.command["records"], "fundedByWorker")).toEqual(unknown);
    expect(marksOf(pruned.tool["records"], "funded_by_worker")).toEqual(unknown);

    const listed: Address[] = [];
    h.through = {
      ...transport,
      signaturesOf: async (of, limit, before) => {
        listed.push(of);
        if (of !== stranger.address) {
          return (transport.signaturesOf as NonNullable<Transport["signaturesOf"]>)(of, limit, before);
        }
        return Array.from({ length: limit }, (_, i): ListedSignature => ({ signature: `busy-${listed.length}-${i}`, slot: 1n, blockTime: null, failed: false, memo: null }));
      },
    } satisfies Transport;
    const busy = await both(worker.address);
    expect(busy.command).toMatchObject({ complete: true, paid: 1, fundedByWorker: 2, payers: 1 });
    expect(busy.tool).toMatchObject({ complete: true, paid: 1, funded_by_worker: 2, payers: 1 });
    expect(marksOf(busy.command["records"], "fundedByWorker")).toEqual(expected);
    expect(marksOf(busy.tool["records"], "funded_by_worker")).toEqual(expected);
    expect(listed.filter((at) => at === stranger.address)).toHaveLength(2 * FUNDING_PAGES);

    h.through = {
      ...transport,
      signaturesOf: async (of, limit, before) => {
        if (of === stranger.address) {
          throw new Error("rpc failed");
        }
        return (transport.signaturesOf as NonNullable<Transport["signaturesOf"]>)(of, limit, before);
      },
    } satisfies Transport;
    const failed = await both(worker.address);
    const unread = { [direct]: "yes", [through]: "yes", [clean]: "unknown" };
    expect(failed.command).toMatchObject({ complete: false, paid: 1, paidVerified: 0, fundedByWorker: 2, fundingUnknown: 1 });
    expect(failed.tool).toMatchObject({ complete: false, paid: 1, paid_verified: 0, funded_by_worker: 2, funding_unknown: 1 });
    expect(marksOf(failed.command["records"], "fundedByWorker")).toEqual(unread);
    expect(marksOf(failed.tool["records"], "funded_by_worker")).toEqual(unread);
  });
});
