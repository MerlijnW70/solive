import { createHash } from "node:crypto";
import { type Address, generateKeyPairSigner, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { claimBoardAddress, DEVNET_TEST_MINT, Kind, NATIVE_MINT, profileAddress } from "@intent-engine/core";
import { createClient } from "@intent-engine/client";
import { coolingDown, heldBy, NO_PROFILE, noClaims } from "../src/claim-commands.js";
import { CLAIM_CHANGED } from "../src/agent/work-claims.js";
import { PROFILE_CHANGED } from "../src/agent/profile.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { NOT_SENT } from "../src/flows.js";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "../src/main.js";
import { cli, funded, h, NOW, setNow, transport, world } from "./harness.js";

type Json = Record<string, unknown> & { [key: string]: any };

const STAKE = 50_000_000n;
const SPEC = new Uint8Array(createHash("sha256").update("the claimed job").digest());

async function job() {
  const w = await world();
  const [worker, rival, payer] = await Promise.all([funded(), funded(), funded()]);
  const judge = (await generateKeyPairSigner()).address;
  const client = createClient({ url: "http://cluster", transport });
  const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge, specHash: SPEC, judgeFee: 0n } as const;
  const { intent } = await client.createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
  const keys = { "owner.json": w.owner, "worker.json": worker, "rival.json": rival, "payer.json": payer };
  const ref = ["--owner", w.owner.address, "--nonce", "0"];
  const run = (args: string[]) => cli(args, keys);
  const open = () => run(["claims", "open", "--keypair", "owner.json", "--nonce", "0", "--max-secs", "3600", "--stake", "0.05", "--yes"]);
  const show = async () => (await run(["claims", "show", ...ref])).json();
  const sol = (address: Address) => h.svm.getBalance(address) ?? 0n;
  return { w, client, intent, worker, rival, payer, ref, run, open, show, sol };
}

