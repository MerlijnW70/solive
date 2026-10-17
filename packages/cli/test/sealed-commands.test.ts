import { generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Address, generateKeyPairSigner, getAddressDecoder, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { DEVNET_TEST_MINT, Kind, NATIVE_MINT, seal, specMemo } from "@intent-engine/core";
import { createClient } from "@intent-engine/client";
import { ENV_KEYPAIR, ENV_URL } from "../src/args.js";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE } from "../src/main.js";
import { jobClosed } from "../src/sealed-commands.js";
import { ata, cli, creation, funded, h, NOW, transport, world } from "./harness.js";

function keyed(path: string): Address {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  const bytes = [...Buffer.from(jwk.d ?? "", "base64url"), ...Buffer.from(jwk.x ?? "", "base64url")];
  h.files.set(path, JSON.stringify(bytes));
  return getAddressDecoder().decode(Uint8Array.from(bytes.slice(32)));
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

describe("seal and unseal", () => {
  it("seal a file to wallets so each can unseal it and nobody else can", async () => {
    await world();
    const [a, b] = [keyed("a.json"), keyed("b.json")];
    keyed("c.json");
    const dir = await mkdtemp(join(tmpdir(), "sealed-"));
    const plain = join(dir, "spec.md");
    await writeFile(plain, "Write answer.txt holding 42.\n");
    const sealedPath = join(dir, "spec.sealed");
    const sealed = await cli(["seal", "--file", plain, "--to", `${a},${b},${a}`, "--out", sealedPath], {});
    expect([sealed.code, sealed.err]).toEqual([EXIT_OK, ""]);
    expect(sealed.json()).toMatchObject({ out: sealedPath, to: [a, b] });
    const plainHash = (await cli(["hash", "--artifact", plain], {})).json()["sha256"];
    expect(sealed.json()["sha256"]).toBe(plainHash);
    expect(sealed.json()["sealed_sha256"]).toBe((await cli(["hash", "--artifact", sealedPath], {})).json()["sha256"]);
    expect(await readFile(sealedPath, "utf8")).not.toContain("answer.txt");

    for (const [who, file] of [["a.json", "a.md"], ["b.json", "b.md"]] as const) {
      const opened = await cli(["unseal", "--file", sealedPath, "--keypair", who, "--out", join(dir, file)], {});
      expect([opened.code, opened.err]).toEqual([EXIT_OK, ""]);
      expect(opened.json()).toEqual({ out: join(dir, file), sha256: plainHash });
      expect(await readFile(join(dir, file), "utf8")).toBe("Write answer.txt holding 42.\n");
    }
    const refused = await cli(["unseal", "--file", sealedPath, "--keypair", "c.json", "--out", join(dir, "c.md")], {});
    expect(refused.code).toBe(EXIT_FAILED);
    expect(refused.err).toContain("is not one of the wallets this was sealed to; nothing was written");
    expect(existsSync(join(dir, "c.md"))).toBe(false);

    const again = await cli(["unseal", "--file", sealedPath, "--keypair", "a.json", "--out", join(dir, "a.md")], {});
    expect(again.code).toBe(EXIT_FAILED);
    const notSealed = await cli(["unseal", "--file", plain, "--keypair", "a.json", "--out", join(dir, "x.md")], {});
    expect([notSealed.code, notSealed.err]).toEqual([EXIT_FAILED, `${plain}: this is not a sealed file`]);
  });

  it("refuse a missing option or a recipient that is not an address", async () => {
    await world();
    for (const argv of [
      ["seal", "--file", "x", "--to", "not-a-wallet", "--out", "y"],
      ["seal", "--file", "x", "--out", "y"],
      ["seal", "--file", "x", "--to", ",", "--out", "y"],
      ["unseal", "--file", "x", "--out", "y"],
      ["spec"],
    ]) {
      expect((await cli(argv, {})).code, argv.join(" ")).toBe(EXIT_USAGE);
    }
  });
});

describe("spec", () => {
  it("reads a job's sealed spec with an invited wallet and refuses everyone else", async () => {
    const w = await world();
    const owner = await funded();
    preset(NATIVE_MINT);
    preset(DEVNET_TEST_MINT);
    await ata(w.authority, w.feeRecipient.address, NATIVE_MINT);
    const worker = keyed("worker.json");
    keyed("stranger.json");
    const text = "Write answer.txt holding 42.\n";
    const url = "https://example.org/jobs/spec.sealed";
    const sealed = await seal(new TextEncoder().encode(text), [worker, owner.address]);
    h.specPages.set(url, sealed);
    h.env[ENV_URL] = "devnet";
    h.env[ENV_KEYPAIR] = "owner.json";
    const keys = { "owner.json": owner };
    const dir = await mkdtemp(join(tmpdir(), "spec-"));
    await writeFile(join(dir, "spec.md"), text);
    const specHash = (await cli(["hash", "--artifact", join(dir, "spec.md")], keys)).json()["sha256"] as string;
    const made = await cli(
      ["create", "attested", "--input-mint", "SOL", "--output-mint", "TEST", "--units", "tokens", "--amount-in", "0.01", "--min-result", "1", "--max-result", "1", "--attestor", owner.address, "--spec-hash", specHash, "--spec-url", url, "--expires-in", "86400", "--yes"],
      keys,
    );
    expect([made.code, made.err]).toEqual([EXIT_OK, ""]);
    const intent = made.json()["intent"] as string;
    h.engineLog.push({ ...creation(intent as Address), memos: [specMemo(url)] });
    delete h.env[ENV_KEYPAIR];

    const read = await cli(["spec", "--intent", intent, "--keypair", "worker.json"], keys);
    expect([read.code, read.err]).toEqual([EXIT_OK, ""]);
    expect(read.json()).toEqual({ url, sha256: specHash, matches: true, sealed_to: [worker, owner.address], text });
    const out = join(dir, "got.md");
    expect((await cli(["spec", "--intent", intent, "--keypair", "worker.json", "--out", out], keys)).json()).toEqual({ url, sha256: specHash, matches: true, sealed_to: [worker, owner.address], out });
    expect(await readFile(out, "utf8")).toBe(text);

    const unkeyed = await cli(["spec", "--intent", intent], keys);
    expect([unkeyed.code, unkeyed.err]).toEqual([EXIT_FAILED, `the spec at ${url} is sealed to 2 invited wallets; read it with the key of an invited wallet`]);
    const stranger = await cli(["spec", "--intent", intent, "--keypair", "stranger.json"], keys);
    expect([stranger.code, stranger.err]).toEqual([EXIT_FAILED, `the spec at ${url} is sealed to 2 invited wallets; this wallet is not one of them`]);
    const none = await cli(["spec", "--intent", owner.address], keys);
    expect([none.code, none.err]).toEqual([EXIT_FAILED, `the escrow ${owner.address} publishes no spec url, or is not a proof escrow; ask its owner for the spec`]);
  }, 60_000);

  it("says when a job's spec cannot be fetched", async () => {
    const w = await world();
    const owner = await funded();
    const url = "https://down.example/spec.md";
    const params = { kind: Kind.AttestedResult, amountIn: 100n, minResult: 1n, maxResult: 1n, attestor: owner.address, specHash: new Uint8Array(32).fill(7), judgeFee: 0n } as const;
    const { intent } = await createClient({ url: "http://cluster", transport }).createIntent({ signer: w.owner, params, inputMint: w.inputMint, outputMint: w.outputMint, nonce: 0n, expiresAt: NOW + 3_600n });
    h.engineLog.push({ ...creation(intent), memos: [specMemo(url)] });
    const read = await cli(["spec", "--intent", intent], {});
    expect([read.code, read.err]).toEqual([EXIT_FAILED, `the spec at ${url} could not be fetched`]);
  });

  it("says a job is closed when its escrow account is gone", async () => {
    await world();
    const gone = (await generateKeyPairSigner()).address;
    const read = await cli(["spec", "--intent", gone], {});
    expect([read.code, read.err]).toEqual([EXIT_FAILED, jobClosed(gone)]);
  });
});
