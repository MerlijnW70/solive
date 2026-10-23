import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type Address, generateKeyPairSigner, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, NATIVE_MINT, seal, sortMembers } from "@intent-engine/core";
import { DEVNET_GENESIS_HASH, MAX_SPEC_BYTES, type SpecFetch } from "@intent-engine/client";
import { tool } from "../src/agent/names.js";
import { untrusted } from "../src/agent/problems.js";
import { WORK_OPENS } from "../src/agent/wallet/work.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { NOT_PUBLIC, tooLarge } from "../src/delivery-fetch.js";
import { EXIT_OK } from "../src/main.js";
import { sealedDelivery } from "./announce.js";
import { cli, creation, funded, h, world } from "./harness.js";

type Json = Record<string, unknown>;

const WORK = "export default 42;\n";
const PUBLIC_HOST = "93.184.215.14";
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");

function preset(at: Address): void {
  const space = BigInt(getMintSize());
  h.svm.setAccount({
    address: at,
    data: Uint8Array.from(getMintEncoder().encode({ mintAuthority: none(), supply: 0n, decimals: 9, isInitialized: true, freezeAuthority: none() })),
    executable: false,
    lamports: lamports(h.svm.minimumBalanceForRentExemption(space)),
    programAddress: TOKEN_PROGRAM_ADDRESS,
    space,
  });
}

async function connect(): Promise<Client> {
  h.served.length = 0;
  const started = await cli(["mcp", "--url", "devnet", "--wallet"], {});
  expect([started.code, started.err]).toEqual([EXIT_OK, WALLET_NOTICE.join("\n")]);
  const [near, far] = InMemoryTransport.createLinkedPair();
  await h.served[0]?.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return client;
}

async function call(client: Client, name: string, args: object = {}) {
  const result = await client.callTool({ name: tool(name), arguments: args as Record<string, unknown> });
  return { error: result.isError === true, value: result.structuredContent as Json };
}

async function ok(client: Client, name: string, args: object = {}): Promise<Json> {
  const { error, value } = await call(client, name, args);
  expect(error, JSON.stringify(value)).toBe(false);
  return value;
}

const refused = (code: string, url: string, problem: string) => ({ error: true, value: { code, retryable: false, hint: untrusted(`the work at ${url} ${problem}`) } });

