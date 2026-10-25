import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { address } from "@solana/kit";
import { afterEach, describe, expect, it } from "vitest";
import { attestedResult, DEVNET_TEST_MINT, NATIVE_MINT, parseAmount } from "@intent-engine/core";
import { createClient, type SpecFetch, SpecUnreadable, type Transport } from "../src/index.js";
import { NOT_PUBLIC_SPEC } from "../src/job-specs.js";
import { DEVNET_GENESIS_HASH, PLAIN_HTTP_ON_PUBLIC, type RpcLike, rpcTransport } from "../src/internal.js";
import { svmTransport } from "../src/svm.js";
import { createTestWorld, testWallet, type TestWorld } from "../src/testing.js";
import { TESTING_SECTION } from "./doc-sections.js";
import { serve, type Served } from "./local-server.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const SECTION = TESTING_SECTION.exec(readFileSync(`${ROOT}/docs/sdk-client.md`, "utf8"))?.[0] ?? "";
const OFFLINE =
  "The world's transport is `offline`, so its clients create, announce and fetch plain-http loopback urls, such as a local server's; a client on a real cluster still refuses them.";
const SPEC = "the spec on a local server\n";
const WORK = createHash("sha256").update("the work").digest("hex");
const LOOPBACK_RPC = "http://" + "127.0.0.1:8899";
const REMOTE_RPC = "https://" + "rpc.example";

const specHash = Uint8Array.from(createHash("sha256").update(SPEC).digest());

async function escrowOn(world: TestWorld, specUrl?: string) {
  const [owner, judge] = [await world.wallet(), await world.wallet()];
  const params = attestedResult({ amountIn: parseAmount("0.1", 9), minResult: 1n, maxResult: 1n, attestor: judge.address, specHash, judgeFee: 0n });
  const order = { signer: owner, inputMint: NATIVE_MINT, outputMint: DEVNET_TEST_MINT, params };
  return { owner, judge, order, made: await world.client.createIntent(specUrl === undefined ? order : { ...order, specUrl }) };
}

describe("plain-http loopback urls", () => {
  let served: Served | undefined;

  afterEach(async () => {
    await served?.close();
    served = undefined;
  });

  it(OFFLINE, async () => {
    expect(SECTION).toContain(`- ${OFFLINE}`);
    const world = await createTestWorld();
    expect(world.transport.offline).toBe(true);
    expect(await world.transport.genesisHash()).toBe(DEVNET_GENESIS_HASH);
    served = await serve({ "/spec.md": SPEC });
    const { made } = await escrowOn(world, served.host + "/spec.md");
    expect(await world.client.spec(made.intent)).toMatchObject({ url: served.host + "/spec.md", text: SPEC, matches: true });
    expect((await world.client.jobs())[0]).toMatchObject({ intent: made.intent, specUrl: served.host + "/spec.md" });
    const worker = await world.wallet();
    const work = served.host + "/work.tar";
    await world.client.announce({ worker, intent: made.intent, sha256: WORK, url: work });
    expect((await world.client.announcements(made.intent)).announcements).toHaveLength(1);
    expect(served.asked).toEqual(["/spec.md"]);

    const remote = "http://" + "example.org/spec.md";
    const { order } = await escrowOn(world);
    await expect(world.client.createIntent({ ...order, specUrl: remote })).rejects.toMatchObject({ field: "url", rule: "format" });
    const remoteWork = "http://" + "example.org/work.tar";
    await expect(world.client.announce({ worker, intent: made.intent, sha256: WORK, url: remoteWork })).rejects.toMatchObject({ field: "url", rule: "format" });
    expect((await world.client.announcements(made.intent)).announcements).toHaveLength(1);
  });

  it("a client on a real cluster refuses a plain-http loopback spec url and work url, even with a loopback RPC url, and never fetches a loopback spec", async () => {
    const rpc = { getGenesisHash: () => ({ send: async () => DEVNET_GENESIS_HASH }) } as unknown as RpcLike;
    const transport = rpcTransport(rpc, async () => undefined);
    expect(transport.offline).toBeUndefined();
    const devnet = createClient({ url: LOOPBACK_RPC, transport });
    const [owner, judge, worker] = [await testWallet(), await testWallet(), await testWallet()];
    const params = attestedResult({ amountIn: 1n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash, judgeFee: 0n });
    const spec = "http://" + "127.0.0.1:8080/spec.md";
    await expect(devnet.createIntent({ signer: owner, inputMint: NATIVE_MINT, outputMint: DEVNET_TEST_MINT, params, specUrl: spec })).rejects.toThrow(`the spec url ${spec} ${PLAIN_HTTP_ON_PUBLIC}`);
    const work = "http://" + "localhost:8080/work.tar";
    await expect(devnet.announce({ worker, intent: address("11111111111111111111111111111111"), sha256: WORK, url: work })).rejects.toThrow(`the work url ${work} ${PLAIN_HTTP_ON_PUBLIC}`);

    const world = await createTestWorld();
    served = await serve({ "/spec.md": SPEC });
    const plain = (await escrowOn(world, served.host + "/spec.md")).made.intent;
    const loopback = "https://" + "127.0.0.1:8443/spec.md";
    const inside = "https://" + "10.0.0.7/spec.md";
    const [secured, internal] = [(await escrowOn(world, loopback)).made.intent, (await escrowOn(world, inside)).made.intent];
    const { offline: _, ...cluster } = world.transport;
    expect(svmTransport(world.svm, { genesisHash: DEVNET_GENESIS_HASH }).offline).toBeUndefined();
    const fetched: string[] = [];
    const recorded: SpecFetch = async (url) => {
      fetched.push(url);
      return new Response(SPEC);
    };
    const on = (url: string, transport: Transport) => createClient({ url, transport, fetch: recorded });
    await expect(on(LOOPBACK_RPC, cluster).spec(plain)).rejects.toThrow(new SpecUnreadable(served.host + "/spec.md", PLAIN_HTTP_ON_PUBLIC));
    await expect(on(REMOTE_RPC, cluster).spec(secured)).rejects.toThrow(new SpecUnreadable(loopback, NOT_PUBLIC_SPEC));
    await expect(on(REMOTE_RPC, cluster).spec(internal)).rejects.toThrow(new SpecUnreadable(inside, NOT_PUBLIC_SPEC));
    await expect(on(LOOPBACK_RPC, cluster).spec(internal)).rejects.toThrow(new SpecUnreadable(inside, NOT_PUBLIC_SPEC));
    expect(fetched).toEqual([]);
    expect(served.asked).toEqual([]);
    expect(await on(LOOPBACK_RPC, cluster).spec(secured)).toMatchObject({ url: loopback, matches: true });
    expect(await on(REMOTE_RPC, world.transport).spec(secured)).toMatchObject({ url: loopback, matches: true });
    await expect(on(REMOTE_RPC, world.transport).spec(internal)).rejects.toThrow(new SpecUnreadable(inside, NOT_PUBLIC_SPEC));
    expect(fetched).toEqual([loopback, loopback]);
  });
});
