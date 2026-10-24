import { type Address, getBase58Decoder, type KeyPairSigner, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { buildClaimJob, DEVNET_TEST_MINT, findAssociatedTokenAddress, NATIVE_MINT } from "@intent-engine/core";
import { svmTransport } from "@intent-engine/client/svm";
import { tool } from "../src/agent/names.js";
import { claimedByOther, NO_CLAIM_HELD } from "../src/agent/job-claims.js";
import { ANNOUNCE_FIRST } from "../src/agent/wallet/delivery.js";
import { paidOther } from "../src/agent/wallet/receipt.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { EXIT_OK } from "../src/main.js";
import { defaultWallet } from "../src/wallet.js";
import { cli, DOMAIN, funded, h, HOME, NOW, send, setNow, world } from "./harness.js";

type Json = Record<string, unknown>;

const SPEC_HASH = "7d".repeat(32);
const WORK = "e5".repeat(32);
const WORK_URL = "https://" + "example.org/work-5f0c9a7e31d2";

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

async function ok(client: Client, name: string, args: object = {}): Promise<Json> {
  const result = await client.callTool({ name: tool(name), arguments: args as Record<string, unknown> });
  expect(result.isError === true, JSON.stringify(result.structuredContent)).toBe(false);
  return result.structuredContent as Json;
}

const useKey = (signer: KeyPairSigner) => h.files.set(defaultWallet(HOME), JSON.stringify(Array.from(h.keypairs.get(signer.address) ?? [])));

describe("a worker without the claim on a job that takes claims", () => {
  let client: Client;
  let payer: Address;
  let payerKey: string;

  const escrow = async (claims: boolean) =>
    ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: payer, spec_hash: SPEC_HASH, ...(claims ? { claim_stake: "0.05", claim_secs: 3600 } : {}), send: true });

  const announce = async (worker: KeyPairSigner, intent: Address) => {
    useKey(worker);
    h.svm.warpToSlot(h.svm.getClock().slot + 1n);
    return (await ok(client, "wallet_deliver", { intent, sha256: WORK, url: WORK_URL, send: true }))["signature"] as string;
  };

  beforeEach(async () => {
    await world();
    h.files.clear();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    h.through = svmTransport(h.svm, { genesisHash: getBase58Decoder().decode(DOMAIN) });
    client = await connect();
    payer = (await ok(client, "wallet_setup"))["address"] as Address;
    payerKey = h.files.get(defaultWallet(HOME)) ?? "";
    h.watched.push(payer);
  });

  it("is refused by deliver while another holds the claim, and told by the receipt and the history that the release paid the claiming worker", async () => {
    const claimed = await escrow(true);
    const free = await escrow(true);
    const plain = await escrow(false);
    const intent = claimed["intent"] as Address;
    const holder = await funded();
    await send(holder, [await buildClaimJob({ worker: holder, intent, owner: payer, secs: 600 })]);
    const until = BigInt((await ok(client, "get_claims", { owner: payer, nonce: claimed["nonce"] }))["until"] as string);
    const rival = await funded();

    useKey(rival);
    const refused = await client.callTool({ name: tool("wallet_deliver"), arguments: { intent, sha256: WORK, url: WORK_URL } });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({ code: "NotDeliverable", hint: expect.stringContaining(`is claimed by ${holder.address} until ${until}`) });
    expect(claimedByOther(holder.address, until, rival.address)).toContain(`this wallet ${rival.address} cannot be paid for this work`);
    const unclaimed = await ok(client, "wallet_deliver", { intent: free["intent"], sha256: WORK, url: WORK_URL });
    expect(unclaimed["warnings"]).toEqual([NO_CLAIM_HELD, ANNOUNCE_FIRST]);
    expect(NO_CLAIM_HELD).toContain("claim it with solive_wallet_claim before working on it");
    expect((await ok(client, "wallet_deliver", { intent: plain["intent"], sha256: WORK, url: WORK_URL }))["warnings"]).toEqual([ANNOUNCE_FIRST]);
    useKey(holder);
    expect((await ok(client, "wallet_deliver", { intent, sha256: WORK, url: WORK_URL }))["warnings"]).toEqual([ANNOUNCE_FIRST]);

    const first = await announce(holder, intent);
    const waiting = await announce(rival, plain["intent"] as Address);
    h.files.set(defaultWallet(HOME), payerKey);
    const release = { owner: payer, nonce: claimed["nonce"], delivered_sha256: WORK };
    const shown = await ok(client, "wallet_attest", release);
    expect(shown).toMatchObject({ pay_to: holder.address });
    expect(await ok(client, "wallet_attest", { ...release, approval: shown["approval"], send: true })).toMatchObject({ sent: true });

    useKey(rival);
    const receipt = await ok(client, "wallet_receipt", { owner: payer, nonce: claimed["nonce"], sha256: WORK });
    expect(receipt).toMatchObject({ released: true, paid_to: holder.address, matches: true, announcer: holder.address, paid_this_wallet: false, next: paidOther([holder.address], rival.address) });
    expect(receipt["next"]).toContain(`this release paid ${holder.address}, not this wallet ${rival.address}`);
    const both = await ok(client, "wallet_receipt", { owner: payer, nonce: plain["nonce"], also: [{ owner: payer, nonce: claimed["nonce"] }] });
    expect(both).toMatchObject({ released: true, owner: payer, nonce: claimed["nonce"], paid_to: holder.address, paid_this_wallet: false });
    expect(both["escrows"]).toEqual([
      expect.objectContaining({ owner: payer, nonce: plain["nonce"], intent: plain["intent"], released: false }),
      { owner: payer, nonce: claimed["nonce"], intent, released: true, paid_to: holder.address, paid_this_wallet: false },
    ]);
    expect(both["escrows"] as Json[]).not.toContainEqual(expect.objectContaining({ released: false, paid_to: expect.anything() }));

    const history = await ok(client, "wallet_history");
    expect(history["work"]).toEqual([expect.objectContaining({ intent: plain["intent"], signature: waiting, paid: false, unpaid_reason: "open", released_to: null })]);

    useKey(holder);
    const own = await ok(client, "wallet_receipt", { owner: payer, nonce: claimed["nonce"], sha256: WORK });
    expect(own).toMatchObject({ paid_to: holder.address, paid_this_wallet: true });
    expect(String(own["next"] ?? "")).not.toContain("not this wallet");
    expect((await ok(client, "wallet_history"))["work"]).toEqual([expect.objectContaining({ intent, signature: first, paid: true, unpaid_reason: null, released_to: null })]);

    h.files.set(defaultWallet(HOME), payerKey);
    const books = ((await ok(client, "wallet_history"))["activity"] as Json[]).filter((entry) => entry["kind"] === "AttestedResult");
    expect(books.length).toBeGreaterThan(0);
    expect(books.map((entry) => [entry["received"], entry["receive_token"]])).toEqual(books.map(() => [null, null]));
  });

  it("gives each unpaid announcement its reason: cancelled or expired", async () => {
    const cancelled = await escrow(false);
    const lost = await escrow(false);
    const lapsed = await escrow(false);
    const worker = await funded();
    await announce(worker, cancelled["intent"] as Address);
    await announce(worker, lost["intent"] as Address);
    await announce(worker, lapsed["intent"] as Address);
    h.files.set(defaultWallet(HOME), payerKey);
    for (const job of [cancelled, lost]) {
      expect(await ok(client, "wallet_cancel", { nonce: job["nonce"], send: true })).toMatchObject({ sent: true });
    }
    setNow(NOW + 366n * 86_400n);
    useKey(worker);
    const reasons = ((await ok(client, "wallet_history"))["work"] as Json[]).map((item) => [item["intent"], item["paid"], item["unpaid_reason"], item["released_to"]]);
    expect(reasons).toEqual([
      [lapsed["intent"], false, "expired", null],
      [lost["intent"], false, "cancelled", null],
      [cancelled["intent"], false, "cancelled", null],
    ]);
  });
});
