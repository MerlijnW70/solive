import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { LEDGER_ERRORS, type OpenTransport } from "@intent-engine/client/internal";
import { beforeEach, describe, expect, it } from "vitest";
import { ENV_KEYPAIR } from "../../src/clusters.js";
import { needsKeyFile } from "../../src/ledger-keys.js";
import { EXIT_OK, EXIT_USAGE, main } from "../../src/main.js";
import { h, runtime, world } from "../harness.js";

const LEDGER = "usb://ledger";

async function start(argv: string[], ledger: OpenTransport) {
  const err: string[] = [];
  const code = await main(argv, { ...runtime({}), ledger }, { out: () => undefined, err: (t) => err.push(t) });
  return { code, err: err.join("\n") };
}

describe("a Ledger path as the default key of a command outside the transaction-only list", () => {
  let opened: number;
  let mint: string;
  const ledger: OpenTransport = async () => {
    opened += 1;
    throw new Error("no device");
  };

  beforeEach(async () => {
    mint = (await world()).inputMint;
    opened = 0;
  });

  it("the relayer key of mcp is refused as a Ledger before the chain is read", async () => {
    h.served.length = 0;
    const reads = h.genesisReads + h.requestedLimits.length;
    const started = await start(["mcp", "--url", "devnet", "--relayer", LEDGER, "--relay-fee", `${mint}=1`], ledger);
    expect([started.code, started.err]).toEqual([EXIT_USAGE, needsKeyFile("mcp", LEDGER)]);
    expect([h.served.length, h.genesisReads + h.requestedLimits.length - reads, opened]).toEqual([0, 0, 0]);
  });

  it("W-4: mcp --wallet takes usb://ledger from INTENT_ENGINE_KEYPAIR as its wallet and never makes a key file under that name", async () => {
    h.env[ENV_KEYPAIR] = LEDGER;
    h.served.length = 0;
    const started = await start(["mcp", "--url", "devnet", "--wallet", "--all-tools"], ledger);
    let wallet: unknown = null;
    const server = h.served[0];
    if (server !== undefined) {
      const [near, far] = InMemoryTransport.createLinkedPair();
      await server.connect(near);
      const client = new Client({ name: "test", version: "0.0.0" });
      await client.connect(far);
      wallet = (await client.callTool({ name: "solive_wallet_setup", arguments: {} })).structuredContent ?? null;
    }
    expect({
      code: started.code,
      served: h.served.length,
      opened,
      keyFileNamedLikeTheLedger: h.files.has(LEDGER),
      airdrops: h.airdrops.length,
      wallet,
    }).toEqual({
      code: EXIT_OK,
      served: 1,
      opened: 1,
      keyFileNamedLikeTheLedger: false,
      airdrops: 0,
      wallet: { code: "Ledger", retryable: false, hint: LEDGER_ERRORS.notFound },
    });
  });
});
