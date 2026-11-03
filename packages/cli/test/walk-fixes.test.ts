import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { type Address, generateKeyPairSigner, getBase58Encoder } from "@solana/kit";
import { Client } from "@modelcontextprotocol/client";
import { beforeEach, describe, expect, it } from "vitest";
import { Kind } from "@intent-engine/core";
import { seal } from "@intent-engine/core/internal";
import { DEVNET_GENESIS_HASH } from "@intent-engine/client/internal";
import { SPEC_URL_NEEDS_ATTESTED, ZERO_SPEC_HASH } from "../src/agent/create.js";
import { noReader, UPLOAD_OFF } from "../src/agent/spec-upload.js";
import { costLines, escrowCosts } from "../src/agent/wallet/costs.js";
import { publishedUrl } from "../src/agent/signed-terms.js";
import { noSpecUrl } from "../src/agent/spec.js";
import { SERVER_PROBLEMS } from "../src/agent/problems.js";
import { SEALED_UNCHECKED } from "../src/agent/wallet/seal.js";
import { WRONG_SPEC_REFUSED } from "../src/flow-commands.js";
import { paidOther } from "../src/agent/wallet/receipt.js";
import { EXIT_OK, EXIT_USAGE } from "../src/main.js";
import { cli, h, transport, type World, world } from "./harness.js";
import { fresh, ok as walletOk } from "./agent-wallet-kit.js";
import { fail, served, swapOf } from "./agent-kit.js";

const SPEC = "deliver a module whose tests pass\n";
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const HASH = sha(SPEC);
const SPEC_URL = "https://" + "a.io/spec.md";

