import { generateKeyPairSigner } from "@solana/kit";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { profileAddress } from "@intent-engine/core/internal";
import { svmTransport } from "@intent-engine/client/svm";
import { tool } from "../src/agent/names.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { EXIT_OK } from "../src/main.js";
import { PUBLISH_PROFILE } from "../src/agent/jobs.js";
import { cli, h, transport, world } from "./harness.js";

async function served(): Promise<Client> {
  h.served.length = 0;
  const started = await cli(["mcp", "--url", "devnet", "--wallet"], {});
  expect([started.code, started.err]).toEqual([EXIT_OK, WALLET_NOTICE.join("\n")]);
  const [near, far] = InMemoryTransport.createLinkedPair();
  await h.served[0]?.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return client;
}

describe("get_reputation on a wallet nobody paid", () => {
  it("says why the history is not complete and lists no unreadable accounts", async () => {
    await world();
    h.through = { ...svmTransport(h.svm), firstAvailableSlot: async () => 5n };
    const worker = (await generateKeyPairSigner()).address;
    const client = await served();
    const result = await client.callTool({ name: tool("get_reputation"), arguments: { worker } });
    expect(result.isError).not.toBe(true);
    const view = result.structuredContent as Record<string, unknown>;
    expect(view).toMatchObject({ worker, complete: false, reason: `the history of ${worker} was not read to its start` });
    expect(Object.keys(view)).not.toContain("unreadable");
  });
});

describe("find_jobs when the profile cannot be read", () => {
  it("leaves out the hint to publish a profile", async () => {
    await world();
    h.files.clear();
    let down: string | undefined;
    h.through = {
      ...transport,
      getAccount: async (address) => {
        if (address === down) {
          throw new Error("the node is down");
        }
        return transport.getAccount(address);
      },
    };
    const client = await served();
    const wallet = ((await client.callTool({ name: tool("wallet_setup"), arguments: {} })).structuredContent as Record<string, string>)["address"] as string;
    const find = async () => ((await client.callTool({ name: tool("find_jobs"), arguments: {} })).structuredContent as Record<string, string>)["next"];
    expect(await find()).toContain(PUBLISH_PROFILE);
    down = await profileAddress(wallet as never);
    expect(await find()).not.toContain(PUBLISH_PROFILE);
  });
});