describe("fetching announced work with the wallet", () => {
  let client: Client;
  let judge: Address;
  let server: Server | undefined;

  beforeEach(async () => {
    await world();
    h.files.clear();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    client = await connect();
    judge = (await ok(client, "wallet_setup"))["address"] as Address;
  });

  afterEach(() => {
    server?.close();
    server = undefined;
  });

  const escrowTo = async (attestor: Address) => {
    const escrow = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor, spec_hash: "6d".repeat(32), send: true });
    return escrow["intent"] as Address;
  };

  const announced = async (intent: Address, urls: string[], sealedTo: Address[]) => {
    const worker = (await generateKeyPairSigner()).address;
    h.engineLog = [
      ...(await Promise.all(
        urls.map(async (url, at) => ({ signature: `announced-${at}`, slot: BigInt(5 + at), blockTime: null, failed: false, emitted: [], memos: [await sealedDelivery(intent, worker, sha(WORK), url, sealedTo)], feePayer: worker })),
      )),
      creation(intent),
    ];
    return worker;
  };

  it("refuses a redirect, a private address and a body over the cap, as get_spec does", async () => {
    const intent = await escrowTo(judge);
    const requests: string[] = [];
    server = createServer((request, response) => {
      requests.push(request.url ?? "");
      response.writeHead(302, { location: "/elsewhere" }).end();
    });
    await new Promise<void>((done) => server?.listen(0, "127.0.0.1", done));
    const local = "http://" + `127.0.0.1:${(server.address() as AddressInfo).port}/moved`;
    const inits: Parameters<SpecFetch>[1][] = [];
    const urls = {
      moved: "https://" + `${PUBLIC_HOST}/moved`,
      inside: "https://" + "10.0.0.8/work.sealed",
      big: "https://" + `${PUBLIC_HOST}/big.sealed`,
      full: "https://" + `${PUBLIC_HOST}/full`,
    };
    h.specReplies.set(urls.moved, (_url, init) => {
      inits.push(init);
      return fetch(local, init);
    });
    h.specReplies.set(urls.inside, async () => {
      throw new Error("a private address was fetched");
    });
    h.specPages.set(urls.big, new Uint8Array(MAX_SPEC_BYTES + 1));
    h.specPages.set(urls.full, new Uint8Array(MAX_SPEC_BYTES).fill(0x61));
    const worker = await announced(intent, Object.values(urls), [judge]);
    h.genesis = DEVNET_GENESIS_HASH;
    const fetchAt = (at: number) => call(client, "wallet_fetch_work", { intent, announcement: `announced-${at}` });

    expect(await fetchAt(0)).toEqual(refused("WorkUnfetchable", urls.moved, "could not be fetched (fetch failed: unexpected redirect)"));
    expect(inits.map((init) => init.redirect)).toEqual(["error"]);
    expect(requests).toEqual(["/moved"]);
    expect(await fetchAt(1)).toEqual(refused("WorkUnfetchable", urls.inside, NOT_PUBLIC));
    expect(await fetchAt(2)).toEqual(refused("WorkUnfetchable", urls.big, tooLarge(MAX_SPEC_BYTES)));
    const full = await fetchAt(3);
    expect(full.value).toMatchObject({ worker, sealed: false, bytes: MAX_SPEC_BYTES, opens_commitment: false });
    expect(full.value["untrusted_text"]).toHaveLength(MAX_SPEC_BYTES);
  }, 60_000);

  it("retries a fetch that failed this time", async () => {
    const intent = await escrowTo(judge);
    const down = "https://" + "files.example.com/down.sealed";
    await announced(intent, [down], [judge]);
    expect(await call(client, "wallet_fetch_work", { intent, announcement: "announced-0" })).toEqual({
      error: true,
      value: { code: "WorkUnreadable", retryable: true, hint: untrusted(`the work at ${down} could not be fetched (fetch failed)`) },
    });
    expect((await call(client, "wallet_fetch_work", { intent, announcement: "elsewhere" })).value).toMatchObject({ code: "NotAnnounced" });
  });

  it("seals work to each member of a committee that judges, and a member opens it", async () => {
    const payer = await funded();
    const members = sortMembers([judge, (await generateKeyPairSigner()).address]);
    const created = await cli(
      ["committee", "create", "--url", "devnet", "--keypair", "payer.json", "--members", members.join(","), "--threshold", "2", "--fee-wallet", payer.address, "--yes"],
      { "payer.json": payer },
    );
    expect([created.code, created.err]).toEqual([EXIT_OK, ""]);
    const intent = await escrowTo(created.json()["committee"] as Address);
    const sealed = await ok(client, "wallet_seal_work", { intent, text: WORK });
    expect(sealed).toMatchObject({ sha256: sha(WORK), sealed_to: members });
    const url = "https://" + "files.example.com/work/5b0e1f.sealed";
    h.specPages.set(url, new TextEncoder().encode(sealed["sealed"] as string));
    const worker = await announced(intent, [url], members);
    expect(await ok(client, "wallet_fetch_work", { intent, announcement: "announced-0" })).toMatchObject({
      worker,
      sealed: true,
      sha256: sha(WORK),
      opens_commitment: true,
      untrusted_text: WORK,
      next: WORK_OPENS,
    });
    h.specPages.set(url, await seal(new TextEncoder().encode(WORK), [(await generateKeyPairSigner()).address]));
    expect((await call(client, "wallet_fetch_work", { intent, announcement: "announced-0" })).value).toMatchObject({ code: "WorkUnfetchable" });
  }, 60_000);
});
