import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createKeyPairSignerFromBytes, getAddressDecoder } from "@solana/kit";
import { describe, expect, it, vi } from "vitest";
import {
  attestedResult,
  DEVNET_TEST_MINT,
  eventNamed,
  findAssociatedTokenAddress,
  findProgramDataAddress,
  IntentStatus,
  NATIVE_MINT,
  parseAmount,
  TOKEN_PROGRAM_ADDRESS,
} from "@intent-engine/core";
import { chainTime, DEVNET_GENESIS_HASH } from "../src/index.js";
import { createTestWorld, DEVNET_FEES, ENGINE_PROGRAM_FILE, shippedProgram, shippedProgramPath } from "../src/testing.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? join(HERE, "..", "..", "..");
const PACKAGE = join(HERE, "..");
const PROGRAM_DATA_HEADER = 45;
const NOW = 1_700_000_000n;

type Deployed = {
  programHash: string;
  config: {
    admin: string;
    pendingAdmin: string;
    guardian: string;
    feeRecipient: string;
    feeBps: number;
    kindFeeMask: number;
    kindFeeBps: number[];
    partnerCutBps: number;
    crankBounty: number;
    createFee: number;
    enabledKinds: string;
    fillDisabledKinds: string;
    paused: number;
    capsRequired: number;
    version: number;
    domain: number[];
  };
};

const DEVNET = JSON.parse(readFileSync(join(ROOT, "monitoring", "devnet.json"), "utf8")) as Deployed;

function executableHash(bytes: Uint8Array, from = 0): string {
  let end = bytes.length;
  while (end > from && bytes[end - 1] === 0) {
    end--;
  }
  return createHash("sha256").update(bytes.subarray(from, end)).digest("hex");
}

const sha256 = (bytes: number[]) => createHash("sha256").update(Uint8Array.from(bytes)).digest("hex");

describe("the engine program the client package ships", () => {
  it("lives in the package and is the program deployed on devnet: its executable hash equals programHash in monitoring/devnet.json", () => {
    expect(shippedProgramPath()).toBe(join(PACKAGE, ENGINE_PROGRAM_FILE));
    expect(executableHash(shippedProgram())).toBe(DEVNET.programHash);
  });

  it("hashes the way solana-verify get-executable-hash does: trailing zero bytes are dropped, inner zero bytes kept", () => {
    expect(executableHash(Uint8Array.from([7, 0, 9, 0, 0, 0]))).toBe(sha256([7, 0, 9]));
    expect(executableHash(Uint8Array.from([7, 0, 9]))).toBe(sha256([7, 0, 9]));
    expect(executableHash(Uint8Array.from([1, 2, 3, 0, 5, 0]), 3)).toBe(sha256([0, 5]));
  });

  it("is replaced on the next deploy by a step beside the upgrade steps in the operations page", () => {
    const page = readFileSync(join(ROOT, "docs", "maintainers", "operations.md"), "utf8");
    const upgrade = /^## Upgrade\n[\s\S]*?(?=^## )/m.exec(page)?.[0] ?? "";
    expect(upgrade).toContain(`cp verifiable/intent_engine.so packages/client/${ENGINE_PROGRAM_FILE}`);
    expect(upgrade).toContain(`solana-verify get-executable-hash packages/client/${ENGINE_PROGRAM_FILE}`);
    expect(upgrade).toContain("monitor --write-baseline monitoring/devnet.json --url devnet");
    expect(upgrade.indexOf(`packages/client/${ENGINE_PROGRAM_FILE}`)).toBeGreaterThan(upgrade.indexOf("solana-verify get-program-hash --url devnet"));
  });

  it("is the program a test world runs, read back from its program data account", async () => {
    const world = await createTestWorld();
    const data = world.svm.getAccount(await findProgramDataAddress());
    expect(data.exists).toBe(true);
    expect(data.exists ? executableHash(new Uint8Array(data.data), PROGRAM_DATA_HEADER) : "").toBe(DEVNET.programHash);
  });
});

