import { createHash } from "node:crypto";
import { type Address, getBase58Decoder, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { delivery, DEVNET_TEST_MINT, Kind, NATIVE_MINT } from "@intent-engine/core";
import { createClient, loadAnnouncement, loadDeliveryBook } from "@intent-engine/client";
import { svmTransport } from "@intent-engine/client/svm";
import { tool } from "../src/agent/names.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { EXIT_OK, main } from "../src/main.js";
import { keyed } from "./announce.js";
import { cli, DOMAIN, h, NOW, runtime, setNow, world } from "./harness.js";

type Json = Record<string, unknown> & { [key: string]: any };

const WORK = createHash("sha256").update("shared work").digest("hex");
const url = (name: string) => "https://" + "work.example.org/" + name;

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

async function server(home: string): Promise<Client> {
  h.served.length = 0;
  const err: string[] = [];
  const code = await main(["mcp", "--url", "devnet", "--wallet", "--all-tools"], { ...runtime({}), home }, { out: () => undefined, err: (t) => err.push(t) });
  expect([code, err.join("\n")]).toEqual([EXIT_OK, WALLET_NOTICE.join("\n")]);
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

describe("refuting and reclaiming with the wallet tools", () => {
  it("refutes the release that paid a later announcement, reclaims the rent after the window, and closes the empty book", async () => {
    const w = await world();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    const through = svmTransport(h.svm, { genesisHash: getBase58Decoder().decode(DOMAIN) });
    h.through = through;
    const judge = await keyed("judge.json");
    const client = createClient({ url: "http://cluster", transport: through });
    const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: new Uint8Array(32).fill(4), judgeFee: 0n } as const;
    const { intent } = await client.createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
    const early = await server("/home/early");
    const earlyWallet = (await ok(early, "wallet_setup"))["address"] as Address;
    const first = await ok(early, "wallet_deliver", { intent, sha256: WORK, url: url("early.tar"), send: true });
    const later = await keyed();
    const second = await client.announce({ worker: later, intent, sha256: WORK, url: url("later.tar") });
    await client.settleProof({ judge, payer: judge, owner: w.owner.address, nonce: 0n, announcement: second.announcement, opening: { sha256: WORK, salt: second.salt }, result: 1n });
    const wrongUrl = await call(early, "wallet_refute", { earlier: first["announcement"], paid: second.announcement, url: url("other.tar") });
    expect(wrongUrl.value).toMatchObject({ code: "NotRefutable" });
    const preview = await ok(early, "wallet_refute", { earlier: first["announcement"], paid: second.announcement, url: url("early.tar") });
    expect(preview).toMatchObject({ sent: false, sha256: WORK, intent });
    const refuted = await ok(early, "wallet_refute", { earlier: first["announcement"], paid: second.announcement, url: url("early.tar"), send: true });
    expect(refuted).toMatchObject({ sent: true, refutation: preview["refutation"] });
    const standing = await ok(early, "get_reputation", { worker: later.address });
    expect(standing["records"]).toEqual([expect.objectContaining({ announcement: second.announcement, role: "announcer", refuted_by: refuted["refutation"], refutations: [expect.objectContaining({ earlier: first["announcement"], earlier_worker: earlyWallet, standing: "substantiated" })] })]);
    setNow(NOW + 3_600n + delivery.REFUTE_WINDOW_SECS + 60n);
    const shown = await ok(early, "wallet_reclaim");
    expect(shown).toMatchObject({ sent: false, closing: [first["announcement"]], closable: 1 });
    expect(await ok(early, "wallet_reclaim", { send: true })).toMatchObject({ sent: true, closing: [first["announcement"]] });
    expect(await loadAnnouncement(through, first["announcement"] as Address)).toBeNull();
    expect((await call(early, "wallet_reclaim")).value).toMatchObject({ code: "NothingToReclaim" });
    await client.reclaim({ worker: later });
    expect((await loadDeliveryBook(through, intent))?.live).toBe(0n);
    const closing = await cli(["close-book", "--keypair", "judge.json", "--intent", intent], {});
    expect([closing.code, closing.err]).toEqual([EXIT_OK, ""]);
    expect(closing.json()).toMatchObject({ sent: false, intent });
    const closed = await cli(["close-book", "--keypair", "judge.json", "--intent", intent, "--yes"], {});
    expect(closed.json()).toMatchObject({ sent: true });
    expect(await loadDeliveryBook(through, intent)).toBeNull();
  });
});
