import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, generateKeyPairSigner, getProgramDerivedAddress, type KeyPairSigner, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { beforeEach, describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, NATIVE_MINT, sealedTo, sortMembers, specMemo, unseal } from "@intent-engine/core";
import { MAX_SPEC_BYTES } from "@intent-engine/client";
import { tool } from "../src/agent/names.js";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { EXIT_FAILED, EXIT_OK } from "../src/main.js";
import { sealedOverLimit } from "../src/sealed-commands.js";
import { defaultWallet } from "../src/wallet.js";
import { cli, creation, funded, h, HOME, world } from "./harness.js";

type Json = Record<string, unknown>;

const SPEC = "# Private job\n\nDeliver the report as one text file.\n";
const SPEC_URL = "https://" + "example.org/jobs/committee.sealed";
const sha = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
const bytesOf = (text: unknown) => new TextEncoder().encode(text as string);

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

const useKey = (signer: KeyPairSigner) => h.files.set(defaultWallet(HOME), JSON.stringify(Array.from(h.keypairs.get(signer.address) ?? [])));

async function committeeOf(members: readonly KeyPairSigner[]): Promise<Address> {
  const payer = await funded();
  const sorted = sortMembers(members.map(({ address }) => address));
  const created = await cli(
    ["committee", "create", "--url", "devnet", "--keypair", "payer.json", "--members", sorted.join(","), "--threshold", "2", "--fee-wallet", payer.address, "--yes"],
    { "payer.json": payer },
  );
  expect([created.code, created.err]).toEqual([EXIT_OK, ""]);
  return created.json()["committee"] as Address;
}

describe("sealing to a committee", () => {
  let client: Client;
  let members: KeyPairSigner[];
  let committee: Address;

  beforeEach(async () => {
    await world();
    h.files.clear();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    client = await connect();
    await ok(client, "wallet_setup");
    members = [await funded(), await funded(), await funded()];
    committee = await committeeOf(members);
  });

  it("seals a spec to the committee's members, so each member opens it with get_spec", async () => {
    const [owner, worker] = [await funded(), await funded()];
    useKey(owner);
    const sealed = await ok(client, "wallet_seal_spec", { text: SPEC, invite: [worker.address], attestor: committee });
    const sorted = sortMembers(members.map(({ address }) => address));
    expect(sealed["sealed_to"]).toEqual([worker.address, ...sorted]);
    expect(sealed["sealed_to"]).not.toContain(committee);
    const hosted = bytesOf(sealed["sealed"]);
    expect(sealedTo(hosted)).toEqual(sealed["sealed_to"]);
    h.specPages.set(SPEC_URL, hosted);
    const escrow = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: committee, spec_hash: sha(SPEC), spec_url: SPEC_URL, send: true });
    const intent = escrow["intent"] as Address;
    h.engineLog = [{ ...creation(intent), memos: [specMemo(SPEC_URL)] }];
    for (const reader of [...members, worker]) {
      useKey(reader);
      expect(await ok(client, "get_spec", { intent })).toMatchObject({ matches: true, text: SPEC, sealed_to: sealed["sealed_to"] });
    }
    useKey(owner);
    expect((await call(client, "get_spec", { intent })).value).toMatchObject({ code: "SpecSealed" });
  }, 60_000);

  it("seals work for a committee's escrow to its members", async () => {
    const owner = await funded();
    useKey(owner);
    h.specPages.set(SPEC_URL, bytesOf(SPEC));
    const escrow = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: committee, spec_hash: sha(SPEC), spec_url: SPEC_URL, send: true });
    const intent = escrow["intent"] as Address;
    h.engineLog = [{ ...creation(intent), memos: [specMemo(SPEC_URL)] }];
    const sealed = await ok(client, "wallet_seal_work", { intent, text: "the report\n" });
    expect(new Set(sealed["sealed_to"] as Address[])).toEqual(new Set(members.map(({ address }) => address)));
    for (const member of members) {
      expect(new TextDecoder().decode(await unseal(bytesOf(sealed["sealed"]), h.keypairs.get(member.address) ?? new Uint8Array()))).toBe("the report\n");
    }
  }, 60_000);

  it("refuses to seal a spec to an attestor off the ed25519 curve that is not a committee", async () => {
    const [account] = await getProgramDerivedAddress({ programAddress: (await generateKeyPairSigner()).address, seeds: ["not a committee"] });
    const refused = await call(client, "wallet_seal_spec", { text: SPEC, invite: [(await generateKeyPairSigner()).address], attestor: account });
    expect(refused.value).toMatchObject({ code: "InvalidInput", issues: [{ path: "invite" }] });
    expect(JSON.stringify(refused.value)).toContain(`${account} is off the ed25519 curve`);
  });

  it("seals a file with intent-engine seal to a committee's members, refuses an address off the curve, and warns when the file is too large to read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sealed-committee-"));
    const plain = join(dir, "spec.md");
    await writeFile(plain, SPEC);
    const out = join(dir, "spec.sealed");
    const sealed = await cli(["seal", "--url", "devnet", "--file", plain, "--to", committee, "--out", out], {});
    expect([sealed.code, sealed.err]).toEqual([EXIT_OK, ""]);
    const sorted = sortMembers(members.map(({ address }) => address));
    expect(sealed.json()).toMatchObject({ to: sorted });
    expect(sealed.json()["warnings"]).toBeUndefined();
    expect(sealedTo(new Uint8Array(await readFile(out)))).toEqual(sorted);
    const [account] = await getProgramDerivedAddress({ programAddress: committee, seeds: ["elsewhere"] });
    const refused = await cli(["seal", "--url", "devnet", "--file", plain, "--to", account, "--out", join(dir, "refused.sealed")], {});
    expect(refused.code).toBe(EXIT_FAILED);
    expect(refused.err).toContain(`${account} is off the ed25519 curve`);
    const big = join(dir, "big.md");
    await writeFile(big, "x".repeat(MAX_SPEC_BYTES));
    const large = await cli(["seal", "--url", "devnet", "--file", big, "--to", members[0]?.address ?? "", "--out", join(dir, "big.sealed")], {});
    expect([large.code, large.err]).toEqual([EXIT_OK, ""]);
    const size = (await readFile(join(dir, "big.sealed"))).length;
    expect(size).toBeGreaterThan(MAX_SPEC_BYTES);
    expect(large.json()["warnings"]).toEqual([sealedOverLimit(size)]);
  }, 60_000);
});