describe("create attested checks the spec like the wallet tool does", () => {
  let w: World;
  let judge: Address;

  const create = (...more: string[]) =>
    cli(
      ["create", "attested", "--keypair", "owner.json", "--input-mint", w.inputMint, "--output-mint", w.outputMint, "--expires-in", "3600", "--amount-in", "0.0001", "--min-result", "1", "--max-result", "1", "--attestor", judge, ...more],
      { "owner.json": w.owner },
    );

  const shown = (run: { out: string }) => JSON.parse(run.out) as Record<string, unknown> & { summary: string[]; warnings?: string[] };

  beforeEach(async () => {
    w = await world();
    h.genesis = DEVNET_GENESIS_HASH;
    h.files.clear();
    judge = (await generateKeyPairSigner()).address;
    h.specPages.set(SPEC_URL, new TextEncoder().encode(SPEC));
  });

  it("warns, in the preview and in the sent result, when the spec at --spec-url hashes to something else", async () => {
    h.specPages.set(SPEC_URL, new TextEncoder().encode("an edited spec"));
    const line = `spec_url hashes to ${sha("an edited spec")}, not spec_hash ${HASH}; publish the exact bytes, or fix spec_hash`;
    const preview = await create("--spec-hash", HASH, "--spec-url", SPEC_URL);
    expect(preview.code, preview.err).toBe(EXIT_OK);
    expect(shown(preview)).toMatchObject({ sent: false });
    expect(shown(preview).warnings).toContain(line);
    const sent = await create("--spec-hash", HASH, "--spec-url", SPEC_URL, "--yes", "--allow-wrong-spec");
    expect(shown(sent)).toMatchObject({ sent: true });
    expect(shown(sent).warnings).toContain(line);
  });

  it("refuses a --yes send of a spec at --spec-url that hashes to something else, unless --allow-wrong-spec is passed", async () => {
    h.specPages.set(SPEC_URL, new TextEncoder().encode("an edited spec"));
    const before = h.wires.length;
    const refused = await create("--spec-hash", HASH, "--spec-url", SPEC_URL, "--yes");
    expect(refused.code).not.toBe(EXIT_OK);
    expect(refused.err).toBe(WRONG_SPEC_REFUSED(`spec_url hashes to ${sha("an edited spec")}, not spec_hash ${HASH}; publish the exact bytes, or fix spec_hash`));
    expect(refused.err).toContain("--allow-wrong-spec");
    expect(h.wires.length).toBe(before);
    h.specPages.set(SPEC_URL, new TextEncoder().encode(SPEC));
    expect(shown(await create("--spec-hash", HASH, "--spec-url", SPEC_URL, "--yes"))).toMatchObject({ sent: true });
  });

  it("opens a spec sealed to the owner's published encryption key with --encryption-keypair, and refuses a wrong hash with --yes", async () => {
    const made = await cli(["profile", "encryption-key", "new", "--out", "owner.enc"], {});
    const published = getBase58Encoder().encode(made.json()["encryption_key"] as string);
    h.specPages.set(SPEC_URL, await seal(new TextEncoder().encode(SPEC), [{ wallet: w.owner.address, encryptionKey: Uint8Array.from(published) }, judge]));
    const blind = await create("--spec-hash", HASH, "--spec-url", SPEC_URL);
    expect(shown(blind).warnings).toContain(SEALED_UNCHECKED);
    const opened = await create("--spec-hash", HASH, "--spec-url", SPEC_URL, "--encryption-keypair", "owner.enc");
    expect(opened.code, opened.err).toBe(EXIT_OK);
    expect(shown(opened).warnings ?? []).not.toContain(SEALED_UNCHECKED);
    const before = h.wires.length;
    const wrong = await create("--spec-hash", sha("another spec"), "--spec-url", SPEC_URL, "--encryption-keypair", "owner.enc", "--yes");
    expect(wrong.code).not.toBe(EXIT_OK);
    expect(wrong.err).toContain("opens to a spec that hashes");
    expect(h.wires.length).toBe(before);
    const unopened = await create("--spec-hash", sha("another spec"), "--spec-url", SPEC_URL, "--yes");
    expect(shown(unopened)).toMatchObject({ sent: true });
  });

  it("opens a spec sealed to the owner's wallet and checks its hash, and says it could not only when the owner is not invited", async () => {
    const owner = w.owner.address;
    h.specPages.set(SPEC_URL, await seal(new TextEncoder().encode(SPEC), [owner, judge]));
    const opened = await create("--spec-hash", HASH, "--spec-url", SPEC_URL);
    expect(opened.code, opened.err).toBe(EXIT_OK);
    expect(shown(opened).warnings ?? []).not.toContain(SEALED_UNCHECKED);
    expect((shown(opened).warnings ?? []).filter((line) => line.startsWith("spec_url"))).toEqual([]);
    const other = await create("--spec-hash", sha("another spec"), "--spec-url", SPEC_URL);
    expect((shown(other).warnings ?? []).some((line) => line.includes("opens to a spec that hashes"))).toBe(true);
    h.specPages.set(SPEC_URL, await seal(new TextEncoder().encode(SPEC), [judge]));
    expect(shown(await create("--spec-hash", HASH, "--spec-url", SPEC_URL)).warnings).toContain(SEALED_UNCHECKED);
  });

  it("warns about a --spec-url it cannot read, and about none when the spec matches", async () => {
    h.specPages.delete(SPEC_URL);
    const gone = await create("--spec-hash", HASH, "--spec-url", SPEC_URL);
    expect((shown(gone).warnings ?? []).some((line) => line.startsWith("spec_url ") && line.endsWith("publish it or workers cannot read the job"))).toBe(true);
    h.specPages.set(SPEC_URL, new TextEncoder().encode(SPEC));
    const fine = await create("--spec-hash", HASH, "--spec-url", SPEC_URL);
    expect((shown(fine).warnings ?? []).filter((line) => line.includes("spec_hash"))).toEqual([]);
  });

  it("warns that no reader can get a spec kept off the mirror with no url", async () => {
    h.files.set("spec.md", SPEC);
    const off = await create("--spec-hash", HASH, "--spec-file", "spec.md", "--no-publish-spec");
    expect(shown(off).warnings).toContain(noReader(UPLOAD_OFF));
    const withUrl = await create("--spec-hash", HASH, "--spec-file", "spec.md", "--spec-url", SPEC_URL, "--no-publish-spec");
    expect(shown(withUrl).warnings ?? []).not.toContain(noReader(UPLOAD_OFF));
    const published = await create("--spec-hash", HASH, "--spec-file", "spec.md");
    expect((shown(published).warnings ?? []).filter((line) => line.startsWith("this escrow publishes") || line.startsWith("spec_url"))).toEqual([]);
  });

  it("shows the cost of the escrow as the wallet preview does", async () => {
    const preview = shown(await create("--spec-hash", HASH, "--spec-url", SPEC_URL));
    const costs = await escrowCosts(transport, { owner: w.owner.address, sell: w.inputMint, buy: w.outputMint, claims: false });
    const lines = costLines(costs, 5_000n, BigInt(preview["escrow"] as string), 1);
    expect(lines).toHaveLength(4);
    expect(preview.summary).toEqual(expect.arrayContaining(lines));
  });

  it("says a zero spec hash pins nothing", async () => {
    const zero = await create("--spec-hash", "00".repeat(32), "--spec-url", SPEC_URL);
    expect(zero.code).toBe(EXIT_USAGE);
    expect(zero.err).toContain(`spec_url: ${ZERO_SPEC_HASH}`);
  });
});

