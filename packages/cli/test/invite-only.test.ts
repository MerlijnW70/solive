import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, generateKeyPairSigner, getAddressDecoder, type KeyPairSigner, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, Kind, NATIVE_MINT } from "@intent-engine/core";
import { seal, specMemo } from "@intent-engine/core/internal";
import { createClient } from "@intent-engine/client/node";
import { WALLET_NOTICE } from "../src/agent/wallet.js";
import { specSealedHint } from "../src/agent/spec.js";
import { SERVER_PROBLEMS } from "../src/agent/problems.js";
import { notInvited } from "../src/invites.js";
import { jobClosed } from "../src/sealed-commands.js";
import { EXIT_FAILED, EXIT_OK } from "../src/main.js";
import { announced, keyed } from "./announce.js";
import { cli, creation, funded, h, NOW, ownerSigned, transport, world } from "./harness.js";
import { approved } from "./approved.js";

type Json = Record<string, unknown>;

const CASES = '{"cases": [{"args": [""], "expected": 0}, {"args": ["one"], "expected": 1}]}';
const SPEC = `# Count words\n\n\`\`\`judge-cases\n${CASES}\n\`\`\`\n`;
const COUNT = "export default function count(text) { const words = text.match(/\\S+/g); return words === null ? 0 : words.length; }\n";
const SPEC_URL = "https://example.org/jobs/spec.sealed";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function wallet(): Address {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  return getAddressDecoder().decode(Uint8Array.from(Buffer.from(jwk.x ?? "", "base64url")));
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

async function connect(argv: string[]): Promise<Client> {
  h.served.length = 0;
  const started = await cli(argv, {});
  expect([started.code, started.err]).toEqual([EXIT_OK, argv.includes("--wallet") ? WALLET_NOTICE.join("\n") : ""]);
  const [near, far] = InMemoryTransport.createLinkedPair();
  await h.served[0]?.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return client;
}

async function call(client: Client, name: string, args: object = {}) {
  const result = await client.callTool({ name: `solive_${name}`, arguments: args as Record<string, unknown> });
  return { error: result.isError === true, value: result.structuredContent as Json };
}

describe("an invite-only job through MCP", () => {
  it("opens for an invited server wallet and releases only to an invited worker", async () => {
    await world();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    const client = await connect(["mcp", "--url", "devnet", "--wallet", "--all-tools"]);
    const owner = (await call(client, "wallet_setup")).value["address"] as Address;
    const [workerKey, strangerKey] = [await keyed(), await keyed()];
    const [worker, stranger] = [workerKey.address, strangerKey.address];
    h.specPages.set(SPEC_URL, await seal(new TextEncoder().encode(SPEC), [owner, worker]));
    const escrow = await call(client, "wallet_escrow", await approved(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: owner, spec_hash: sha(SPEC), spec_url: SPEC_URL }));
    expect(escrow.error, JSON.stringify(escrow.value)).toBe(false);
    const intent = escrow.value["intent"] as Address;
    h.engineLog.push({ ...creation(intent), ...ownerSigned(intent, [specMemo(SPEC_URL)]) });

    expect(await call(client, "get_spec", { intent })).toEqual({
      error: false,
      value: { url: SPEC_URL, sha256: sha(SPEC), matches: true, text: SPEC, sealed_to: [owner, worker], freeze_authority: null },
    });
    const release = { owner, nonce: escrow.value["nonce"] };
    const copied = sha("stranger's work");
    await announced(intent, strangerKey, copied, "https://" + "example.org/stranger.mjs");
    expect(await call(client, "wallet_attest", { ...release, delivered_sha256: copied })).toEqual({
      error: true,
      value: { code: "NotInvited", retryable: SERVER_PROBLEMS.NotInvited.retryable, hint: notInvited(stranger, intent) },
    });
    const work = sha(COUNT);
    await announced(intent, workerKey, work, "https://" + "example.org/count.mjs");
    const shown = await call(client, "wallet_attest", { ...release, delivered_sha256: work });
    expect(shown.error, JSON.stringify(shown.value)).toBe(false);
    expect(shown.value).toMatchObject({ intent, pay_to: worker, sent: false });
  });

  it("tells a server without a wallet that the spec is sealed and who may read it", async () => {
    const w = await world();
    const client = await connect(["mcp", "--url", "devnet"]);
    const invited = [wallet(), wallet()];
    h.specPages.set(SPEC_URL, await seal(new TextEncoder().encode(SPEC), invited));
    const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: w.authority.address, specHash: new Uint8Array(createHash("sha256").update(SPEC).digest()), judgeFee: 0n } as const;
    const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
    h.engineLog.push({ ...creation(intent), ...ownerSigned(intent, [specMemo(SPEC_URL)]) });
    expect(await call(client, "get_spec", { intent })).toEqual({
      error: true,
      value: { code: "SpecSealed", retryable: false, hint: specSealedHint(2, false), untrustedDetail: SPEC_URL },
    });
  });
});

describe("judging an invite-only job", () => {
  it("refuses to pay a worker the spec was not sealed to and judges an invited one", async () => {
    const w = await world();
    const judge = await funded();
    const dir = await mkdtemp(join(tmpdir(), "invite-only-"));
    const spec = join(dir, "spec.md");
    await writeFile(spec, SPEC);
    const artifact = join(dir, "count.mjs");
    await writeFile(artifact, COUNT);
    const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: new Uint8Array(createHash("sha256").update(SPEC).digest()), judgeFee: 0n } as const;
    const deliveredBy = async (worker: KeyPairSigner, invited: Address[], nonce: bigint) => {
      const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce, expiresAt: NOW + 3_600n });
      h.specPages.set(SPEC_URL, await seal(new TextEncoder().encode(SPEC), invited));
      h.engineLog = [{ ...creation(intent), ...ownerSigned(intent, [specMemo(SPEC_URL)]) }];
      await announced(intent, worker, sha(COUNT), "https://" + "example.org/count.mjs");
      const judging = ["judge", "--keypair", "judge.json", "--owner", w.owner.address, "--nonce", String(nonce), "--spec", spec, "--artifact", artifact, "--sandbox", "viper"];
      return { intent, run: await cli(judging, { "judge.json": judge }) };
    };
    const [invitedWorker, outsider] = [await keyed(), await keyed()];
    const refused = await deliveredBy(outsider, [judge.address, invitedWorker.address], 0n);
    expect([refused.run.code, refused.run.err]).toEqual([EXIT_FAILED, notInvited(outsider.address, refused.intent)]);
    const judged = await deliveredBy(invitedWorker, [judge.address, invitedWorker.address], 1n);
    expect([judged.run.code, judged.run.err]).toEqual([EXIT_OK, ""]);
    expect(judged.run.json()).toMatchObject({ intent: judged.intent, verdict: "pass", payTo: invitedWorker.address, signature: null });
  }, 60_000);
});

describe("reading the spec of a closed job", () => {
  it("names the job closed instead of asking for a spec url", async () => {
    await world();
    const client = await connect(["mcp", "--url", "devnet"]);
    const gone = wallet();
    expect(await call(client, "get_spec", { intent: gone })).toEqual({
      error: true,
      value: { code: "NotFound", retryable: SERVER_PROBLEMS.NotFound.retryable, hint: jobClosed(gone) },
    });
  });
});