describe("createTestWorld", () => {
  it("initializes the config the way devnet has it, with the world's admin as admin and guardian", async () => {
    const world = await createTestWorld();
    const config = await world.client.config();
    const { admin: _admin, pendingAdmin, guardian: _guardian, feeRecipient: _feeRecipient, ...settings } = DEVNET.config;
    const { feeBps, kindFeeMask, kindFeeBps, partnerCutBps, crankBounty, createFee } = settings;
    expect(DEVNET_FEES).toEqual({ feeBps, kindFeeMask, kindFeeBps, partnerCutBps, crankBounty, createFee });
    expect({
      feeBps: config.feeBps,
      kindFeeMask: config.kindFeeMask,
      kindFeeBps: [...config.kindFeeBps],
      partnerCutBps: config.partnerCutBps,
      crankBounty: config.crankBounty,
      createFee: config.createFee,
      enabledKinds: config.enabledKinds.toString(),
      fillDisabledKinds: config.fillDisabledKinds.toString(),
      paused: config.paused,
      capsRequired: config.capsRequired,
      version: config.version,
      domain: [...config.domain],
    }).toEqual(settings);
    expect([config.admin, config.guardian, config.feeRecipient, config.pendingAdmin]).toEqual([world.admin.address, world.admin.address, world.feeRecipient.address, pendingAdmin]);
    expect(await world.transport.genesisHash()).toBe(DEVNET_GENESIS_HASH);
  });

  it("takes the start time and the fee schedule, and keeps devnet's for what it is not given", async () => {
    const world = await createTestWorld({ start: NOW, fees: { feeBps: 7, kindFeeBps: [1, 2, 3, 4], createFee: 1_000 } });
    const config = await world.client.config();
    expect([config.feeBps, [...config.kindFeeBps], config.createFee, config.crankBounty, config.partnerCutBps]).toEqual([7, [1, 2, 3, 4], 1_000, 100_000, 2_000]);
    expect(world.fees).toEqual({ ...DEVNET_FEES, feeBps: 7, kindFeeBps: [1, 2, 3, 4], createFee: 1_000 });
    expect(world.now()).toBe(NOW);
    expect(await chainTime(world.transport)).toBe(NOW);
  });

  it("holds devnet's wrapped SOL and TEST mints, with TEST minted by the admin, unless told not to", async () => {
    const world = await createTestWorld();
    const test = await world.transport.getAccount(DEVNET_TEST_MINT);
    expect(test?.owner).toBe(TOKEN_PROGRAM_ADDRESS);
    expect(test === null ? null : getAddressDecoder().decode(test.data.subarray(4, 36))).toBe(world.admin.address);
    expect((await world.transport.getAccount(NATIVE_MINT))?.owner).toBe(TOKEN_PROGRAM_ADDRESS);
    const bare = await createTestWorld({ devnetMints: false });
    expect(await bare.transport.getAccount(DEVNET_TEST_MINT)).toBeNull();
  });

  it("starts at the wall clock when given no start", async () => {
    const before = BigInt(Math.floor(Date.now() / 1000));
    const world = await createTestWorld();
    expect(world.now()).toBeGreaterThanOrEqual(before);
    expect(world.now()).toBeLessThanOrEqual(BigInt(Math.ceil(Date.now() / 1000)));
  });

  it("funds wallets that carry their key bytes, makes mints and token accounts, and reads token balances", async () => {
    const world = await createTestWorld({ start: NOW });
    const rich = await world.wallet("2.5");
    const plain = await world.wallet();
    expect(world.svm.getBalance(rich.address)).toBe(2_500_000_000n);
    expect(world.svm.getBalance(plain.address)).toBe(10_000_000_000n);
    expect((await createKeyPairSignerFromBytes(rich.keypair)).address).toBe(rich.address);
    const nine = await world.mint();
    const six = await world.mint(6);
    expect(await world.client.mint(nine)).toEqual({ decimals: 9, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect((await world.client.mint(six)).decimals).toBe(6);
    expect((await world.client.mint(NATIVE_MINT)).decimals).toBe(9);
    expect((await world.client.mint(DEVNET_TEST_MINT)).decimals).toBe(9);
    const account = await world.tokens(rich.address, six, 1_234n);
    expect(account).toBe(await findAssociatedTokenAddress({ owner: rich.address, mint: six, tokenProgram: TOKEN_PROGRAM_ADDRESS }));
    await world.tokens(rich.address, NATIVE_MINT, 5_000n);
    await world.tokens(rich.address, DEVNET_TEST_MINT, 7n);
    await world.tokens(rich.address, six, 6n);
    expect(await Promise.all([six, NATIVE_MINT, DEVNET_TEST_MINT, nine].map((mint) => world.tokenBalance(rich.address, mint)))).toEqual([1_240n, 5_000n, 7n, 0n]);
    expect(await world.tokenBalance(plain.address, six)).toBe(0n);
  });

  it("moves the clock the engine reads with warp: an escrow expires and the engine accepts the expiry", async () => {
    const world = await createTestWorld({ start: NOW });
    const owner = await world.wallet();
    const cranker = await world.wallet();
    const judge = await world.wallet();
    const params = attestedResult({ amountIn: parseAmount("0.1", 9), minResult: 1n, maxResult: 1n, attestor: judge.address, specHash: new Uint8Array(32).fill(3), judgeFee: 0n });
    const job = await world.client.createIntent({ signer: owner, inputMint: NATIVE_MINT, outputMint: DEVNET_TEST_MINT, params, expiresIn: 600n });
    const early = await world.client.expire(cranker, owner.address, job.nonce).catch((error: unknown) => error);
    expect(world.client.explain(early)?.name).toBe("NotExpired");
    expect(world.warp(599)).toBe(NOW + 599n);
    expect(world.client.explain(await world.client.expire(cranker, owner.address, job.nonce).catch((error: unknown) => error))?.name).toBe("NotExpired");
    expect(world.warp(1n)).toBe(NOW + 600n);
    expect(await chainTime(world.transport)).toBe(NOW + 600n);
    await world.client.expire(cranker, owner.address, job.nonce);
    expect((await world.client.intent(owner.address, job.nonce))?.intent.status).toBe(IntentStatus.Expired);
    expect(eventNamed(await world.client.history(job.intent), "IntentExpired")?.name).toBe("IntentExpired");
    expect(await world.tokenBalance(owner.address, NATIVE_MINT)).toBe(parseAmount("0.1", 9));
  });

  it("reaches no network while it builds a world and runs the client on it", async () => {
    const fetch = vi.fn(async () => new Response("refused", { status: 599 }));
    vi.stubGlobal("fetch", fetch);
    try {
      const world = await createTestWorld();
      const owner = await world.wallet();
      await world.client.config();
      await world.client.createIntent({
        signer: owner,
        inputMint: NATIVE_MINT,
        outputMint: DEVNET_TEST_MINT,
        params: attestedResult({ amountIn: 1_000_000n, minResult: 1n, maxResult: 1n, attestor: (await world.wallet()).address, specHash: new Uint8Array(32).fill(1), judgeFee: 0n }),
      });
      expect(await world.client.intents({ owner: owner.address })).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
