import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { type Address, generateKeyPairSigner, getBase58Decoder, getBase64Encoder, signBytes } from "@solana/kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SPEC_MIRROR, DEVNET_GENESIS_HASH, MIRROR_OFF, MIRROR_OFF_DEVNET, PUBLISH_SEALED, SPEC_MIRROR_ENV } from "@intent-engine/client/internal";
import { seal } from "@intent-engine/core/internal";
import { NOT_ON_MIRROR, UPLOAD_OFF, UPLOAD_PUBLIC } from "../src/agent/spec-upload.js";
import { WALLET_INSTRUCTIONS } from "../src/agent/mcp.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { walletEscrow, walletEscrowPlan } from "../src/agent/wallet/escrow.js";
import { SHAPES } from "../src/arg-usage.js";
import { EXIT_OK, EXIT_USAGE } from "../src/main.js";
import { connect, execute, ok, served, swapOf } from "./agent-kit.js";
import { ata, cli, ESCROW, funded, h, type World, world } from "./harness.js";

const SPEC = "deliver a module whose tests pass\n";
const SPEC_BYTES = new TextEncoder().encode(SPEC);
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const HASH = sha(SPEC);
const SPEC_URL = "https://" + "a.io/spec.md";
const PUT_URL = `${DEFAULT_SPEC_MIRROR}/sha256/${HASH}`;

type Put = { url: string; body: Uint8Array; wires: number };

let puts: Put[];

