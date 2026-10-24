import { createHash, generateKeyPairSync } from "node:crypto";
import { type Address, getAddressDecoder, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, MAX_SEALED_RECIPIENTS, NATIVE_MINT, sealedTo, specMemo } from "@intent-engine/core";
import { SEAL_LIMIT, SEALED_NEXT, SEALED_UNCHECKED } from "../src/agent/wallet/seal.js";
import { EVERYDAY_TOOLS } from "../src/agent/everyday.js";
import { tool } from "../src/agent/names.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { EXIT_OK } from "../src/main.js";
import { cli, creation, h, ownerSigned, world } from "./harness.js";

type Json = Record<string, unknown>;

const SPEC = "# Count words\n\nDeliver count.mjs whose default export counts the words in a string.\n";
const SPEC_URL = "https://" + "example.org/jobs/count.sealed";
const sha = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");

function wallet(): Address {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  return getAddressDecoder().decode(Uint8Array.from(Buffer.from(jwk.x ?? "", "base64url")));
}

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

describe("sealing a spec for an invite-only job", () => {
  it("seals with the wallet tool, escrows it, and only an invited wallet reads it with get_spec", async () => {
    await world();
    h.files.clear();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    expect(EVERYDAY_TOOLS.has(tool("wallet_seal_spec"))).toBe(true);
    const owner = await connect();
    const judge = (await ok(owner, "wallet_setup"))["address"] as Address;
    const worker = wallet();
    const wires = h.wires.length;
    const sealed = await ok(owner, "wallet_seal_spec", { text: SPEC, invite: [worker] });
    expect(h.wires.length).toBe(wires);
    expect(sealed).toMatchObject({ sha256: sha(SPEC), sealed_to: [worker, judge], next: SEALED_NEXT });
    const bytes = new TextEncoder().encode(sealed["sealed"] as string);
    expect(sealed["sealed_sha256"]).toBe(sha(bytes));
    expect(sealedTo(bytes)).toEqual([worker, judge]);
    expect(new TextDecoder().decode(bytes)).not.toContain("Count words");
    h.specPages.set(SPEC_URL, bytes);
    const escrow = { sell: "SOL", amount: "0.05", attestor: judge, spec_hash: sealed["sha256"], spec_url: SPEC_URL };
    const preview = await ok(owner, "wallet_escrow", escrow);
    expect(JSON.stringify(preview["warnings"])).not.toContain("spec_url");
    const sent = await ok(owner, "wallet_escrow", { ...escrow, send: true });
    const intent = sent["intent"] as Address;
    h.engineLog.push({ ...creation(intent), ...ownerSigned(intent, [specMemo(SPEC_URL)]) });
    expect(await ok(owner, "get_spec", { intent })).toMatchObject({ url: SPEC_URL, sha256: sha(SPEC), matches: true, text: SPEC, sealed_to: [worker, judge] });

    h.files.clear();
    const stranger = await connect();
    const outsider = (await ok(stranger, "wallet_setup"))["address"] as Address;
    expect(outsider).not.toBe(judge);
    expect(await call(stranger, "get_spec", { intent })).toMatchObject({ error: true, value: { code: "SpecSealed" } });
    const unchecked = await ok(stranger, "wallet_escrow", { ...escrow, attestor: outsider });
    expect(unchecked["warnings"]).toContain(SEALED_UNCHECKED);
  });

  it("refuses more wallets than a sealed file holds, and seals to a named attestor", async () => {
    await world();
    h.files.clear();
    const client = await connect();
    const judge = (await ok(client, "wallet_setup"))["address"] as Address;
    const many = Array.from({ length: MAX_SEALED_RECIPIENTS }, wallet);
    expect((await call(client, "wallet_seal_spec", { text: SPEC, invite: many })).value).toMatchObject({ code: "InvalidInput", issues: [{ path: "invite", message: SEAL_LIMIT }] });
    const fits = await ok(client, "wallet_seal_spec", { text: SPEC, invite: [...many.slice(1), judge] });
    expect((fits["sealed_to"] as Address[]).length).toBe(MAX_SEALED_RECIPIENTS);
    const other = wallet();
    expect(await ok(client, "wallet_seal_spec", { text: SPEC, invite: [other], attestor: other })).toMatchObject({ sealed_to: [other] });
  });
});
