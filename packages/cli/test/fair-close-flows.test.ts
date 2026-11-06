import { createHash } from "node:crypto";
import { type Address, getBase58Decoder, type KeyPairSigner, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, IntentStatus, NATIVE_MINT } from "@intent-engine/core";
import { deliveryBookAddress, getDeliveryBookSize, V1_BOOK_SPACE } from "@intent-engine/core/internal";
import { createClient } from "@intent-engine/client/node";
import { NOTICE_SECS } from "@intent-engine/client/internal";
import { svmTransport } from "@intent-engine/client/svm";
import { tool } from "../src/agent/names.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { requestLines } from "../src/cancel-steps.js";
import { DEFAULT_REVIEW_SECS, reviewLine } from "../src/fair-lines.js";
import { EXIT_FAILED, EXIT_OK } from "../src/main.js";
import { defaultWallet } from "../src/wallet.js";
import { cli, DOMAIN, funded, h, HOME, setNow, world } from "./harness.js";
import { approved, UNJUDGED } from "./approved.js";

type Json = Record<string, unknown>;

const SPEC_HASH = "6c".repeat(32);
const WORK = "a7".repeat(32);
const WORK_URL = "https://" + "example.org/work-4b1e7d0c95fa";
const STAKE = 50_000_000n;
const SPEC_TEXT = new TextEncoder().encode("# Job\n\nDeliver a module that answers 42.\n");
const SPEC_URL = "https://" + "spec.example.org/" + "f".repeat(32) + ".md";

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

const now = (): bigint => h.svm.getClock().unixTimestamp;
const balance = (wallet: Address): bigint => h.svm.getBalance(wallet) ?? 0n;

