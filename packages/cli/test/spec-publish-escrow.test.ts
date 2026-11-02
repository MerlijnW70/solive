import { createHash } from "node:crypto";
import { type Address, generateKeyPairSigner, getBase58Decoder, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEVNET_TEST_MINT, NATIVE_MINT } from "@intent-engine/core";
import { seal } from "@intent-engine/core/internal";
import { BlockhashExpired } from "@intent-engine/client";
import { DEFAULT_SPEC_MIRROR, DEVNET_GENESIS_HASH, MAX_SPEC_BYTES, MIRROR_OFF, MIRROR_OFF_DEVNET, MIRROR_UNUSABLE, PUBLISH_SEALED, SPEC_MIRROR_ENV, SPEC_PUBLISH_OVER, SPEC_READ_MS } from "@intent-engine/client/internal";
import { NO_SPEC_BYTES, SEALED_SIBLING, SPEC_OVERSIZE, UNREAD_NOT_UPLOADED, UNREAD_SIBLING, UPLOAD_OFF } from "../src/agent/spec-upload.js";
import { ESCROW_CHANGED, JOB_LIVE } from "../src/agent/wallet/escrow.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { EXIT_OK } from "../src/main.js";
import { approved } from "./approved.js";
import { cli, h, world } from "./harness.js";

type Json = Record<string, unknown> & { [key: string]: any };

const SPEC = "deliver a module whose tests pass\n";
const SPEC_BYTES = new TextEncoder().encode(SPEC);
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const HASH = sha(SPEC);
const SPEC_URL = "https://" + "example.org/jobs/spec.md";
const OTHER = "the other spec\n";
const OTHER_HASH = sha(OTHER);
const OTHER_URL = "https://" + "example.org/jobs/other.md";
const SOME_HASH = "ab".repeat(32);
const PUT_URL = `${DEFAULT_SPEC_MIRROR}/sha256/${HASH}`;

type Put = { url: string; body: Uint8Array; landed: boolean };

let puts: Put[];

const upload = (status: number | (() => Promise<Response>), hash = HASH) => {
  h.specReplies.set(`${DEFAULT_SPEC_MIRROR}/sha256/${hash}`, async (url: string, init: { method?: string; body?: string | Uint8Array }) => {
    expect(init.method).toBe("PUT");
    puts.push({ url, body: init.body as Uint8Array, landed: h.wires.length > 0 });
    return typeof status === "number" ? new Response("{}", { status }) : status();
  });
};

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