describe("a spec url on terms that pin no spec", () => {
  it("names the real problem in prepare_create and in a signed escrow", async () => {
    const { w, client } = await served();
    const judge = (await generateKeyPairSigner()).address;
    const order = { kind: "attested", amount_in: "100", min_result: "1", max_result: "1", attestor: judge, spec_hash: "00".repeat(32) };
    const zero = await fail(client, "prepare_create", { ...swapOf(w, { order }), spec_url: SPEC_URL });
    expect(zero).toMatchObject({ code: "InvalidInput", issues: [{ path: "spec_url", message: ZERO_SPEC_HASH }] });
    const swap = await fail(client, "prepare_create", { ...swapOf(w), spec_url: SPEC_URL });
    expect(swap).toMatchObject({ code: "InvalidInput", issues: [{ path: "spec_url", message: SPEC_URL_NEEDS_ATTESTED }] });
    const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge, specHash: new Uint8Array(32), judgeFee: 0n } as const;
    await expect(publishedUrl(transport, params, SPEC_URL)).rejects.toMatchObject({ issues: [{ path: "spec_url", message: ZERO_SPEC_HASH }] });
    await expect(publishedUrl(transport, { ...params, specHash: new Uint8Array(32).fill(1) }, SPEC_URL)).resolves.toBe(SPEC_URL);
  });
});

describe("the wallet escrow warns when no reader can get the spec", () => {
  let client: Client;
  let owner: Address;

  beforeEach(async () => {
    client = await fresh();
    h.genesis = DEVNET_GENESIS_HASH;
    owner = (await walletOk(client, "wallet_setup"))["address"] as Address;
    h.specPages.set(SPEC_URL, new TextEncoder().encode(SPEC));
  });

  const terms = (more: object) => ({ sell: "SOL", amount: "0.01", attestor: owner, spec_hash: HASH, ...more });

  it("for a spec kept off the mirror with no url", async () => {
    const off = await walletOk(client, "wallet_escrow", terms({ spec_text: SPEC, publish_spec: false }));
    expect(off["warnings"]).toContain(noReader(UPLOAD_OFF));
    const withUrl = await walletOk(client, "wallet_escrow", terms({ spec_text: SPEC, spec_url: SPEC_URL, publish_spec: false }));
    expect(withUrl["warnings"]).not.toContain(noReader(UPLOAD_OFF));
  });

  it("for a sealed spec with no url, which is never uploaded", async () => {
    const judge = (await generateKeyPairSigner()).address;
    const sealed = new TextDecoder().decode(await seal(new TextEncoder().encode(SPEC), [judge]));
    const shownSealed = await walletOk(client, "wallet_escrow", { ...terms({}), spec_hash: sha(sealed), spec_text: sealed });
    expect((shownSealed["warnings"] as string[]).some((line) => line.startsWith("this escrow publishes the spec nowhere: the spec is sealed"))).toBe(true);
  });

  it("not for a spec that uploads, and for each piece of a plan that does not", async () => {
    const mirrored = await walletOk(client, "wallet_escrow", terms({ spec_text: SPEC }));
    expect((mirrored["warnings"] as string[]).some((line) => line.startsWith("this escrow publishes"))).toBe(false);
    const plan = await walletOk(client, "wallet_escrow_plan", {
      sell: "SOL",
      attestor: owner,
      publish_spec: false,
      pieces: [
        { name: "parser", amount: "0.01", spec_hash: HASH, spec_text: SPEC },
        { name: "page", amount: "0.01", spec_hash: HASH, spec_text: SPEC, spec_url: SPEC_URL },
      ],
    });
    expect(plan["warnings"]).toContain(`Piece 1 (parser): ${noReader(UPLOAD_OFF)}`);
    expect(plan["warnings"]).not.toContain(`Piece 2 (page): ${noReader(UPLOAD_OFF)}`);
  });
});

describe("words", () => {
  it("names only fields a receipt has, and says what was tried when an escrow has no spec url", () => {
    expect(paidOther(["a" as Address], "b" as Address)).not.toContain("valid");
    const said = "is not a proof escrow, or no source asked served its spec";
    expect(noSpecUrl("x" as Address)).toContain(said);
    expect(noSpecUrl("x" as Address)).not.toMatch(/Arweave|IPFS|mirror/);
    expect(SERVER_PROBLEMS.NoSpecUrl.hint).toContain("no source asked served its spec");
    expect(SERVER_PROBLEMS.NoSpecUrl.hint).not.toContain("publishes no spec url");
    expect(readFileSync(new URL("../src/sealed-commands.ts", import.meta.url), "utf8")).toContain(said);
  });

  it("answers help for an unknown command with the fact and a failing exit code, and still answers the known ones", async () => {
    const unknown = await cli(["help", "nosuch"], {});
    expect([unknown.code, unknown.out, unknown.err]).toEqual([EXIT_USAGE, "", "no command named nosuch; run help to list the commands"]);
    expect((await cli(["help", "create"], {})).code).toBe(EXIT_OK);
    expect((await cli(["help"], {})).code).toBe(EXIT_OK);
    for (const known of ["claims", "profile", "mandate", "committee", "sandbox", "signed", "version", "show", "solver", "judge"]) {
      expect((await cli(["help", known], {})).code, known).toBe(EXIT_OK);
    }
  });
});