describe("fair closing through the MCP tools and the CLI", () => {
  let client: Client;
  let hirer: Address;
  let hirerKey: string;
  const sdk = () => createClient({ url: "devnet", transport: svmTransport(h.svm, { genesisHash: getBase58Decoder().decode(DOMAIN) }) });

  const useKey = (signer: KeyPairSigner) => h.files.set(defaultWallet(HOME), JSON.stringify(Array.from(h.keypairs.get(signer.address) ?? [])));
  const asHirer = () => h.files.set(defaultWallet(HOME), hirerKey);
  const escrow = async (claims: object | null) => {
    asHirer();
    const terms = { sell: "SOL", amount: "0.05", attestor: hirer, spec_hash: SPEC_HASH, ...(claims ?? {}) };
    return ok(client, "wallet_escrow", await approved(client, "wallet_escrow", terms));
  };
  const deliver = async (worker: KeyPairSigner, intent: Address) => {
    useKey(worker);
    h.svm.warpToSlot(h.svm.getClock().slot + 1n);
    return ok(client, "wallet_deliver", await approved(client, "wallet_deliver", { intent, sha256: WORK, url: WORK_URL }));
  };
  const claimed = async (worker: KeyPairSigner, nonce: unknown) => {
    useKey(worker);
    const taken = { owner: hirer, nonce, action: "take", secs: 600 };
    const preview = await ok(client, "wallet_claim", taken);
    expect(await ok(client, "wallet_claim", await approved(client, "wallet_claim", taken))).toMatchObject({ sent: true });
    return preview;
  };

  beforeEach(async () => {
    await world();
    h.files.clear();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    h.through = svmTransport(h.svm, { genesisHash: getBase58Decoder().decode(DOMAIN) });
    client = await connect();
    hirer = (await ok(client, "wallet_setup"))["address"] as Address;
    hirerKey = h.files.get(defaultWallet(HOME)) ?? "";
  });

  it("hires with review terms: the default review window and a kill fee equal to the stake open with the escrow, in its own transaction", async () => {
    const preview = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: hirer, spec_hash: SPEC_HASH, claim_stake: "0.05", claim_secs: 3600 });
    expect(preview["summary"]).toContain(reviewLine(DEFAULT_REVIEW_SECS, STAKE));
    const made = await escrow({ claim_stake: "0.05", claim_secs: 3600 });
    const ref = { owner: hirer, nonce: BigInt(made["nonce"] as string) };
    expect(await sdk().claims(ref)).toMatchObject({ reviewSecs: DEFAULT_REVIEW_SECS, killFee: STAKE, stake: STAKE });
    const events = (await sdk().history(made["intent"] as Address)).events;
    const opened = events.find(({ name }) => name === "ClaimsOpened");
    expect(opened?.signature).toBe(events.find(({ name }) => name === "IntentCreated")?.signature);
    expect(((await sdk().intent(ref))?.intent.expiresAt ?? 0n) - now()).toBeGreaterThanOrEqual(BigInt(DEFAULT_REVIEW_SECS + 3600));
    const off = await escrow({ claim_stake: "0.05", claim_secs: 3600, review_secs: 0 });
    expect(await sdk().claims({ owner: hirer, nonce: BigInt(off["nonce"] as string) })).toMatchObject({ reviewSecs: 0, killFee: 0n });
    const tight = await call(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: hirer, spec_hash: SPEC_HASH, claim_stake: "0.05", claim_secs: 3600, expires_in: 3600 });
    expect(tight).toMatchObject({ error: true, value: { code: "InvalidInput", issues: [{ path: "expires_in" }] } });
  });

  it("claims and announces with the protection shown first, sees the review armed, and pays on the judge's pass with the kill fee kept", async () => {
    const made = await escrow({ claim_stake: "0.05", claim_secs: 3600 });
    const intent = made["intent"] as Address;
    const worker = await funded();
    const take = await claimed(worker, made["nonce"]);
    expect((take["summary"] as string[]).some((line) => line.startsWith("Protected: an announcement by"))).toBe(true);
    const jobs = await ok(client, "find_jobs", { all: true });
    expect((jobs["jobs"] as Json[]).find((job) => job["intent"] === intent)).toMatchObject({ review_secs: DEFAULT_REVIEW_SECS, kill_fee: String(STAKE), review_until: null });
    const shown = await ok(client, "wallet_deliver", { intent, sha256: WORK, url: WORK_URL });
    expect(shown).toMatchObject({ protected: true });
    const done = await deliver(worker, intent);
    expect(done).toMatchObject({ sent: true, protected: true });
    const board = await ok(client, "get_claims", { owner: hirer, nonce: made["nonce"] });
    expect(board).toMatchObject({ review_secs: DEFAULT_REVIEW_SECS, review: { announcement: done["announcement"], lapsed: false } });
    asHirer();
    const before = balance(worker.address);
    const release = { ...UNJUDGED, owner: hirer, nonce: made["nonce"], delivered_sha256: WORK };
    expect(await ok(client, "wallet_attest", await approved(client, "wallet_attest", release))).toMatchObject({ sent: true, pay_to: worker.address });
    expect(balance(worker.address) - before).toBe(STAKE);
    expect(await sdk().claims({ owner: hirer, nonce: BigInt(made["nonce"] as string) })).toMatchObject({ review: null, killFee: STAKE });
  });

  it("rejects as the judge only with a receipt or a reason, and returns the holder's stake", async () => {
    const made = await escrow({ claim_stake: "0.05", claim_secs: 3600 });
    const intent = made["intent"] as Address;
    const worker = await funded();
    await claimed(worker, made["nonce"]);
    const done = await deliver(worker, intent);
    asHirer();
    const target = { owner: hirer, nonce: made["nonce"], announcement: done["announcement"], delivered_sha256: WORK };
    expect(await call(client, "wallet_reject", target)).toMatchObject({ error: true, value: { code: "NoJudgeReceipt" } });
    const before = balance(worker.address);
    const sent = await ok(client, "wallet_reject", await approved(client, "wallet_reject", { ...target, ...UNJUDGED }));
    expect(sent).toMatchObject({ sent: true, worker: worker.address, unchecked: { reason: UNJUDGED.without_receipt } });
    expect(balance(worker.address) - before).toBe(STAKE);
    expect((await sdk().announcements(intent)).announcements.map(({ state }) => state)).toEqual(["rejected"]);
    expect(await call(client, "wallet_reject", { ...target, ...UNJUDGED })).toMatchObject({ error: true, value: { code: "NotRejectable" } });
    useKey(worker);
    const history = await ok(client, "wallet_history");
    expect((history["work"] as Json[])[0]).toMatchObject({ announcement: done["announcement"], paid: false, unpaid_reason: "rejected", review: "armed" });
  });

  it("collects the stake and the kill fee once the review lapses with no decision", async () => {
    const made = await escrow({ claim_stake: "0.05", claim_secs: 3600 });
    const worker = await funded();
    await claimed(worker, made["nonce"]);
    const done = await deliver(worker, made["intent"] as Address);
    const collect = { owner: hirer, nonce: made["nonce"], action: "collect" };
    const early = await call(client, "wallet_claim", collect);
    expect(early).toMatchObject({ error: true, value: { code: "NothingToCollect", hint: expect.stringContaining("review running") } });
    setNow(now() + BigInt(DEFAULT_REVIEW_SECS));
    expect(await ok(client, "get_claims", { owner: hirer, nonce: made["nonce"] })).toMatchObject({ review: { lapsed: true } });
    const shown = await ok(client, "wallet_claim", collect);
    expect(shown["summary"]).toEqual(expect.arrayContaining([expect.stringContaining(`for ${worker.address}, whose delivery ${String(done["announcement"])}`)]));
    const before = balance(worker.address);
    expect(await ok(client, "wallet_claim", await approved(client, "wallet_claim", collect))).toMatchObject({ sent: true });
    expect(balance(worker.address) - before).toBe(2n * STAKE - 5_000n);
    expect(await ok(client, "get_claims", { owner: hirer, nonce: made["nonce"] })).toMatchObject({ state: "free", review: null, kill_fee: "0" });
    const receipt = await ok(client, "get_receipt", { owner: hirer, nonce: made["nonce"] });
    expect(receipt).toMatchObject({ released: false, lapsed: [done["announcement"]] });
  });

  it("cancels an announced escrow in two steps over MCP, refusing during the notice, and at once without an announcement", async () => {
    const plain = await escrow(null);
    asHirer();
    expect(await ok(client, "wallet_cancel", { nonce: plain["nonce"] })).toMatchObject({ stage: "now" });
    expect(await ok(client, "wallet_cancel", { nonce: plain["nonce"], send: true })).toMatchObject({ sent: true });
    const made = await escrow(null);
    const intent = made["intent"] as Address;
    await deliver(await funded(), intent);
    asHirer();
    const first = await ok(client, "wallet_cancel", { nonce: made["nonce"] });
    const state = await sdk().cancelState(intent);
    expect(first).toMatchObject({ stage: "request", refund: "0", summary: requestLines(state) });
    const asked = await ok(client, "wallet_cancel", { nonce: made["nonce"], send: true });
    expect(asked).toMatchObject({ sent: true, stage: "request" });
    expect(await call(client, "wallet_cancel", { nonce: made["nonce"] })).toMatchObject({ error: true, value: { code: "CancelNoticeRunning", hint: expect.stringContaining(`${NOTICE_SECS} more seconds`) } });
    setNow(now() + NOTICE_SECS);
    expect(await ok(client, "wallet_cancel", { nonce: made["nonce"], send: true })).toMatchObject({ sent: true, stage: "now" });
    expect((await sdk().intent(intent))).toBeNull();
  });

  it("cancels in two steps in the CLI, migrating a version 1 delivery book in the request", async () => {
    const made = await escrow(null);
    const intent = made["intent"] as Address;
    await deliver(await funded(), intent);
    const book = await deliveryBookAddress(intent);
    const view = h.svm.getAccount(book);
    if (!view.exists) {
      throw new Error("no book");
    }
    const data = Uint8Array.from(view.data).slice(0, V1_BOOK_SPACE);
    data[8 + 80] = 1;
    h.svm.setAccount({ ...view, data, space: BigInt(V1_BOOK_SPACE) });
    h.files.set("owner.json", hirerKey);
    const args = ["cancel", "--url", "devnet", "--keypair", "owner.json", "--nonce", String(made["nonce"])];
    const preview = await cli(args, {});
    expect(preview.code).toBe(EXIT_OK);
    expect(preview.json()).toMatchObject({ stage: "request", sent: false });
    expect((preview.json()["summary"] as string[]).some((line) => line.startsWith("Migrates:"))).toBe(true);
    const asked = await cli([...args, "--yes"], {});
    expect([asked.code, asked.err]).toEqual([EXIT_OK, ""]);
    const migrated = h.svm.getAccount(book);
    expect(migrated.exists ? migrated.data.length : 0).toBe(getDeliveryBookSize());
    const early = await cli([...args, "--yes"], {});
    expect(early.code).toBe(EXIT_FAILED);
    expect(early.err).toContain("more seconds");
    setNow(now() + NOTICE_SECS);
    const done = await cli([...args, "--yes"], {});
    expect([done.code, done.err]).toEqual([EXIT_OK, ""]);
    expect((await sdk().intent(intent))?.intent.status).toBe(IntentStatus.Cancelled);
  });

  it("opens claims in the CLI with the default review terms, and refuses them once work was announced", async () => {
    const plain = await escrow(null);
    h.files.set("owner.json", hirerKey);
    const open = (nonce: unknown, extra: string[] = []) => cli(["claims", "open", "--url", "devnet", "--keypair", "owner.json", "--nonce", String(nonce), "--max-secs", "600", "--stake", "0.05", ...extra, "--yes"], {});
    const opened = await open(plain["nonce"]);
    expect([opened.code, opened.err]).toEqual([EXIT_OK, ""]);
    expect(await sdk().claims({ owner: hirer, nonce: BigInt(plain["nonce"] as string) })).toMatchObject({ reviewSecs: DEFAULT_REVIEW_SECS, killFee: STAKE });
    const announced = await escrow(null);
    await deliver(await funded(), announced["intent"] as Address);
    const late = await open(announced["nonce"], ["--review-secs", "0"]);
    expect(late.code).toBe(EXIT_FAILED);
    expect(late.err).toContain("claims open only before the first announcement");
  });

  it("binds the deliver approval to whether the announcement arms a review", async () => {
    const made = await escrow({ claim_stake: "0.05", claim_secs: 3600 });
    const intent = made["intent"] as Address;
    const worker = await funded();
    await claimed(worker, made["nonce"]);
    useKey(worker);
    const terms = { intent, sha256: WORK, url: WORK_URL };
    const shown = await ok(client, "wallet_deliver", terms);
    expect(shown).toMatchObject({ protected: true });
    setNow(now() + 601n);
    const late = await call(client, "wallet_deliver", { ...terms, approval: shown["approval"], send: true });
    expect(late).toMatchObject({ error: true, value: { code: "ReleaseChanged" } });
    expect((await ok(client, "wallet_deliver", terms))["protected"]).toBe(false);
  });

  it("shows a local worker's protection before it funds a stake, and claims for no longer than leaves the judge its window", async () => {
    h.specPages.set(SPEC_URL, SPEC_TEXT);
    asHirer();
    const specHash = createHash("sha256").update(SPEC_TEXT).digest("hex");
    const terms = { sell: "SOL", amount: "0.05", attestor: hirer, spec_hash: specHash, spec_url: SPEC_URL, claim_stake: "0.05", claim_secs: 3600, review_secs: 3600, expires_in: 7200 };
    const made = await ok(client, "wallet_escrow", await approved(client, "wallet_escrow", terms));
    setNow(now() + 100n);
    const preview = await ok(client, "wallet_worker", { intent: made["intent"] });
    expect((preview["summary"] as string[]).some((line) => line.startsWith("Protected: an announcement by"))).toBe(true);
    const sent = await ok(client, "wallet_worker", { intent: made["intent"], approval: preview["approval"], send: true });
    const expires = (await sdk().intent(made["intent"] as Address))?.intent.expiresAt ?? 0n;
    const secs = Number(expires - now()) - 10 - 3600;
    expect(secs).toBeLessThan(3600);
    expect(String(sent["brief"])).toContain(`--secs ${secs}`);
    expect((sent["summary"] as string[]).some((line) => line.startsWith("Protected:"))).toBe(true);
  });
});