async function connect(argv: string[]): Promise<Client> {
  h.served.length = 0;
  const started = await cli(argv, {});
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

async function call(client: Client, name: string, args: object = {}) {
  const result = await client.callTool({ name: `solive_${name}`, arguments: args as Record<string, unknown> });
  return { error: result.isError === true, value: result.structuredContent as Json };
}

async function ok(client: Client, name: string, args: object = {}): Promise<Json> {
  const { error, value } = await call(client, name, args);
  expect(error, JSON.stringify(value)).toBe(false);
  return value;
}

const line = (summary: string[], start: string) => summary.filter((one) => one.startsWith(start));

describe("the spec goes to the mirror when an escrow is sent", () => {
  let client: Client;
  let owner: Address;
  let judge: Address;
  let terms: Json;

  const send = async (args: object) => ok(client, "wallet_escrow", await approved(client, "wallet_escrow", args));

  beforeEach(async () => {
    await world();
    h.genesis = DEVNET_GENESIS_HASH;
    h.files.clear();
    for (const name of Object.keys(h.env)) {
      delete h.env[name];
    }
    puts = [];
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    client = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    owner = (await ok(client, "wallet_setup"))["address"] as Address;
    h.watched.push(owner);
    judge = (await generateKeyPairSigner()).address;
    h.wires.length = 0;
    terms = { sell: "SOL", amount: "0.01", attestor: judge, spec_hash: HASH };
    h.specPages.set(SPEC_URL, SPEC_BYTES);
    upload(201);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uploads a matching spec_url once, after the send", async () => {
    const sent = await send({ ...terms, spec_url: SPEC_URL });
    expect(puts).toHaveLength(1);
    expect(puts[0]?.url).toBe(PUT_URL);
    expect(puts[0]?.landed).toBe(true);
    expect(Buffer.from(puts[0]?.body ?? [])).toStrictEqual(Buffer.from(SPEC_BYTES));
    expect(sent).toMatchObject({ sent: true, spec_published: true, spec_mirror_url: PUT_URL, next: JOB_LIVE });
    expect(sent["spec_not_published"]).toBeUndefined();
  });

  it("sends nothing to the mirror on a preview, and says the spec will go there", async () => {
    const preview = await ok(client, "wallet_escrow", { ...terms, spec_url: SPEC_URL });
    expect(puts).toStrictEqual([]);
    expect(preview).toMatchObject({ sent: false });
    expect(preview["spec_published"]).toBeUndefined();
    expect(line(preview["summary"], "Mirror:")).toStrictEqual([`Mirror: after the send, the spec goes to the public mirror ${DEFAULT_SPEC_MIRROR}, where anyone can read it for good; publish_spec: false keeps it off`]);
  });

  it("uploads nothing for a url whose bytes do not match", async () => {
    h.specPages.set(SPEC_URL, new TextEncoder().encode("an edited spec"));
    const preview = await ok(client, "wallet_escrow", { ...terms, spec_url: SPEC_URL });
    expect(line(preview["summary"], "Mirror:")[0]).toContain("is not uploaded");
    const sent = await send({ ...terms, spec_url: SPEC_URL });
    expect(puts).toStrictEqual([]);
    expect(sent).toMatchObject({ sent: true, spec_published: false, spec_not_published: `spec_url hashes to ${sha("an edited spec")}, not spec_hash ${HASH}` });
  });

  it("uploads nothing for a sealed url, even with the plaintext in spec_text", async () => {
    h.specPages.set(SPEC_URL, await seal(SPEC_BYTES, [judge, owner]));
    for (const args of [{ spec_url: SPEC_URL }, { spec_url: SPEC_URL, spec_text: SPEC }]) {
      const sent = await send({ ...terms, ...args });
      expect(sent).toMatchObject({ sent: true, spec_published: false, spec_not_published: PUBLISH_SEALED });
    }
    expect(puts).toStrictEqual([]);
  });

  it("uploads nothing for spec_text that is itself sealed bytes", async () => {
    const asText = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await seal(SPEC_BYTES, [judge]));
    const sent = await send({ ...terms, spec_hash: sha(asText), spec_text: asText });
    expect(sent).toMatchObject({ sent: true, spec_published: false, spec_not_published: PUBLISH_SEALED });
    expect(puts).toStrictEqual([]);
  });

  it("refuses spec_text with a wrong hash before anything is sent, in a preview and a send", async () => {
    for (const extra of [{}, { send: true, approval: "x" }]) {
      const refused = await call(client, "wallet_escrow", { ...terms, spec_text: "not the spec", ...extra });
      expect(refused.error).toBe(true);
      expect(refused.value).toMatchObject({ code: "InvalidInput", issues: [{ path: "spec_text" }] });
      expect(refused.value["issues"][0]["message"]).toContain(sha("not the spec"));
    }
    expect(h.wires).toStrictEqual([]);
    expect(puts).toStrictEqual([]);
    const noHash = await call(client, "wallet_escrow", { sell: "SOL", amount: "0.01", attestor: judge, spec_text: SPEC });
    expect(noHash.value).toMatchObject({ code: "InvalidInput", issues: [{ path: "spec_text", message: "needs spec_hash" }] });
  });

  it("uploads spec_text with the right hash after the send, with no url at all", async () => {
    const sent = await send({ ...terms, spec_text: SPEC });
    expect(puts).toHaveLength(1);
    expect(puts[0]?.landed).toBe(true);
    expect(Buffer.from(puts[0]?.body ?? [])).toStrictEqual(Buffer.from(SPEC_BYTES));
    expect(sent).toMatchObject({ sent: true, spec_published: true, spec_mirror_url: PUT_URL });
  });

  it("accepts spec_hash in capitals, and uploads under the lowercase path", async () => {
    const sent = await send({ ...terms, spec_hash: HASH.toUpperCase(), spec_text: SPEC, spec_url: SPEC_URL });
    expect(sent).toMatchObject({ sent: true, spec_published: true });
    expect(puts.map(({ url }) => url)).toStrictEqual([PUT_URL]);
  });

  it("does not upload spec_text when spec_url cannot be read, since the job may be sealed", async () => {
    h.specPages.delete(SPEC_URL);
    const sent = await send({ ...terms, spec_url: SPEC_URL, spec_text: SPEC });
    expect(sent).toMatchObject({ sent: true, spec_published: false });
    expect(sent["spec_not_published"]).toContain(UNREAD_NOT_UPLOADED);
    expect(puts).toStrictEqual([]);
  });

  it("uploads nothing with publish_spec false, and the preview says so", async () => {
    const args = { ...terms, spec_url: SPEC_URL, spec_text: SPEC, publish_spec: false };
    const preview = await ok(client, "wallet_escrow", args);
    expect(line(preview["summary"], "Mirror:")).toStrictEqual([`Mirror: the spec is not uploaded: ${UPLOAD_OFF}`]);
    const sent = await send(args);
    expect(puts).toStrictEqual([]);
    expect(sent).toMatchObject({ sent: true, spec_published: false, spec_not_published: UPLOAD_OFF, next: JOB_LIVE });
  });

  it("refuses a send whose upload choice differs from its preview", async () => {
    const preview = await ok(client, "wallet_escrow", { ...terms, spec_url: SPEC_URL, publish_spec: false });
    const refused = await call(client, "wallet_escrow", { ...terms, spec_url: SPEC_URL, approval: preview["approval"], send: true });
    expect(refused.error).toBe(true);
    expect(refused.value).toMatchObject({ hint: ESCROW_CHANGED });
    expect(h.wires).toStrictEqual([]);
    expect(puts).toStrictEqual([]);
  });

  it("says why when an escrow gives no bytes to upload, and adds nothing to an escrow without spec_hash", async () => {
    expect(await send(terms)).toMatchObject({ sent: true, spec_published: false, spec_not_published: NO_SPEC_BYTES });
    const plain = await send({ sell: "SOL", amount: "0.01", attestor: judge });
    expect(plain["spec_published"]).toBeUndefined();
    expect(puts).toStrictEqual([]);
  });

  it("leaves the escrow result successful, with the reason and a hint, when the upload fails", async () => {
    upload(400);
    const sent = await send({ ...terms, spec_url: SPEC_URL });
    expect(sent).toMatchObject({ sent: true, spec_published: false });
    expect(sent["signature"]).toEqual(expect.any(String));
    expect(sent["spec_not_published"]).toContain("answered 400");
    expect(sent["next"]).toContain(JOB_LIVE);
    expect(sent["next"]).toContain("workers read it only from spec_url");
    expect(puts).toHaveLength(1);
    expect((await ok(client, "wallet_intents"))["intents"]).toHaveLength(1);
    upload(async () => {
      throw new TypeError("socket hang up");
    });
    const broken = await send({ ...terms, spec_text: SPEC });
    expect(broken).toMatchObject({ sent: true, spec_published: false });
    expect(broken["spec_not_published"]).toContain("socket hang up");
    expect(broken["next"]).toContain("workers cannot read it");
  });

  it("does not lose the escrow to a slow mirror", async () => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    const budgets: number[] = [];
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
      budgets.push(ms);
      return timeout(ms === SPEC_READ_MS ? 100 : ms);
    });
    try {
      upload(() => new Promise<Response>(() => undefined));
      const sent = await send({ ...terms, spec_url: SPEC_URL });
      expect(budgets).toContain(SPEC_READ_MS);
      expect(sent).toMatchObject({ sent: true, spec_published: false, spec_not_published: SPEC_PUBLISH_OVER });
      expect(sent["signature"]).toEqual(expect.any(String));
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("keeps the escrow result when the upload itself throws", async () => {
    const args = await approved(client, "wallet_escrow", { ...terms, spec_url: SPEC_URL });
    const digest = crypto.subtle.digest.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, data) => {
      if (Buffer.from(data as Uint8Array).equals(Buffer.from(SPEC_BYTES))) {
        throw new Error("no digest here");
      }
      return digest(algorithm, data);
    });
    try {
      const sent = await ok(client, "wallet_escrow", args);
      expect(sent).toMatchObject({ sent: true, spec_published: false, spec_not_published: "no digest here" });
      expect(sent["signature"]).toEqual(expect.any(String));
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("does not promise an upload of a spec_text over the size a reader reads", async () => {
    const big = "a".repeat(MAX_SPEC_BYTES + 1);
    const args = { ...terms, spec_hash: sha(big), spec_text: big };
    const preview = await ok(client, "wallet_escrow", args);
    expect(line(preview["summary"], "Mirror:")).toStrictEqual([`Mirror: the spec is not uploaded: ${SPEC_OVERSIZE}`]);
    expect(await send(args)).toMatchObject({ sent: true, spec_published: false, spec_not_published: SPEC_OVERSIZE });
    expect(puts).toStrictEqual([]);
  });

  it("treats the default mirror with a trailing slash as the default off devnet", async () => {
    vi.stubEnv(SPEC_MIRROR_ENV, `${DEFAULT_SPEC_MIRROR}/`);
    h.genesis = getBase58Decoder().decode(new Uint8Array(32).fill(0x12));
    const preview = await ok(client, "wallet_escrow", { ...terms, spec_url: SPEC_URL });
    expect(line(preview["summary"], "Mirror:")).toStrictEqual([`Mirror: the spec is not uploaded: ${MIRROR_OFF_DEVNET}`]);
    expect(puts).toStrictEqual([]);
  });

  it("never shows or uses a mirror url that holds credentials", async () => {
    vi.stubEnv(SPEC_MIRROR_ENV, "https://" + "user:hunter2@mirror.example");
    const preview = await ok(client, "wallet_escrow", { ...terms, spec_url: SPEC_URL });
    expect(JSON.stringify(preview)).not.toContain("hunter2");
    expect(line(preview["summary"], "Mirror:")).toStrictEqual([`Mirror: the spec is not uploaded: ${MIRROR_UNUSABLE}`]);
    const sent = await send({ ...terms, spec_url: SPEC_URL });
    expect(JSON.stringify(sent)).not.toContain("hunter2");
    expect(sent).toMatchObject({ sent: true, spec_published: false, spec_not_published: MIRROR_UNUSABLE });
  });

  it("refuses a send whose mirror changed since its preview", async () => {
    const preview = await ok(client, "wallet_escrow", { ...terms, spec_url: SPEC_URL });
    vi.stubEnv(SPEC_MIRROR_ENV, "https://" + "mirror.example");
    const refused = await call(client, "wallet_escrow", { ...terms, spec_url: SPEC_URL, approval: preview["approval"], send: true });
    expect(refused.value).toMatchObject({ hint: ESCROW_CHANGED });
    expect(h.wires).toStrictEqual([]);
  });

  it("uses the mirror the environment names, and none when it is empty", async () => {
    const other = "https://" + "mirror.example";
    vi.stubEnv(SPEC_MIRROR_ENV, other);
    h.specReplies.set(`${other}/sha256/${HASH}`, async (url: string) => {
      puts.push({ url, body: new Uint8Array(), landed: true });
      return new Response("{}", { status: 201 });
    });
    const sent = await send({ ...terms, spec_url: SPEC_URL });
    expect(puts.map(({ url }) => url)).toStrictEqual([`${other}/sha256/${HASH}`]);
    expect(sent).toMatchObject({ spec_published: true, spec_mirror_url: `${other}/sha256/${HASH}` });
    puts.length = 0;
    vi.stubEnv(SPEC_MIRROR_ENV, "");
    const off = await send({ ...terms, spec_url: SPEC_URL });
    expect(puts).toStrictEqual([]);
    expect(off).toMatchObject({ sent: true, spec_published: false, spec_not_published: MIRROR_OFF });
  });

  it("leaves the default mirror alone off devnet, unless the environment names one", async () => {
    h.genesis = getBase58Decoder().decode(new Uint8Array(32).fill(0x12));
    const sent = await send({ ...terms, spec_url: SPEC_URL });
    expect(sent).toMatchObject({ sent: true, spec_published: false, spec_not_published: MIRROR_OFF_DEVNET });
    expect(puts).toStrictEqual([]);
  });

  describe("a plan", () => {
    const plan = () => ({ sell: "SOL", attestor: judge, spec_hash: HASH, spec_url: SPEC_URL, pieces: [{ name: "a", amount: "0.01" }, { name: "b", amount: "0.01" }, { name: "c", amount: "0.01", spec_hash: OTHER_HASH, spec_url: OTHER_URL }, { name: "d", amount: "0.01", spec_hash: SOME_HASH }] });

    beforeEach(() => {
      h.specPages.set(OTHER_URL, new TextEncoder().encode(OTHER));
      upload(201, OTHER_HASH);
    });

    it("previews without contacting the mirror, and states each piece", async () => {
      const preview = await ok(client, "wallet_escrow_plan", plan());
      expect(puts).toStrictEqual([]);
      expect(line(preview["summary"], "Mirror:")).toStrictEqual([
        `Mirror: after the send, the specs of pieces 1, 2, 3 go to the public mirror ${DEFAULT_SPEC_MIRROR}, where anyone can read them for good; publish_spec: false keeps them off`,
        `Mirror: not uploaded: piece 4: spec_url hashes to ${sha(SPEC)}, not spec_hash ${SOME_HASH}`,
      ]);
    });

    it("uploads each spec once, after the sends, and reports each piece", async () => {
      const sent = await ok(client, "wallet_escrow_plan", await approved(client, "wallet_escrow_plan", plan()));
      expect(puts.map(({ url }) => url).sort()).toStrictEqual([PUT_URL, `${DEFAULT_SPEC_MIRROR}/sha256/${OTHER_HASH}`].sort());
      expect(puts.every(({ landed }) => landed)).toBe(true);
      expect(sent["pieces"]).toMatchObject([
        { name: "a", spec_published: true, spec_mirror_url: PUT_URL },
        { name: "b", spec_published: true, spec_mirror_url: PUT_URL },
        { name: "c", spec_published: true },
        { name: "d", spec_published: false, spec_not_published: `spec_url hashes to ${sha(SPEC)}, not spec_hash ${SOME_HASH}` },
      ]);
    });

    it("refuses a piece's wrong spec_text before anything is sent, and lets a piece with its own hash skip the plan's text", async () => {
      const refused = await call(client, "wallet_escrow_plan", { ...plan(), pieces: [{ name: "a", amount: "0.01", spec_text: "wrong" }, { name: "b", amount: "0.01" }] });
      expect(refused.value).toMatchObject({ code: "InvalidInput", issues: [{ path: "pieces.0.spec_text" }] });
      expect(h.wires).toStrictEqual([]);
      const mixed = { sell: "SOL", attestor: judge, spec_hash: HASH, spec_text: SPEC, pieces: [{ name: "a", amount: "0.01" }, { name: "c", amount: "0.01", spec_hash: OTHER_HASH, spec_text: OTHER }] };
      const sent = await ok(client, "wallet_escrow_plan", await approved(client, "wallet_escrow_plan", mixed));
      expect(sent["pieces"]).toMatchObject([{ spec_published: true }, { spec_published: true }]);
      expect(puts).toHaveLength(2);
    });

    it("does not give the plan's spec_text to a piece with its own spec_hash", async () => {
      const mixed = { sell: "SOL", attestor: judge, spec_hash: HASH, spec_text: SPEC, pieces: [{ name: "a", amount: "0.01" }, { name: "c", amount: "0.01", spec_hash: OTHER_HASH }] };
      const sent = await ok(client, "wallet_escrow_plan", await approved(client, "wallet_escrow_plan", mixed));
      expect(sent["pieces"]).toMatchObject([{ spec_published: true }, { spec_published: false, spec_not_published: NO_SPEC_BYTES }]);
      expect(puts.map(({ url }) => url)).toStrictEqual([PUT_URL]);
    });

    it("uploads a hash for no piece when any piece's url holds it sealed, and the preview says so", async () => {
      const sealedUrl = "https://" + "example.org/jobs/sealed.md";
      h.specPages.set(sealedUrl, await seal(SPEC_BYTES, [judge, owner]));
      const leak = { sell: "SOL", attestor: judge, pieces: [{ name: "a", amount: "0.01", spec_hash: HASH, spec_text: SPEC }, { name: "b", amount: "0.01", spec_hash: HASH, spec_url: sealedUrl }, { name: "c", amount: "0.01", spec_hash: HASH.toUpperCase(), spec_url: SPEC_URL }] };
      const preview = await ok(client, "wallet_escrow_plan", leak);
      expect(line(preview["summary"], "Mirror:")).toStrictEqual([`Mirror: not uploaded: piece 1: ${SEALED_SIBLING}; piece 2: ${PUBLISH_SEALED}; piece 3: ${SEALED_SIBLING}`]);
      const sent = await ok(client, "wallet_escrow_plan", await approved(client, "wallet_escrow_plan", leak));
      expect(sent["pieces"]).toMatchObject([{ spec_published: false, spec_not_published: SEALED_SIBLING }, { spec_published: false, spec_not_published: PUBLISH_SEALED }, { spec_published: false, spec_not_published: SEALED_SIBLING }]);
      expect(puts).toStrictEqual([]);
    });

    it("does not upload spec_text when another piece's url with that hash cannot be read", async () => {
      const gone = "https://" + "example.org/jobs/gone.md";
      const risky = { sell: "SOL", attestor: judge, pieces: [{ name: "a", amount: "0.01", spec_hash: HASH, spec_text: SPEC }, { name: "b", amount: "0.01", spec_hash: HASH, spec_url: gone }] };
      const sent = await ok(client, "wallet_escrow_plan", await approved(client, "wallet_escrow_plan", risky));
      expect(sent["pieces"][0]).toMatchObject({ spec_published: false, spec_not_published: UNREAD_SIBLING });
      expect(puts).toStrictEqual([]);
    });

    it("says piece, not pieces, for one upload", async () => {
      const one = { sell: "SOL", attestor: judge, pieces: [{ name: "a", amount: "0.01", spec_hash: HASH, spec_text: SPEC }, { name: "b", amount: "0.01" }] };
      const preview = await ok(client, "wallet_escrow_plan", one);
      expect(line(preview["summary"], "Mirror:")).toStrictEqual([`Mirror: after the send, the spec of piece 1 goes to the public mirror ${DEFAULT_SPEC_MIRROR}, where anyone can read it for good; publish_spec: false keeps it off`]);
    });

    it("refuses a send whose publish_spec or mirror changed since its preview", async () => {
      const preview = await ok(client, "wallet_escrow_plan", { ...plan(), publish_spec: false });
      const flipped = await call(client, "wallet_escrow_plan", { ...plan(), approval: preview["approval"], send: true });
      expect(flipped.value).toMatchObject({ hint: ESCROW_CHANGED });
      const shown = await ok(client, "wallet_escrow_plan", plan());
      vi.stubEnv(SPEC_MIRROR_ENV, "https://" + "mirror.example");
      const moved = await call(client, "wallet_escrow_plan", { ...plan(), approval: shown["approval"], send: true });
      expect(moved.value).toMatchObject({ hint: ESCROW_CHANGED });
      expect(h.wires).toStrictEqual([]);
      expect(puts).toStrictEqual([]);
    });

    it("uploads nothing with publish_spec false, and a failed upload leaves the plan sent", async () => {
      const off = await ok(client, "wallet_escrow_plan", await approved(client, "wallet_escrow_plan", { ...plan(), publish_spec: false }));
      expect(puts).toStrictEqual([]);
      expect(off["pieces"][0]).toMatchObject({ spec_published: false, spec_not_published: UPLOAD_OFF });
      upload(413);
      const failed = await ok(client, "wallet_escrow_plan", await approved(client, "wallet_escrow_plan", plan()));
      expect(failed).toMatchObject({ sent: true });
      expect(failed["pieces"][0]["spec_not_published"]).toContain("answered 413");
      expect(failed["next"]).toContain("the spec is not on the mirror");
      expect(failed["next"]).toContain("pieces offered");
    });

    it("uploads only the pieces that landed when a later piece fails", async () => {
      const args = await approved(client, "wallet_escrow_plan", plan());
      h.sendFails = { error: new BlockhashExpired("expired"), landed: false, after: 2 };
      const sent = await ok(client, "wallet_escrow_plan", args);
      expect(sent["sent"]).toBe(true);
      expect(puts.map(({ url }) => url)).toStrictEqual([PUT_URL]);
      expect(sent["pieces"][2]["spec_published"]).toBeUndefined();
    });
  });
});
