import { type Address, type KeyPairSigner, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { findIntentPda, Kind, NATIVE_MINT } from "@intent-engine/core";
import { createClient } from "@intent-engine/client";
import { svmTransport } from "@intent-engine/client/svm";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { EXIT_OK, EXIT_USAGE } from "../src/main.js";
import { cli, funded, h, world } from "./harness.js";

type Json = Record<string, unknown> & { [key: string]: any };

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

async function both(args: string[], input: Json) {
  const command = await cli(["reputation", ...args], {});
  expect([command.code, command.err]).toEqual([EXIT_OK, ""]);
  const mcp = await served();
  const result = await mcp.callTool({ name: "solive_get_reputation", arguments: input });
  expect(result.isError).not.toBe(true);
  return { command: command.json() as Json, tool: result.structuredContent as Json };
}

async function market() {
  const w = await world();
  presetNative();
  const transport = svmTransport(h.svm);
  h.through = transport;
  const client = createClient({ url: "http://cluster", transport });
  const judge = await funded();
  let jobs = 0;
  const pays = async (owner: KeyPairSigner, worker: KeyPairSigner) => {
    const { nonce } = await client.createIntent({
      signer: owner,
      params: { kind: Kind.AttestedResult, amountIn: PAY, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: SPEC, judgeFee: 0n },
      inputMint: NATIVE_MINT,
      outputMint: w.outputMint,
    });
    const [intent] = await findIntentPda({ owner: owner.address, nonce });
    const sha256 = (jobs++).toString(16).padStart(64, "0");
    const made = await client.announce({ worker, intent, sha256, url: "https://" + "example.org/work" });
    await client.settleProof({ judge, owner: owner.address, nonce, announcement: made.announcement, opening: { sha256, salt: made.salt }, result: 1n });
  };
  return { pays };
}

const trustOnly = (view: Json) => view["trust"] as Json;

describe("reader-rooted trust, in the command and the tool", () => {
  it("shows the same trust in both, beside the same record", async () => {
    const { pays } = await market();
    const [reader, middle, worker, seed] = await Promise.all([funded(), funded(), funded(), funded()]);
    await pays(reader, middle);
    await pays(middle, worker);
    await pays(seed, worker);
    const read = await both(
      ["--worker", worker.address, "--reader", reader.address, "--seed", seed.address],
      { worker: worker.address, reader: reader.address, seeds: [seed.address] },
    );
    expect(read.command).toMatchObject({ paid: 2 });
    expect(read.tool).toMatchObject({ paid: 2 });
    expect(trustOnly(read.command)).toEqual(trustOnly(read.tool));
    expect(trustOnly(read.tool)).toMatchObject({ reader: reader.address, seeds: [reader.address, seed.address], complete: true });
    expect(Number(trustOnly(read.tool)["score"])).toBeGreaterThan(0);
    expect((trustOnly(read.tool)["paths"] as { wallets: Address[] }[]).map(({ wallets }) => wallets)).toEqual([
      [seed.address, worker.address],
      [reader.address, middle.address, worker.address],
    ]);
  });

  it("gives the same zero and reason in both for a reader that paid no one", async () => {
    const { pays } = await market();
    const [reader, payer, worker] = await Promise.all([funded(), funded(), funded()]);
    await pays(payer, worker);
    const read = await both(["--worker", worker.address, "--reader", reader.address], { worker: worker.address, reader: reader.address });
    expect(trustOnly(read.command)).toEqual(trustOnly(read.tool));
    expect(trustOnly(read.tool)).toMatchObject({
      score: "0",
      paths: [],
      reason: `${reader.address} paid no counted release and no other seed was named, so no trust flows from it`,
    });
  });

  it("leaves both unchanged without a reader", async () => {
    const { pays } = await market();
    const [payer, worker] = await Promise.all([funded(), funded()]);
    await pays(payer, worker);
    const read = await both(["--worker", worker.address], { worker: worker.address });
    expect(read.command).not.toHaveProperty("trust");
    expect(read.tool).not.toHaveProperty("trust");
  });

  it("refuses seeds without a reader in both", async () => {
    await world();
    const [seed, worker] = await Promise.all([funded(), funded()]);
    const command = await cli(["reputation", "--worker", worker.address, "--seed", seed.address], {});
    expect(command.code).toBe(EXIT_USAGE);
    expect(command.err).toContain("--seed needs --reader");
    const mcp = await served();
    const result = await mcp.callTool({ name: "solive_get_reputation", arguments: { worker: worker.address, seeds: [seed.address] } });
    expect(result.isError).toBe(true);
  });
});
