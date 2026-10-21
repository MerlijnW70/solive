import type { Instruction, KeyPairSigner } from "@solana/kit";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { MEMO_PROGRAM_ADDRESS, type OpenTransport, type Transport } from "@intent-engine/client";
import { claimsOf } from "../src/agent/claims.js";
import { servedActions } from "../src/agent/everyday.js";
import { agentServer } from "../src/agent/mcp.js";
import { transactionSize } from "../src/agent/prepare.js";
import { walletGuard } from "../src/agent/wallet.js";
import { parse } from "../src/args.js";
import { runtime, transport } from "./harness.js";

const filler = (length: number): Instruction => ({ programAddress: MEMO_PROGRAM_ADDRESS, data: new Uint8Array(length).fill(120) });

export type Padding = { size: number | null };

export function paddedTransport(padding: Padding, when: (instructions: readonly Instruction[]) => boolean): Transport {
  return {
    ...transport,
    budget: async (instructions, feePayer, tables) => {
      const base = await transport.budget(instructions, feePayer, tables);
      const goal = padding.size;
      if (goal === null || !when(instructions)) {
        return base;
      }
      for (const extra of [0, 1]) {
        let length = 0;
        for (let tries = 0; tries < 6 && length >= 0; tries++) {
          const padded = [...base, ...Array.from({ length: extra }, () => filler(0)), filler(length)];
          const size = await transactionSize(transport, padded, feePayer, tables);
          if (size === goal) {
            return padded;
          }
          length += goal - size;
        }
      }
      throw new Error(`cannot pad the transaction to ${goal} bytes`);
    },
  };
}

export async function walletServer(over: Transport, ledger?: OpenTransport, payer?: KeyPairSigner): Promise<Client> {
  const command = parse(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
  if (command.name !== "mcp" || command.wallet === null) {
    throw new Error("not a wallet server");
  }
  const files = { ...runtime(payer === undefined ? {} : { "payer.json": payer }), ...(ledger === undefined ? {} : { ledger }) };
  const wallet = {
    url: command.url,
    files,
    env: files.env,
    sleep: files.sleep,
    now: files.now,
    limits: walletGuard(command.wallet, files.saleBook),
    ...(payer === undefined ? {} : { feePayer: "payer.json" }),
  };
  const server = agentServer(
    { transport: over, relay: undefined, agent: undefined, claims: claimsOf(), url: command.url, fetch: files.specFetch, clock: { sleep: files.sleep, now: files.now }, wallet },
    servedActions({ wallet: true, allTools: true, relay: false, agent: false }),
  );
  const [near, far] = InMemoryTransport.createLinkedPair();
  await server.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return client;
}
