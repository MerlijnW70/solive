import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import { type AddressInfo, createServer as createSocketServer, type Server as SocketServer } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { Kind, specMemo } from "@intent-engine/core";
import { createClient, DEVNET_GENESIS_HASH, FetchFailed, MAX_SPEC_BYTES, pinnedFetch, readSpec, type SpecFetch, type Transport, UNEXPECTED_REDIRECT } from "@intent-engine/client";
import { type Announced, fetchBytes, fetchDelivery, NOT_PUBLIC } from "../src/delivery-fetch.js";
import { type Lookup, privateAddress, publicAddresses } from "../src/public-address.js";
import { creation, h, NOW, ownerSigned, transport, world } from "./harness.js";

const PUBLIC = { genesisHash: async () => DEVNET_GENESIS_HASH } as unknown as Transport;
const CHECKED = "93.184.215.14";
const STAND_IN = "127.0.0.2";
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const servers: (Server | SocketServer)[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
});

async function listening<T extends Server | SocketServer>(server: T, host: string, port = 0): Promise<T> {
  servers.push(server);
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(port, host, done);
  });
  return server;
}

function counter(): { server: SocketServer; count: () => number } {
  let connections = 0;
  const server = createSocketServer((peer) => {
    connections++;
    peer.destroy();
  });
  return { server, count: () => connections };
}

const portOf = (server: Server | SocketServer): number => (server.address() as AddressInfo).port;

describe("a fetch connects only to the addresses the check passed", () => {
  it("never reaches a loopback server when the name resolves to loopback after the check", async () => {
    const loopback = counter();
    const port = portOf(await listening(loopback.server, "127.0.0.1"));
    const loopbackSix = counter();
    await listening(loopbackSix.server, "::1", port);
    const publicHost = counter();
    await listening(publicHost.server, STAND_IN, port);
    const answers: string[][] = [];
    const lookup: Lookup = async () => {
      const answer = answers.length === 0 ? [CHECKED] : ["127.0.0.1"];
      answers.push(answer);
      return answer;
    };
    const reached: SpecFetch = (url, init) => pinnedFetch(url, { ...init, ...(init.addresses === undefined ? {} : { addresses: init.addresses.map((at) => (at === CHECKED ? STAND_IN : at)) }) });
    const found = await fetchBytes(reached, PUBLIC, "https://" + `localhost:${port}/work`, lookup, MAX_SPEC_BYTES);
    expect(found).toMatchObject({ problem: expect.stringMatching(/^could not be fetched \(/) });
    expect({ answers, loopback: loopback.count() + loopbackSix.count(), checked: publicHost.count() }).toStrictEqual({ answers: [[CHECKED]], loopback: 0, checked: 1 });
  }, 30_000);

  it("refuses before connecting when the one lookup answers a private address", async () => {
    const asked: string[] = [];
    const get: SpecFetch = async (url) => {
      asked.push(url);
      return new Response("x");
    };
    expect(await fetchBytes(get, PUBLIC, "https://" + "spec.example/a", async () => [CHECKED, "10.0.0.1"], MAX_SPEC_BYTES)).toStrictEqual({ problem: NOT_PUBLIC });
    expect(asked).toEqual([]);
  });

  it("hands the checked addresses to the fetch of a delivery and of a spec", async () => {
    const seen: (readonly string[] | undefined)[] = [];
    const get: SpecFetch = async (_url, init) => {
      seen.push(init.addresses);
      return new Response("spec\n");
    };
    let lookups = 0;
    const lookup: Lookup = async () => {
      lookups++;
      return [CHECKED];
    };
    const delivery = { url: "https://" + "work.example/w", salt: "", announcement: { worker: "w", commitment: new Uint8Array(32) } } as unknown as Announced;
    await fetchDelivery(get, PUBLIC, delivery, 5, lookup).catch(() => undefined);
    const w = await world();
    const specUrl = "https://" + "spec.example/jobs/pinned.md";
    const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: w.authority.address, specHash: Uint8Array.from(Buffer.from(sha("spec\n"), "hex")), judgeFee: 0n } as const;
    const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
    h.engineLog = [{ ...creation(intent), ...ownerSigned(intent, [specMemo(specUrl)]) }];
    h.genesis = DEVNET_GENESIS_HASH;
    expect(await readSpec(transport, get, intent, undefined, lookup)).toMatchObject({ matches: true, text: "spec\n" });
    expect({ seen, lookups }).toStrictEqual({ seen: [[CHECKED], [CHECKED]], lookups: 2 });
  }, 60_000);

  it("connects to the checked address without resolving the name, and refuses a redirect", async () => {
    const server = await listening(
      createServer((request, response) => {
        if (request.url === "/moved") {
          response.writeHead(302, { location: "/spec" }).end();
          return;
        }
        const body = gzipSync("pinned spec\n");
        response.writeHead(200, { "content-encoding": "gzip", "content-length": String(body.length) }).end(body);
      }),
      "127.0.0.1",
    );
    const base = "http://" + `spec.invalid:${portOf(server)}`;
    const init = { redirect: "error" as const, signal: AbortSignal.timeout(5_000), addresses: ["127.0.0.1"] };
    expect(await (await pinnedFetch(`${base}/spec`, init)).text()).toBe("pinned spec\n");
    const moved = await pinnedFetch(`${base}/moved`, init).catch((error: unknown) => error);
    expect(moved).toBeInstanceOf(FetchFailed);
    expect(moved).toMatchObject({ code: "fetch-failed", url: `${base}/moved`, reason: "redirect", detail: UNEXPECTED_REDIRECT, message: "fetch failed" });
  }, 30_000);
});

describe("the private-address check", () => {
  it.each(["::7f00:1", "::808:808", "::ffff:0:7f00:1", "::ffff:0:808:808", "fec0::1", "feff::1", "2002:7f00:1::1", "2002:a00:1::", "2002:c0a8:101::1", "2001:0:4136:e378:8000:63bf:80ff:fffe", "2001:0:a00:1::1"])(
    "refuses %s",
    (ip) => {
      expect(privateAddress(ip)).toBe(true);
    },
  );

  it.each(["2002:5db8:d70e::1", "2001:0:4136:e378:8000:63bf:a247:28f1", "2606:4700::1111", "93.184.215.14"])("takes the public address %s", (ip) => {
    expect(privateAddress(ip)).toBe(false);
  });

  it("returns the one answer it checked, and nothing when any address is private", async () => {
    expect(await publicAddresses("spec.example", async () => [CHECKED])).toEqual([CHECKED]);
    expect(await publicAddresses("[2002:7f00:1::1]", async () => [CHECKED])).toBeNull();
    expect(await publicAddresses("spec.example", async () => [CHECKED, "::ffff:0:7f00:1"])).toBeNull();
  });
});
