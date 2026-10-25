import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { type SpecFetch, type Transport } from "@intent-engine/client";
import { DEVNET_GENESIS_HASH, PLAIN_HTTP_ON_PUBLIC, plainHttpOnPublic, PUBLIC_GENESIS_HASHES } from "@intent-engine/client/internal";
import { createTestWorld } from "@intent-engine/client/testing";
import { MAX_ARTIFACT_BYTES } from "../src/artifact.js";
import { fetchSha256, NOT_PUBLIC, tooLarge } from "../src/delivery-fetch.js";
import type { Lookup } from "../src/public-address.js";

const cluster = (genesis: string) => ({ genesisHash: async () => genesis }) as unknown as Transport;
const LOCAL = cluster("local-genesis");
const PUBLIC = cluster(DEVNET_GENESIS_HASH);
const lookup: Lookup = async () => ["127.0.0.1"];

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

const serving =
  (response: () => Response): SpecFetch =>
  async () =>
    response();

const MIB = 1024 * 1024;

const stream = (total: number) => {
  let left = total;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (left === 0) {
        controller.close();
        return;
      }
      const size = Math.min(MIB, left);
      left -= size;
      controller.enqueue(new Uint8Array(size));
    },
  });
};

describe("hashing a spec by its url", () => {
  it("hashes an http or https url and refuses any other scheme", async () => {
    const get = serving(() => new Response("spec"));
    for (const url of ["https://" + "a.example/spec.md", "http://" + "a.example/spec.md"]) {
      expect(await fetchSha256(get, LOCAL, url, lookup), url).toStrictEqual({ sha256: sha("spec") });
    }
    for (const url of ["ftp://" + "a.example/spec.md", "file:///etc/hosts"]) {
      expect(await fetchSha256(get, LOCAL, url, lookup), url).toStrictEqual({ problem: "is not an http or https url" });
    }
  });

  it("refuses a private address only on a public cluster", async () => {
    const get = serving(() => new Response("spec"));
    const url = "https://" + "127.0.0.1/spec.md";
    expect(await fetchSha256(get, LOCAL, url, lookup)).toStrictEqual({ sha256: sha("spec") });
    expect(await fetchSha256(get, PUBLIC, url, lookup)).toStrictEqual({ problem: NOT_PUBLIC });
  });

  it("fetches a loopback url on the test world's offline transport, whose urls the client lets it announce, and nothing else private", async () => {
    const world = await createTestWorld();
    expect(PUBLIC_GENESIS_HASHES.has(await world.transport.genesisHash())).toBe(true);
    const get = serving(() => new Response("work"));
    for (const url of ["http://" + "127.0.0.1:8080/work.txt", "http://" + "localhost:8080/work.txt", "https://" + "[::1]/work.txt"]) {
      expect(await plainHttpOnPublic(world.transport, url), url).toBe(false);
      expect(await fetchSha256(get, world.transport, url, lookup), url).toStrictEqual({ sha256: sha("work") });
    }
    expect(await fetchSha256(get, PUBLIC, "http://" + "127.0.0.1:8080/work.txt", lookup)).toStrictEqual({ problem: PLAIN_HTTP_ON_PUBLIC });
    expect(await fetchSha256(get, PUBLIC, "https://" + "127.0.0.1/work.txt", lookup)).toStrictEqual({ problem: NOT_PUBLIC });
    expect(await fetchSha256(get, world.transport, "https://" + "10.0.0.7/work.txt", lookup)).toStrictEqual({ problem: NOT_PUBLIC });
    expect(await fetchSha256(get, world.transport, "https://" + "a.example/work.txt", async () => ["192.168.1.2"])).toStrictEqual({ problem: NOT_PUBLIC });
  });

  it("takes a body of exactly the size limit, whether announced or streamed, and refuses one byte more", async () => {
    const url = "https://" + "a.example/spec.md";
    const announced = serving(() => new Response("spec", { headers: { "content-length": String(MAX_ARTIFACT_BYTES) } }));
    expect(await fetchSha256(announced, LOCAL, url, lookup)).toStrictEqual({ sha256: sha("spec") });
    const tooLong = serving(() => new Response("spec", { headers: { "content-length": String(MAX_ARTIFACT_BYTES + 1) } }));
    expect(await fetchSha256(tooLong, LOCAL, url, lookup)).toStrictEqual({ problem: tooLarge(MAX_ARTIFACT_BYTES) });
    expect(await fetchSha256(serving(() => new Response(stream(MAX_ARTIFACT_BYTES))), LOCAL, url, lookup)).toStrictEqual({ sha256: sha(new Uint8Array(MAX_ARTIFACT_BYTES)) });
    expect(await fetchSha256(serving(() => new Response(stream(MAX_ARTIFACT_BYTES + 1))), LOCAL, url, lookup)).toStrictEqual({ problem: tooLarge(MAX_ARTIFACT_BYTES) });
  }, 60_000);
});
