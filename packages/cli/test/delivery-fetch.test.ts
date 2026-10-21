import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { DEVNET_GENESIS_HASH, type SpecFetch, type Transport } from "@intent-engine/client";
import { MAX_ARTIFACT_BYTES } from "../src/artifact.js";
import { fetchSha256, NOT_PUBLIC } from "../src/delivery-fetch.js";
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

  it("takes a body of exactly the size limit, whether announced or streamed, and refuses one byte more", async () => {
    const url = "https://" + "a.example/spec.md";
    const announced = serving(() => new Response("spec", { headers: { "content-length": String(MAX_ARTIFACT_BYTES) } }));
    expect(await fetchSha256(announced, LOCAL, url, lookup)).toStrictEqual({ sha256: sha("spec") });
    const tooLong = serving(() => new Response("spec", { headers: { "content-length": String(MAX_ARTIFACT_BYTES + 1) } }));
    expect(await fetchSha256(tooLong, LOCAL, url, lookup)).toStrictEqual({ problem: "could not be read within the size limit" });
    expect(await fetchSha256(serving(() => new Response(stream(MAX_ARTIFACT_BYTES))), LOCAL, url, lookup)).toStrictEqual({ sha256: sha(new Uint8Array(MAX_ARTIFACT_BYTES)) });
    expect(await fetchSha256(serving(() => new Response(stream(MAX_ARTIFACT_BYTES + 1))), LOCAL, url, lookup)).toStrictEqual({ problem: "could not be read within the size limit" });
  }, 60_000);
});