const upload = (status: number) => {
  h.specReplies.set(PUT_URL, async (url: string, init: { method?: string; body?: string | Uint8Array }) => {
    expect(init.method).toBe("PUT");
    puts.push({ url, body: init.body as Uint8Array, wires: h.wires.length });
    return new Response("{}", { status });
  });
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("create attested", () => {
  let w: World;
  let judge: Address;

  const create = (...more: string[]) =>
    cli(
      ["create", "attested", "--keypair", "owner.json", "--input-mint", w.inputMint, "--output-mint", w.outputMint, "--expires-in", "3600", "--amount-in", "0.0001", "--min-result", "1", "--max-result", "1", "--attestor", judge, ...more],
      { "owner.json": w.owner },
    );

  const shown = (run: { out: string }) => JSON.parse(run.out) as Record<string, unknown> & { summary: string[] };

  beforeEach(async () => {
    w = await world();
    h.genesis = DEVNET_GENESIS_HASH;
    h.files.clear();
    judge = (await generateKeyPairSigner()).address;
    puts = [];
    h.specPages.set(SPEC_URL, SPEC_BYTES);
    upload(201);
  });

  it("uploads a matching --spec-url once, after the send", async () => {
    const before = h.wires.length;
    const run = await create("--spec-hash", HASH, "--spec-url", SPEC_URL, "--yes");
    expect(run.code, run.err).toBe(EXIT_OK);
    expect(puts).toHaveLength(1);
    expect(puts[0]?.wires).toBeGreaterThan(before);
    expect(Buffer.from(puts[0]?.body ?? [])).toStrictEqual(Buffer.from(SPEC_BYTES));
    expect(shown(run)).toMatchObject({ sent: true, spec_published: true, spec_mirror_url: PUT_URL });
  });

  it("sends nothing to the mirror on a preview, and says the spec goes there", async () => {
    const run = await create("--spec-hash", HASH, "--spec-url", SPEC_URL);
    expect(run.code, run.err).toBe(EXIT_OK);
    expect(puts).toStrictEqual([]);
    expect(shown(run)).toMatchObject({ sent: false });
    expect(shown(run).summary.filter((line) => line.startsWith("Mirror:"))).toStrictEqual([`Mirror: after the send, the spec goes to the public mirror ${DEFAULT_SPEC_MIRROR}, where anyone can read it for good; --no-publish-spec keeps it off`]);
  });

  it("uploads nothing for bytes that do not match or are sealed", async () => {
    h.specPages.set(SPEC_URL, new TextEncoder().encode("an edited spec"));
    const edited = await create("--spec-hash", HASH, "--spec-url", SPEC_URL, "--yes");
    expect(shown(edited)).toMatchObject({ sent: true, spec_published: false, spec_not_published: expect.stringContaining("not spec_hash") });
    h.specPages.set(SPEC_URL, await seal(SPEC_BYTES, [judge]));
    const sealed = await create("--spec-hash", HASH, "--spec-url", SPEC_URL, "--yes");
    expect(shown(sealed)).toMatchObject({ sent: true, spec_published: false, spec_not_published: PUBLISH_SEALED });
    expect(puts).toStrictEqual([]);
  });

  it("refuses a --spec-file with a wrong hash, or that cannot be read, before anything is sent", async () => {
    h.files.set("spec.md", "not the spec");
    const before = h.wires.length;
    const wrong = await create("--spec-hash", HASH, "--spec-file", "spec.md", "--yes");
    expect(wrong.code).not.toBe(EXIT_OK);
    expect(wrong.err).toContain(sha("not the spec"));
    const gone = await create("--spec-hash", HASH, "--spec-file", "gone.md", "--yes");
    expect(gone.code).not.toBe(EXIT_OK);
    expect(gone.err).toContain("gone.md could not be read");
    expect(h.wires.length).toBe(before);
    expect(puts).toStrictEqual([]);
  });

  it("uploads a --spec-file with the right hash, with no url at all", async () => {
    h.files.set("spec.md", SPEC);
    const run = await create("--spec-hash", HASH, "--spec-file", "spec.md", "--yes");
    expect(shown(run)).toMatchObject({ sent: true, spec_published: true, spec_mirror_url: PUT_URL });
    expect(Buffer.from(puts[0]?.body ?? [])).toStrictEqual(Buffer.from(SPEC_BYTES));
  });

  it("uploads nothing with --no-publish-spec, off devnet, or with the mirror turned off", async () => {
    expect(shown(await create("--spec-hash", HASH, "--spec-url", SPEC_URL, "--no-publish-spec", "--yes"))).toMatchObject({ sent: true, spec_published: false, spec_not_published: UPLOAD_OFF });
    vi.stubEnv(SPEC_MIRROR_ENV, "");
    expect(shown(await create("--spec-hash", HASH, "--spec-url", SPEC_URL, "--yes"))).toMatchObject({ sent: true, spec_published: false, spec_not_published: MIRROR_OFF });
    vi.unstubAllEnvs();
    h.genesis = getBase58Decoder().decode(new Uint8Array(32).fill(0x12));
    expect(shown(await create("--spec-hash", HASH, "--spec-url", SPEC_URL, "--yes"))).toMatchObject({ sent: true, spec_published: false, spec_not_published: MIRROR_OFF_DEVNET });
    expect(puts).toStrictEqual([]);
  });

  it("keeps the send when the upload fails, with the reason and a hint", async () => {
    upload(413);
    const run = await create("--spec-hash", HASH, "--spec-url", SPEC_URL, "--yes");
    expect(run.code).toBe(EXIT_OK);
    expect(shown(run)).toMatchObject({ sent: true, spec_published: false, spec_not_published: expect.stringContaining("answered 413"), next: expect.stringContaining("workers read it only from spec_url") });
    expect(puts).toHaveLength(1);
  });

  it("takes the new options only with --spec-hash", async () => {
    for (const option of [["--spec-file", "spec.md"], ["--no-publish-spec"]]) {
      expect(await create(...option)).toMatchObject({ code: EXIT_USAGE, err: expect.stringContaining("needs --spec-hash") });
    }
  });
});

describe("what the docs and help say about --spec-file", () => {
  const page = (name: string) => readFileSync(new URL(`../../../docs/${name}`, import.meta.url), "utf8");

  it("says plainly that the file is uploaded publicly unless --no-publish-spec", () => {
    const usage = "after the send the file, or the bytes at --spec-url, is uploaded to the public mirror, publicly and for good, unless --no-publish-spec";
    expect(SHAPES["create"]).toContain(usage);
    expect(page("reference/cli.md")).toContain(usage);
    expect(page("mcp.md")).toContain("Its `--spec-file` is uploaded publicly and for good unless you pass `--no-publish-spec`.");
  });

  it("says plainly that the upload is public and permanent, in the docs and both tool descriptions, and notes the wider request type", () => {
    expect(page("mcp.md")).toContain("The upload is public and permanent");
    expect(page("sdk-client.md")).toContain("The upload is public and permanent");
    expect(page("sdk-client.md")).toContain("`SpecRequest` now allows the method `PUT` and a `Uint8Array` body");
    for (const action of [walletEscrow, walletEscrowPlan]) {
      expect((action as unknown as { description: string }).description).toContain(UPLOAD_PUBLIC);
    }
    expect(UPLOAD_PUBLIC).toContain("public and permanent");
  });

  it("tells the user in the wallet notice that specs leave this computer", () => {
    expect(WALLET_NOTICE).toContain("Your key stays on this computer; only signed transactions leave it, plus approved specs.");
    expect(WALLET_INSTRUCTIONS).toContain("plus approved specs");
  });
});

describe("paths that do not upload", () => {
  it("prepare_create and a signed, relayed escrow say so in their results, and contact no mirror", async () => {
    const { w } = await served();
    puts = [];
    upload(201);
    h.genesis = DEVNET_GENESIS_HASH;
    const relayer = await funded();
    const relaying = await connect(relayer, ["--relay-fee", `${w.inputMint}=0`]);
    const owner = await funded();
    await ata(w.authority, owner.address, w.inputMint, 1_000n);
    const judge = (await generateKeyPairSigner()).address;
    const order = { kind: "attested", amount_in: ESCROW.toString(), min_result: "1", max_result: "1", attestor: judge, spec_hash: HASH };
    const terms = { ...swapOf(w, { owner: owner.address, order }), spec_url: SPEC_URL };
    const line = `Mirror: ${NOT_ON_MIRROR}`;
    expect((await ok(relaying, "prepare_create", terms))["summary"]).toContain(line);
    const { spec_url: _, ...plain } = terms;
    expect((await ok(relaying, "prepare_create", plain))["summary"]).not.toContain(line);
    const prepared = await ok(relaying, "prepare_signed_intent", terms);
    expect(prepared["summary"]).toContain(line);
    await execute(prepared["setup"], owner);
    const signature = getBase58Decoder().decode(await signBytes(owner.keyPair.privateKey, getBase64Encoder().encode(prepared["message"])));
    const signed = { ...prepared["submit"], signature };
    expect((await ok(relaying, "preview_signed_intent", signed))["summary"]).toContain(line);
    const relayed = await ok(relaying, "submit_signed_intent", signed);
    expect(relayed).toMatchObject({ spec_published: false, spec_not_published: NOT_ON_MIRROR });
    expect(relayed["signature"]).toEqual(expect.any(String));
    expect(puts).toStrictEqual([]);
  });
});
