import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Address,
  createKeyPairSignerFromBytes,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase58Decoder,
  getProgramDerivedAddress,
  type KeyPairSigner,
  lamports,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
  getTokenDecoder,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { LiteSVM } from "litesvm";
import { expect } from "vitest";
import { findAssociatedTokenAddress, parseAmount } from "@intent-engine/core";
import { findConfigPda, findProgramDataAddress, INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core/internal";
import { createTestWorld, ECONOMICS_UNSET, TEST_WALLET_SOL } from "@intent-engine/client/testing";
import type { FaucetFetch } from "../src/faucet.js";
import type { Runtime } from "../src/commands.js";
import { main } from "../src/main.js";
import { collectDropped } from "./collect.js";
import { DOMAIN, enginePath, FEE_BPS, h, harnessLookup, HOME, NOW, saleBook, send } from "./harness-state.js";
import { fakeFetch, transport } from "./harness-transport.js";

export { DOMAIN, enginePath, ESCROW, FEE_BPS, h, harnessLookup, HOME, NOW, PACKET_LIMIT, PUBLIC_TEST_ADDRESS, saleBook, send } from "./harness-state.js";
export { creation, fakeFetch, ownerSigned, transport, unlisting } from "./harness-transport.js";

const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111" as Address;
const WALLET_LAMPORTS = 100_000_000_000n;

export const instant: { fetch: FaucetFetch | undefined } = { fetch: undefined };

export function runtime(signers: Record<string, KeyPairSigner>): Runtime {
  return {
    transport: (url) => {
      h.urls.push(url);
      return h.through ?? transport;
    },
    loadSigner: async (path) => {
      const signer = signers[path];
      if (signer !== undefined) {
        return signer;
      }
      const saved = h.files.get(path);
      if (saved === undefined) {
        throw new Error(`no signer ${path}`);
      }
      return createKeyPairSignerFromBytes(Uint8Array.from(JSON.parse(saved) as number[]));
    },
    specFetch: async (url, init) => {
      const reply = h.specReplies.get(url);
      if (reply !== undefined) {
        return reply(url, init);
      }
      const page = h.specPages.get(url);
      if (page === undefined) {
        throw new TypeError("fetch failed");
      }
      return new Response(page.slice());
    },
    lookup: harnessLookup,
    loadKeypair: async (path) => {
      const saved = h.files.get(path);
      const held = signers[path] === undefined ? undefined : h.keypairs.get(signers[path].address);
      if (saved === undefined && held !== undefined) {
        return held;
      }
      if (saved === undefined) {
        throw new Error(`no key file ${path}`);
      }
      return Uint8Array.from(JSON.parse(saved) as number[]);
    },
    readText: async (path) => {
      const text = h.files.get(path);
      if (text === undefined) {
        throw new Error(`no file ${path}`);
      }
      return text;
    },
    writeText: async (path, text) => {
      if (h.files.has(path)) {
        throw new Error(`${path} already exists`);
      }
      h.files.set(path, text);
    },
    saveText: async (path, text, secret) => {
      if (secret && h.files.has(path)) {
        throw new Error(`${path} already exists`);
      }
      h.files.set(path, text);
    },
    home: HOME,
    intentChanges: () => ({
      wait: async (seconds) => {
        h.waits.push(seconds);
        h.clock += h.steps.shift() ?? 0n;
        return h.waits.length < h.rounds ? (h.changed.shift() ?? []) : null;
      },
      close: () => {
        h.closed++;
      },
    }),
    sleep: async (seconds) => {
      h.sleeps.push(seconds);
      h.onSleep.shift()?.();
      return h.sleeps.length < h.rounds;
    },
    env: h.env,
    now: () => NOW + 1_000n + h.clock,
    fetch: fakeFetch,
    ...(instant.fetch === undefined ? {} : { faucetFetch: instant.fetch }),
    entropy: () => 3,
    serve: async (server) => {
      h.served.push(server);
    },
    platform: "linux",
    launch: async () => {
      throw new Error("the harness launches no programs");
    },
    saleBook,
  };
}

export async function funded(): Promise<KeyPairSigner> {
  const jwk = generateKeyPairSync("ed25519").privateKey.export({ format: "jwk" });
  const keypair = Uint8Array.from([...Buffer.from(jwk.d ?? "", "base64url"), ...Buffer.from(jwk.x ?? "", "base64url")]);
  const kp = await createKeyPairSignerFromBytes(keypair);
  h.keypairs.set(kp.address, keypair);
  h.svm.airdrop(kp.address, lamports(WALLET_LAMPORTS));
  return kp;
}

export function resetHarness(): void {
  h.keypairs.clear();
  rmSync(h.saleRoot, { recursive: true, force: true });
  h.saleRoot = mkdtempSync(join(tmpdir(), "solive-sales-"));
  h.genesis = getBase58Decoder().decode(DOMAIN);
  h.urls = [];
  h.watched = [];
  h.wires = [];
  h.jupiterReplies = [];
  h.specPages.clear();
  h.specReplies.clear();
  h.hosts.clear();
  h.lookups = [];
  h.fetched = [];
  h.requestedLimits = [];
  h.recentFees = [];
  h.feeQueries = [];
  h.sleeps = [];
  h.onSleep = [];
  h.waits = [];
  h.changed = [];
  h.submitted = [];
  h.steps = [];
  h.engineLog = [];
  h.requestedOf = [];
  h.simulated = [];
  h.served = [];
  h.airdrops = [];
  h.files.clear();
  h.reads.clear();
  h.touched = new Set();
  for (const key of Object.keys(h.env)) {
    delete h.env[key];
  }
  h.scans = 0;
  h.dropSubmits = false;
  h.clock = 0n;
  h.genesisReads = 0;
  h.failScans = 0;
  h.closed = 0;
  h.rounds = 0;
  h.firstSlot = 0n;
  h.through = null;
  h.sendFails = null;
  h.packetLimit = false;
  h.airdropRefused = false;
}

export async function boot(): Promise<KeyPairSigner> {
  resetHarness();
  collectDropped();
  h.svm = new LiteSVM().withPrecompiles();
  h.svm.addProgramFromFile(INTENT_ENGINE_PROGRAM_ADDRESS, enginePath);
  setNow(NOW);
  const upgrader = await funded();
  const programData = await findProgramDataAddress();
  expect(programData).toBe(
    (
      await getProgramDerivedAddress({
        programAddress: LOADER,
        seeds: [getAddressEncoder().encode(INTENT_ENGINE_PROGRAM_ADDRESS)],
      })
    )[0],
  );
  const account = h.svm.getAccount(programData);
  if (!account.exists) {
    throw new Error("program data missing");
  }
  const data = new Uint8Array(account.data);
  data[12] = 1;
  data.set(getAddressEncoder().encode(upgrader.address), 13);
  h.svm.setAccount({ ...account, data });
  return upgrader;
}

export function setNow(unixTimestamp: bigint): void {
  const clock = h.svm.getClock();
  clock.unixTimestamp = unixTimestamp;
  h.svm.setClock(clock);
}

export async function mint(payer: KeyPairSigner, decimals = 6): Promise<Address> {
  const m = await generateKeyPairSigner();
  const space = BigInt(getMintSize());
  await send(payer, [
    getCreateAccountInstruction({
      payer,
      newAccount: m,
      lamports: h.svm.minimumBalanceForRentExemption(space),
      space,
      programAddress: TOKEN_PROGRAM_ADDRESS,
    }),
    getInitializeMint2Instruction({ mint: m.address, decimals, mintAuthority: payer.address }),
  ]);
  return m.address;
}

export async function ata(payer: KeyPairSigner, owner: Address, m: Address, amount = 0n): Promise<Address> {
  const address = await findAssociatedTokenAddress({ owner, mint: m, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  await send(payer, [
    await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner, mint: m }),
    ...(amount > 0n ? [getMintToInstruction({ mint: m, token: address, mintAuthority: payer, amount })] : []),
  ]);
  return address;
}

export function balance(address: Address): bigint {
  const account = h.svm.getAccount(address);
  return account.exists ? getTokenDecoder().decode(account.data).amount : -1n;
}

export async function cli(argv: string[], signers: Record<string, KeyPairSigner>) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, runtime(signers), { out: (t) => out.push(t), err: (t) => err.push(t) });
  return {
    code,
    out: out.join("\n"),
    err: err.join("\n"),
    json: () => JSON.parse(out.join("\n")) as Record<string, unknown>,
    each: () => out.map((o) => JSON.parse(o) as Record<string, unknown>),
  };
}

export type World = {
  authority: KeyPairSigner;
  feeRecipient: KeyPairSigner;
  owner: KeyPairSigner;
  inputMint: Address;
  outputMint: Address;
  ownerInput: Address;
};

export async function world(): Promise<World> {
  resetHarness();
  collectDropped();
  const test = await createTestWorld({ start: NOW, fees: { ...ECONOMICS_UNSET, feeBps: FEE_BPS }, domain: DOMAIN, devnetMints: false, program: new Uint8Array(readFileSync(enginePath)) });
  h.svm = test.svm;
  h.touched.add((await findConfigPda())[0]);
  const topUp = WALLET_LAMPORTS - parseAmount(TEST_WALLET_SOL, 9);
  for (const signer of [test.admin, test.feeRecipient]) {
    h.keypairs.set(signer.address, signer.keypair);
    h.svm.airdrop(signer.address, lamports(topUp));
  }
  const authority = test.admin;
  const owner = await funded();
  const inputMint = await mint(authority);
  const outputMint = await mint(authority);
  const ownerInput = await ata(authority, owner.address, inputMint, 1_000n);
  await ata(authority, owner.address, outputMint);
  return { authority, feeRecipient: test.feeRecipient, owner, inputMint, outputMint, ownerInput };
}
