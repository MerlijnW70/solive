import { type Address, type KeyPairSigner, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { formatAmount, Kind, NATIVE_MINT } from "@intent-engine/core";
import { buildUpdateEconomics, findIntentPda, splitFee } from "@intent-engine/core/internal";
import { createClient } from "@intent-engine/client/node";
import { svmTransport } from "@intent-engine/client/svm";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { EXIT_OK } from "../src/main.js";
import { cli, FEE_BPS, funded, h, world } from "./harness.js";

type Json = Record<string, unknown> & { [key: string]: any };

const PAY = 1_000_000n;
const CREATE_FEE = 9_000;
const SPEC = new Uint8Array(32).fill(9);

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

describe("fee-backed reputation, in the command and the tool", () => {
  it("shows the same backed fees in both", async () => {
    const w = await world();
    presetNative();
    const transport = svmTransport(h.svm);
    h.through = transport;
    const client = createClient({ url: "http://cluster", transport });
    const settings = await client.config();
    const [a = 0, b = 0, c = 0, d = 0] = settings.kindFeeBps;
    await client.send(
      [
        await buildUpdateEconomics({
          admin: w.authority,
          economics: { kindFeeMask: settings.kindFeeMask, kindFeeBps: [a, b, c, d], partnerCutBps: settings.partnerCutBps, crankBounty: settings.crankBounty, createFee: CREATE_FEE },
        }),
      ],
      w.authority,
    );
    const [worker, judge, payer] = await Promise.all([funded(), funded(), funded()]);
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
    };
    await job(payer, "a1".repeat(32));
    await job(worker, "b2".repeat(32));

    const { fee } = splitFee(PAY, FEE_BPS);
    const backed = [{ mint: NATIVE_MINT, amount: fee.toString() }];
    const backedSol = formatAmount(fee + BigInt(CREATE_FEE), 9);
    const read = await both(worker.address);
    expect(read.command).toMatchObject({ complete: true, paid: 1, selfDealt: 1, backed, backedSol });
    expect(read.tool).toMatchObject({ complete: true, paid: 1, self_dealt: 1, backed, backed_sol: backedSol });
  });
});
