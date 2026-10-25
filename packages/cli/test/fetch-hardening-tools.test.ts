import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { type Address, generateKeyPairSigner, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, NATIVE_MINT } from "@intent-engine/core";
import { seal, specMemo } from "@intent-engine/core/internal";
import { MAX_SPEC_BYTES, SPEC_REDIRECTS } from "@intent-engine/client/internal";
import { tool } from "../src/agent/names.js";
import { NOT_TEXT } from "../src/agent/spec.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { notSealedTo, SPEC_TOO_LARGE } from "../src/agent/wallet/escrow.js";
import { sealedLimits } from "../src/agent/wallet/escrow-claims.js";
import { EXIT_OK } from "../src/main.js";
import { announced, keyed } from "./announce.js";
import { approved } from "./approved.js";
import { cli, creation, funded, h, ownerSigned, world } from "./harness.js";

type Json = Record<string, unknown>;

const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const encoded = (text: string) => new TextEncoder().encode(text);
const hexOf = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
const SPEC = "# Private job\n\nDeliver one text file.\n";
const SEALED_URL = "https://" + "example.org/jobs/private.sealed";

const servers: Server[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.close();
  }
});

async function serve(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return "http://" + `127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function preset(at: Address): void {
  if (h.svm.getAccount(at).exists) {
    return;
  }
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

async function call(client: Client, name: string, args: object = {}) {
  const result = await client.callTool({ name: tool(name), arguments: args as Record<string, unknown> });
  return { error: result.isError === true, value: result.structuredContent as Json };
}

async function ok(client: Client, name: string, args: object = {}): Promise<Json> {
  const { error, value } = await call(client, name, args);
  expect(error, JSON.stringify(value)).toBe(false);
  return value;
}

async function server(url: string, wallet: boolean): Promise<Client> {
  h.served.length = 0;
  const started = await cli(["mcp", "--url", url, ...(wallet ? ["--wallet"] : [])], {});
  expect([started.code, started.err]).toEqual([EXIT_OK, wallet ? WALLET_NOTICE.join("\n") : ""]);
  const [near, far] = InMemoryTransport.createLinkedPair();
  await h.served[0]?.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return client;
}

async function wallet(url = "devnet"): Promise<{ client: Client; owner: Address }> {
  await world();
  h.files.clear();
  preset(NATIVE_MINT);
  preset(DEVNET_TEST_MINT);
  const client = await server(url, true);
  return { client, owner: (await ok(client, "wallet_setup"))["address"] as Address };
}

async function job(client: Client, judge: Address, specUrl: string, spec: Uint8Array, extra: object = {}): Promise<Address> {
  h.specPages.set(specUrl, spec);
  const sent = await ok(client, "wallet_escrow", await approved(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: judge, spec_hash: sha(spec), spec_url: specUrl, ...extra }));
  const intent = sent["intent"] as Address;
  h.engineLog.push({ ...creation(intent), ...ownerSigned(intent, [specMemo(specUrl)]) });
  return intent;
}

const warnings = (shown: Json): string[] => shown["warnings"] as string[];

describe("get_spec telling a lasting failure from a passing one", () => {
  it("calls a redirecting spec url SpecUnfetchable and says it redirects", async () => {
    const { client, owner } = await wallet();
    const base = await serve((_request, response) => {
      response.writeHead(302, { location: "/elsewhere" }).end();
    });
    const specUrl = "https://" + "example.org/jobs/moved.md";
    const intent = await job(client, owner, specUrl, encoded("spec\n"));
    h.specReplies.set(specUrl, (_url, init) => fetch(`${base}/moved`, init));
    expect(await call(client, "get_spec", { intent })).toMatchObject({ error: true, value: { code: "SpecUnfetchable", retryable: false, hint: expect.stringContaining(SPEC_REDIRECTS) } });
  }, 60_000);

  it("calls a body that breaks off or times out SpecUnreadable, with the cause", async () => {
    const { client, owner } = await wallet();
    const base = await serve((_request, response) => {
      response.writeHead(200, { "content-length": "1000" });
      response.write("partial", () => response.socket?.destroy());
    });
    const cut = "https://" + "example.org/jobs/cut.md";
    const slow = "https://" + "example.org/jobs/slow.md";
    const late = "https://" + "example.org/jobs/late.md";
    const timedOut = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");
    const cases = [
      { url: cut, cause: "terminated" },
      { url: slow, cause: "aborted due to timeout" },
      { url: late, cause: "aborted due to timeout" },
    ];
    for (const { url, cause } of cases) {
      const intent = await job(client, owner, url, encoded("spec\n"));
      h.specReplies.set(cut, (_url, init) => fetch(`${base}/cut`, init));
      h.specReplies.set(slow, async () => new Response(new ReadableStream({ start: (stream) => stream.error(timedOut()) })));
      h.specReplies.set(late, async () => {
        throw timedOut();
      });
      const result = await call(client, "get_spec", { intent });
      expect(result, url).toMatchObject({ error: true, value: { code: "SpecUnreadable", retryable: true, hint: expect.stringContaining(cause) } });
    }
  }, 60_000);
});

describe("get_spec returning text only when it is the bytes it hashed", () => {
  it("keeps a byte order mark and leaves out text that is not UTF-8", async () => {
    const { client, owner } = await wallet();
    const marked = Uint8Array.from([0xef, 0xbb, 0xbf, ...encoded("# spec\n")]);
    const latin = Uint8Array.from([...encoded("pay only if the output is "), 0xe9, 0x0a]);
    const first = await ok(client, "get_spec", { intent: await job(client, owner, "https://" + "example.org/jobs/marked.md", marked) });
    expect(first).toMatchObject({ matches: true });
    expect(hexOf(encoded(first["text"] as string))).toBe(hexOf(marked));
    const second = await ok(client, "get_spec", { intent: await job(client, owner, "https://" + "example.org/jobs/latin.md", latin) });
    expect(second).toMatchObject({ matches: true, sha256: sha(latin), text_warning: NOT_TEXT });
    expect(second).not.toHaveProperty("text");
  }, 60_000);

  it("keeps a byte order mark in the work wallet_fetch_work shows", async () => {
    const { client, owner } = await wallet();
    const intent = await job(client, owner, "https://" + "example.org/jobs/w.md", encoded("spec\n"));
    const work = Uint8Array.from([0xef, 0xbb, 0xbf, ...encoded("export default 1;\n")]);
    const url = "https://" + `files.example.com/${sha(work).slice(0, 32)}`;
    h.specPages.set(url, work);
    const made = await announced(intent, await keyed(), sha(work), url);
    const fetched = await ok(client, "wallet_fetch_work", { intent, announcement: made.announcement });
    expect(fetched).toMatchObject({ opens_commitment: true, sha256: sha(work) });
    expect(hexOf(encoded(fetched["untrusted_text"] as string))).toBe(hexOf(work));
  }, 60_000);
});

describe("the escrow spec check", () => {
  it("warns when the spec is larger than get_spec reads, in wallet_escrow and the plan", async () => {
    const { client, owner } = await wallet();
    const spec = new Uint8Array(MAX_SPEC_BYTES + 1).fill(0x61);
    const specUrl = "https://" + "example.org/jobs/large.md";
    h.specPages.set(specUrl, spec);
    const terms = { sell: "SOL", attestor: owner, spec_hash: sha(spec), spec_url: specUrl };
    expect(warnings(await ok(client, "wallet_escrow", { ...terms, amount: "0.05" }))).toContain(SPEC_TOO_LARGE);
    const plan = await ok(client, "wallet_escrow_plan", { ...terms, pieces: [{ name: "a", amount: "0.01" }, { name: "b", amount: "0.01" }] });
    expect(warnings(plan)).toContain(`Piece 2 (b): ${SPEC_TOO_LARGE}`);
    expect(SPEC_TOO_LARGE).toContain(String(MAX_SPEC_BYTES));
  }, 60_000);

  it("refuses a spec_url outside the memo url rule without fetching it", async () => {
    const { client, owner } = await wallet();
    const fetched: string[] = [];
    const specUrl = "https://" + "EXAMPLE.org/jobs/../spec.md";
    h.specReplies.set(specUrl, async (url) => {
      fetched.push(url);
      return new Response("spec\n");
    });
    const preview = await call(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: owner, spec_hash: sha("spec\n"), spec_url: specUrl });
    expect({ code: preview.value["code"], fetched }).toStrictEqual({ code: "InvalidInput", fetched: [] });
  }, 60_000);

  it("warns when a sealed spec leaves out the attestor, and limits claims to the workers it invites", async () => {
    const { client, owner } = await wallet();
    const [judge, worker] = [(await generateKeyPairSigner()).address, (await generateKeyPairSigner()).address];
    h.specPages.set(SEALED_URL, await seal(encoded(SPEC), [owner, worker]));
    const terms = { sell: "SOL", amount: "0.05", spec_hash: sha(SPEC), spec_url: SEALED_URL };
    const missed = warnings(await ok(client, "wallet_escrow", { ...terms, attestor: judge }));
    expect(missed).toContain(notSealedTo([judge], false));
    const covered = await ok(client, "wallet_escrow", { ...terms, attestor: owner, claim_stake: "0.01", claim_secs: 600 });
    expect(warnings(covered).filter((line) => line.startsWith("spec_url holds a spec not sealed"))).toEqual([]);
    expect(covered["summary"]).toContain(sealedLimits([worker]));
    const plan = await ok(client, "wallet_escrow_plan", {
      sell: "SOL",
      attestor: judge,
      spec_hash: sha(SPEC),
      spec_url: SEALED_URL,
      claim_stake: "0.01",
      claim_secs: 600,
      pieces: [{ name: "a", amount: "0.01" }, { name: "b", amount: "0.01", attestor: owner }],
    });
    expect(warnings(plan)).toContain(`Piece 1 (a): ${notSealedTo([judge], false)}`);
    expect(warnings(plan).filter((line) => line.startsWith("Piece 2 (b): spec_url holds"))).toEqual([]);
    expect((plan["summary"] as string[]).filter((line) => line.includes(sealedLimits([worker])))).toEqual([sealedLimits([worker])]);
  }, 60_000);

  it("warns when a sealed spec leaves out a member of a committee attestor", async () => {
    const { client, owner } = await wallet();
    h.watched.push(owner);
    const peer = await funded();
    const terms = { members: [peer.address, owner], threshold: 2 };
    const preview = await ok(client, "wallet_committee_create", terms);
    await ok(client, "wallet_committee_create", { ...terms, approval: preview["approval"], send: true });
    const committee = preview["committee"] as Address;
    h.specPages.set(SEALED_URL, await seal(encoded(SPEC), [owner]));
    const shown = warnings(await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: committee, spec_hash: sha(SPEC), spec_url: SEALED_URL }));
    expect(shown).toContain(notSealedTo([peer.address], true));
    h.specPages.set(SEALED_URL, await seal(encoded(SPEC), [owner, peer.address]));
    const sealedToAll = warnings(await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: committee, spec_hash: sha(SPEC), spec_url: SEALED_URL }));
    expect(sealedToAll.filter((line) => line.startsWith("spec_url holds a spec not sealed"))).toEqual([]);
  }, 60_000);
});

describe("get_spec following the client's host rules", () => {
  const PRIVATE = "private, loopback or local network address";

  it("reads a loopback spec url through a loopback RPC url, as a local validator gives, and refuses it through any other", async () => {
    const { client, owner } = await wallet("http://" + "127.0.0.1:8899");
    const specUrl = "http://" + "127.0.0.1:8080/jobs/spec.md";
    const intent = await job(client, owner, specUrl, encoded(SPEC), { record_mint: DEVNET_TEST_MINT });
    expect(await ok(client, "get_spec", { intent })).toMatchObject({ url: specUrl, matches: true });
    const remote = await server("devnet", false);
    expect(await call(remote, "get_spec", { intent })).toMatchObject({ error: true, value: { code: "SpecUnfetchable", hint: expect.stringContaining(PRIVATE) } });
  }, 60_000);

  it("resolves a spec host with the lookup the runtime injects, never the system's", async () => {
    const { client, owner } = await wallet();
    const specUrl = "https://" + "example.org/jobs/inner.md";
    const intent = await job(client, owner, specUrl, encoded(SPEC));
    h.lookups = [];
    h.hosts.set("example.org", ["10.0.0.7"]);
    expect(await call(client, "get_spec", { intent })).toMatchObject({ error: true, value: { code: "SpecUnfetchable", hint: expect.stringContaining(PRIVATE) } });
    expect(h.lookups).toEqual(["example.org"]);
  }, 60_000);
});