describe("job claims from the command line", () => {
  it("claims take refuses before sending when another worker holds the claim", async () => {
    const j = await job();
    expect((await j.open()).code).toBe(EXIT_OK);
    const taken = await j.run(["claims", "take", "--keypair", "worker.json", ...j.ref, "--secs", "600", "--yes"]);
    expect([taken.code, taken.err]).toEqual([EXIT_OK, ""]);
    const before = j.sol(j.rival.address);
    for (const yes of [[], ["--yes"]]) {
      const refused = await j.run(["claims", "take", "--keypair", "rival.json", ...j.ref, "--secs", "60", ...yes]);
      expect(refused.code).toBe(EXIT_FAILED);
      expect(refused.err).toContain(heldBy(j.intent, j.worker.address, 600n));
    }
    expect(j.sol(j.rival.address)).toBe(before);
    expect(await j.show()).toMatchObject({ state: "held", worker: j.worker.address, seconds_left: "600" });
  });

  it("claims open, take, drop and settle send the program's instructions after a preview", async () => {
    const j = await job();
    const board = await claimBoardAddress(j.intent);
    const none = await j.run(["claims", "show", ...j.ref]);
    expect([none.code, none.err]).toEqual([EXIT_FAILED, noClaims(j.intent)]);
    const preview = await j.run(["claims", "open", "--keypair", "owner.json", "--nonce", "0", "--max-secs", "3600", "--stake", "0.05"]);
    expect(preview.json()).toMatchObject({ intent: j.intent, board, sent: false, next: NOT_SENT });
    expect(h.svm.getAccount(board).exists).toBe(false);
    expect((await j.run(["claims", "open", "--keypair", "owner.json", "--nonce", "0", "--max-secs", "3600", "--stake", "101"])).code).toBe(EXIT_USAGE);
    expect((await j.open()).json()).toMatchObject({ sent: true, signature: expect.any(String) });
    expect(await j.show()).toMatchObject({ intent: j.intent, board, state: "free", worker: null, stake: STAKE.toString(), max_secs: 3600, owner: j.w.owner.address });

    const take = ["claims", "take", "--keypair", "worker.json", ...j.ref, "--secs", "600"];
    expect((await j.run(take)).json()).toMatchObject({ state: "free", sent: false, next: NOT_SENT });
    expect((await j.run(["claims", "take", "--keypair", "worker.json", ...j.ref, "--secs", "3601"])).code).toBe(EXIT_FAILED);
    const staked = j.sol(j.worker.address);
    expect((await j.run([...take, "--yes"])).json()).toMatchObject({ sent: true });
    expect(await j.show()).toMatchObject({ state: "held", worker: j.worker.address, until: (NOW + 600n).toString(), seconds_left: "600" });
    expect(staked - j.sol(j.worker.address)).toBeGreaterThanOrEqual(STAKE);

    const drop = ["claims", "drop", "--keypair", "worker.json", ...j.ref];
    expect((await j.run(["claims", "drop", "--keypair", "rival.json", ...j.ref, "--yes"])).code).toBe(EXIT_FAILED);
    expect((await j.run(drop)).json()).toMatchObject({ state: "held", sent: false });
    const held = j.sol(j.worker.address);
    expect((await j.run([...drop, "--yes"])).json()).toMatchObject({ sent: true });
    expect(j.sol(j.worker.address) - held).toBeGreaterThan(STAKE - 100_000n);
    expect(await j.show()).toMatchObject({ state: "free", worker: null });

    const settle = ["claims", "settle", "--keypair", "payer.json", ...j.ref];
    expect((await j.run(settle)).code).toBe(EXIT_FAILED);
    const again = await j.run([...take, "--yes"]);
    expect([again.code, again.err]).toEqual([EXIT_FAILED, coolingDown(j.intent, j.worker.address, NOW + 600n)]);
    expect(await j.show()).toMatchObject({ state: "free", cooldown: { worker: j.worker.address, until: (NOW + 600n).toString() } });
    expect((await j.run(["claims", "take", "--keypair", "rival.json", ...j.ref, "--secs", "600", "--yes"])).code).toBe(EXIT_OK);
    expect((await j.run(settle)).err).toContain("settle once it lapses or the escrow closes");
    const before = j.sol(j.rival.address);
    await j.client.cancel(j.w.owner, { owner: j.w.owner.address, nonce: 0n });
    expect(j.sol(j.rival.address) - before).toBe(STAKE);
    const shown = (await j.run(settle)).json();
    expect(shown).toMatchObject({ sent: false, next: NOT_SENT });
    expect(shown["summary"]).toContain("Moves: no stake; nobody holds the claim");
    expect((await j.run([...settle, "--yes"])).json()).toMatchObject({ sent: true });
    expect(h.svm.getAccount(board).exists).toBe(false);
  });

  it("claims take allows the longest claim, ends a lapsed one, and settle moves its stake while the escrow is open", async () => {
    const j = await job();
    expect((await j.open()).code).toBe(EXIT_OK);
    const settle = ["claims", "settle", "--keypair", "payer.json", ...j.ref];
    const idle = await j.run(settle);
    expect([idle.code, idle.err]).toEqual([EXIT_FAILED, `escrow ${j.intent} is open and nobody holds its claim, so there is nothing to settle; nothing was sent`]);
    expect((await j.run(["claims", "take", "--keypair", "worker.json", ...j.ref, "--secs", "3600"])).json()).toMatchObject({ sent: false, next: NOT_SENT });
    expect((await j.run(["claims", "take", "--keypair", "worker.json", ...j.ref, "--secs", "600", "--yes"])).json()).toMatchObject({ sent: true });
    const rival = await j.run(["claims", "drop", "--keypair", "rival.json", ...j.ref]);
    expect([rival.code, rival.err]).toEqual([EXIT_FAILED, `${j.rival.address} holds no claim on escrow ${j.intent}; nothing was sent`]);
    setNow(NOW + 600n);
    const lapsed = await j.run(["claims", "drop", "--keypair", "worker.json", ...j.ref]);
    expect([lapsed.code, lapsed.err]).toEqual([EXIT_FAILED, `${j.worker.address} holds no claim on escrow ${j.intent}; nothing was sent`]);
    const taken = (await j.run(["claims", "take", "--keypair", "rival.json", ...j.ref, "--secs", "60"])).json();
    expect(taken).toMatchObject({ state: "lapsed", sent: false });
    expect(taken["summary"]).toContain(`Ends: the lapsed claim of ${j.worker.address}, whose stake goes to the owner ${j.w.owner.address}`);
    const moved = (await j.run(settle)).json();
    expect(moved).toMatchObject({ sent: false, next: NOT_SENT });
    expect((moved["summary"] as string[])[0]).toBe(`Moves: the stake of 0.05 SOL to ${j.w.owner.address}`);
  });

  it("profile set creates a profile and then updates it", async () => {
    const j = await job();
    const wallet = j.worker.address;
    const set = ["profile", "set", "--keypair", "worker.json", "--skills", "rust,code-review", "--endpoint", "https://worker.example/jobs"];
    const missing = await j.run(["profile", "show", "--wallet", wallet]);
    expect([missing.code, missing.err]).toEqual([EXIT_FAILED, `${wallet} ${NO_PROFILE}`]);
    const created = (await j.run(set)).json();
    expect(created).toMatchObject({ wallet, profile: await profileAddress(wallet), action: "create", sent: false, next: NOT_SENT });
    expect(created["summary"]).toEqual([
      `Creates: the profile of ${wallet} at ${await profileAddress(wallet)}`,
      "Skills: rust, code-review",
      "Endpoint: https://worker.example/jobs",
      "Document: none",
      `Pays rent: ${wallet}`,
    ]);
    expect((await j.run(["profile", "show", "--wallet", wallet])).code).toBe(EXIT_FAILED);
    expect((await j.run([...set, "--yes"])).json()).toMatchObject({ action: "create", sent: true });
    expect((await j.run(["profile", "show", "--wallet", wallet])).json()).toEqual({
      wallet,
      profile: await profileAddress(wallet),
      skills: ["rust", "code-review"],
      endpoint: "https://worker.example/jobs",
      doc_url: null,
      doc_sha256: null,
      encryption_key: null,
      updated_at: NOW.toString(),
    });
    const doc = ["--doc-url", "https://worker.example/about", "--doc-sha256", "AB".repeat(32)];
    const update = ["profile", "set", "--keypair", "worker.json", "--skills", "rust", "--endpoint", "https://worker.example/v2", ...doc, "--yes"];
    const updated = (await j.run(update)).json();
    expect(updated).toMatchObject({ action: "update", sent: true });
    expect(updated["summary"]).toEqual([
      `Updates: the profile of ${wallet} at ${await profileAddress(wallet)}`,
      "Skills: rust",
      "Endpoint: https://worker.example/v2",
      "Document: https://worker.example/about with sha256 " + "ab".repeat(32),
    ]);
    expect((await j.run(["profile", "show", "--wallet", wallet])).json()).toMatchObject({
      skills: ["rust"],
      endpoint: "https://worker.example/v2",
      doc_url: "https://worker.example/about",
      doc_sha256: "ab".repeat(32),
    });
    for (const bad of [[...set, "--doc-url", "https://worker.example/about"], [...set.slice(0, 5), "Rust", ...set.slice(6)], ["profile", "set", "--keypair", "worker.json", "--skills", "rust", "--endpoint", "http://x"]]) {
      expect((await j.run(bad)).code).toBe(EXIT_USAGE);
    }
    expect((await j.run(["profile", "close", "--keypair", "worker.json", "--yes"])).json()).toMatchObject({ sent: true });
    expect((await j.run(["profile", "show", "--wallet", wallet])).code).toBe(EXIT_FAILED);
  });
});

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
  const started = await cli(["mcp", "--url", "devnet", "--wallet", "--all-tools"], {});
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

describe("job claims and profiles over MCP", () => {
  it("the claim and profile MCP tools preview until send with the approval", async () => {
    const j = await job();
    h.files.clear();
    for (const name of Object.keys(h.env)) {
      delete h.env[name];
    }
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    const client = await connect();
    const wallet = (await ok(client, "wallet_setup"))["address"] as Address;
    const escrow = { owner: j.w.owner.address, nonce: "0" };
    expect(await ok(client, "get_claims", escrow)).toEqual({ intent: j.intent, takes_claims: false, escrow: "open" });
    expect((await call(client, "wallet_claim", { ...escrow, action: "take", secs: 600 })).value).toMatchObject({ code: "ClaimsMissing", hint: noClaims(j.intent) });
    expect((await j.open()).code).toBe(EXIT_OK);
    expect(await ok(client, "get_claims", escrow)).toMatchObject({ takes_claims: true, state: "free", worker: null, stake: STAKE.toString(), max_secs: 3600 });

    const take = { ...escrow, action: "take", secs: 600 };
    const preview = await ok(client, "wallet_claim", take);
    expect(preview).toMatchObject({ intent: j.intent, action: "take", sent: false });
    expect(await ok(client, "get_claims", escrow)).toMatchObject({ state: "free" });
    expect((await call(client, "wallet_claim", { ...take, send: true })).value).toMatchObject({ code: "ReleaseChanged", hint: CLAIM_CHANGED });
    expect((await call(client, "wallet_claim", { ...take, secs: 601, approval: preview["approval"], send: true })).value).toMatchObject({ code: "ReleaseChanged" });
    expect(await ok(client, "wallet_claim", { ...take, approval: preview["approval"], send: true })).toMatchObject({ sent: true, signature: expect.any(String) });
    expect(await ok(client, "get_claims", escrow)).toMatchObject({ state: "held", worker: wallet, seconds_left: "600" });
    expect((await call(client, "wallet_claim", take)).value).toMatchObject({ code: "ClaimHeld", hint: heldBy(j.intent, wallet, 600n) });
    const drop = await ok(client, "wallet_claim", { ...escrow, action: "drop" });
    expect(drop).toMatchObject({ action: "drop", sent: false });
    expect(await ok(client, "wallet_claim", { ...escrow, action: "drop", approval: drop["approval"], send: true })).toMatchObject({ sent: true });
    expect(await ok(client, "get_claims", escrow)).toMatchObject({ state: "free", worker: null });

    const profile = await profileAddress(wallet);
    expect(await ok(client, "get_profile", { wallet })).toEqual({ wallet, profile, published: false });
    const fields = { skills: ["rust", "review"], endpoint: "https://agent.example/work" };
    expect((await call(client, "wallet_profile", { ...fields, skills: ["Rust"] })).value).toMatchObject({ code: "ProfileInvalid" });
    const shown = await ok(client, "wallet_profile", fields);
    expect(shown).toMatchObject({ wallet, profile, action: "create", sent: false });
    expect(await ok(client, "get_profile", { wallet })).toMatchObject({ published: false });
    expect((await call(client, "wallet_profile", { ...fields, endpoint: "https://agent.example/other", approval: shown["approval"], send: true })).value).toMatchObject({
      code: "ReleaseChanged",
      hint: PROFILE_CHANGED,
    });
    expect(await ok(client, "wallet_profile", { ...fields, approval: shown["approval"], send: true })).toMatchObject({ sent: true });
    expect(await ok(client, "get_profile", { wallet })).toMatchObject({ published: true, ...fields, doc_url: null, doc_sha256: null });
    const closing = await ok(client, "wallet_profile", { close: true });
    expect(closing).toMatchObject({ action: "close", sent: false });
    expect(await ok(client, "wallet_profile", { close: true, approval: closing["approval"], send: true })).toMatchObject({ sent: true });
    expect(await ok(client, "get_profile", { wallet })).toMatchObject({ published: false });
  });
});
