import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Address,
  appendTransactionMessageInstructions,
  type Blockhash,
  createKeyPairSignerFromBytes,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase58Decoder,
  getBase64Encoder,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type Instruction,
  type KeyPairSigner,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  signTransactionMessageWithSigners,
  type TransactionSigner,
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
import { FailedTransactionMetadata, LiteSVM } from "litesvm";
import type { McpServer } from "@modelcontextprotocol/server";
import { expect } from "vitest";
import {
  ALL_KINDS_MASK,
  EVENT_IX_TAG,
  findAssociatedTokenAddress,
  findEventAuthorityPda,
  findIntentPda,
  findProgramDataAddress,
  getInitConfigInstructionAsync,
  getIntentCreatedEventEncoder,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  MANDATE_NONCE_BIT,
} from "@intent-engine/core";
import type { Fetch } from "@intent-engine/solver";
import type { EngineTransaction, SpecFetch, Transport } from "@intent-engine/client";
import type { Runtime } from "../src/commands.js";
import { main } from "../src/main.js";
import { fileSales } from "../src/agent/sales.js";
import { collectDropped } from "./collect.js";

const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111" as Address;
export const NOW = 1_700_000_000n;
export const FEE_BPS = 5;
export const ESCROW = 400n;
export const DOMAIN = new Uint8Array(32).fill(0x11);
export const enginePath =
  process.env["INTENT_ENGINE_SO"] ??
  fileURLToPath(new URL("../../../target/deploy/intent_engine.so", import.meta.url));

export const h = {
  keypairs: new Map<Address, Uint8Array>(),
  svm: new LiteSVM(),
  genesis: getBase58Decoder().decode(DOMAIN),
  urls: [] as string[],
  watched: [] as Address[],
  wires: [] as string[],
  jupiterReplies: [] as { status: number; body: unknown }[],
  specPages: new Map<string, Uint8Array>(),
  specReplies: new Map<string, SpecFetch>(),
  fetched: [] as { url: string; body: string | undefined; headers: Record<string, string> | undefined }[],
  requestedLimits: [] as number[],
  recentFees: [] as bigint[],
  feeQueries: [] as Address[][],
  files: new Map<string, string>(),
  env: {} as Record<string, string | undefined>,
  sleeps: [] as number[],
  onSleep: [] as (() => void)[],
  waits: [] as number[],
  changed: [] as { address: Address; data: Uint8Array }[][],
  scans: 0,
  submitted: [] as string[],
  dropSubmits: false,
  clock: 0n,
  steps: [] as bigint[],
  genesisReads: 0,
  failScans: 0,
  reads: new Map<Address, number>(),
  closed: 0,
  rounds: 0,
  engineLog: [] as EngineTransaction[],
  firstSlot: 0n,
  through: null as Transport | null,
  requestedOf: [] as (Address | undefined)[],
  simulated: [] as string[],
  sendFails: null as { error: Error; landed: boolean; after?: number } | null,
  packetLimit: false,
  served: [] as McpServer[],
  airdropRefused: false,
  airdrops: [] as { address: Address; lamports: bigint }[],
  saleRoot: mkdtempSync(join(tmpdir(), "solive-sales-")),
};

export const saleBook = fileSales((path) => join(h.saleRoot, path));

export const HOME = "/home/tester";
export const PACKET_LIMIT = 1_232;

export async function send(payer: TransactionSigner, ixs: readonly Instruction[]): Promise<string> {
  h.svm.expireBlockhash();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(payer, m),
    (m) => h.svm.setTransactionMessageLifetimeUsingLatestBlockhash(m),
    (m) => appendTransactionMessageInstructions(ixs, m),
  );
  const tx = await signTransactionMessageWithSigners(message);
  h.svm.withBlockhashCheck(false);
  const result = h.svm.sendTransaction(tx);
  h.svm.withBlockhashCheck(true);
  if (result instanceof FailedTransactionMetadata) {
    throw new Error(String(result.err()));
  }
  return getSignatureFromTransaction(tx);
}

const decodeWire = (wire: string) => getTransactionDecoder().decode(getBase64Encoder().encode(wire));

export const transport: Transport = {
  async getAccounts(addresses) {
    return Promise.all(addresses.map((address) => transport.getAccount(address)));
  },
  async getAccount(address) {
    h.reads.set(address, (h.reads.get(address) ?? 0) + 1);
    const account = h.svm.getAccount(address);
    return account.exists
      ? { owner: account.programAddress, data: new Uint8Array(account.data), lamports: account.lamports, executable: account.executable }
      : null;
  },
  send: (ixs, payer) => send(payer, ixs),
  latestBlockhash: async () => ({ blockhash: h.svm.latestBlockhash() as Blockhash, lastValidBlockHeight: 0n }),
  submitWire: async (wire) => {
    h.submitted.push(wire);
    const tx = decodeWire(wire);
    if (h.dropSubmits) {
      return getSignatureFromTransaction(tx);
    }
    const result = h.svm.sendTransaction(tx);
    if (result instanceof FailedTransactionMetadata) {
      throw new Error(`${String(result.err())}\n${result.meta().logs().join("\n")}`);
    }
    h.wires.push(wire);
    return getSignatureFromTransaction(tx);
  },
  sendWire: async (wire) => {
    const tx = decodeWire(wire);
    const fails = h.sendFails !== null && (h.sendFails.after ?? 0) > 0 ? null : h.sendFails;
    if (h.sendFails !== null && fails === null) {
      h.sendFails.after = (h.sendFails.after ?? 0) - 1;
    } else {
      h.sendFails = null;
    }
    if (fails !== null && !fails.landed) {
      throw fails.error;
    }
    const result = h.svm.sendTransaction(tx);
    if (fails !== null) {
      throw fails.error;
    }
    if (result instanceof FailedTransactionMetadata) {
      throw new Error(`${String(result.err())}\n${result.meta().logs().join("\n")}`);
    }
    h.wires.push(wire);
    return getSignatureFromTransaction(tx);
  },
  simulate: async (wire, watch = []) => {
    const bytes = getBase64Encoder().encode(wire).length;
    if (h.packetLimit && bytes > PACKET_LIMIT) {
      throw new Error(`base64 encoded solana_transaction::versioned::VersionedTransaction too large: ${bytes} bytes (max: encoded/raw ${PACKET_LIMIT})`);
    }
    h.simulated.push(wire);
    const tx = decodeWire(wire);
    const unsigned = Object.fromEntries(
      Object.entries(tx.signatures).map(([signer, signature]) => [signer, signature ?? new Uint8Array(64)]),
    );
    h.svm.withSigverify(false).withBlockhashCheck(false);
    const result = h.svm.simulateTransaction({ ...tx, signatures: unsigned } as typeof tx);
    h.svm.withSigverify(true).withBlockhashCheck(true);
    const meta = result.meta();
    const post = result instanceof FailedTransactionMetadata ? new Map() : new Map(result.postAccounts().map((a) => [a.address, a.data]));
    return {
      err: result instanceof FailedTransactionMetadata ? String(result.err()) : null,
      logs: meta.logs(),
      unitsConsumed: meta.computeUnitsConsumed(),
      accounts: watch.map((address) => {
        const after = post.get(address);
        if (after !== undefined) {
          return new Uint8Array(after);
        }
        const now = h.svm.getAccount(address);
        return now.exists ? new Uint8Array(now.data) : null;
      }),
    };
  },
  genesisHash: async () => {
    h.genesisReads++;
    return h.genesis;
  },
  intents: async (only) => {
    h.scans++;
    if (h.failScans > 0) {
      h.failScans--;
      throw new Error("scan refused");
    }
    const found = [];
    for (const owner of only === undefined ? h.watched : [only]) {
      const lanes = [1n, 2n, 3n].flatMap((serial) => Array.from({ length: 10 }, (_, i) => MANDATE_NONCE_BIT | (serial << 32n) | BigInt(i)));
      for (const nonce of [...Array.from({ length: 10 }, (_, i) => BigInt(i)), ...lanes]) {
        const [address] = await findIntentPda({ owner, nonce });
        const account = h.svm.getAccount(address);
        if (account.exists && account.programAddress === INTENT_ENGINE_PROGRAM_ADDRESS) {
          found.push({ address, data: new Uint8Array(account.data) });
        }
      }
    }
    return found;
  },
  engineTransactions: async (limit, of) => {
    h.requestedLimits.push(limit);
    h.requestedOf.push(of);
    return h.engineLog;
  },
  firstAvailableSlot: async () => h.firstSlot,
  recentFees: async (accounts) => {
    h.feeQueries.push([...accounts]);
    return [...h.recentFees];
  },
  budget: async (instructions) => [...instructions],
  airdrop: async (address, amount) => {
    h.airdrops.push({ address, lamports: amount });
    if (h.airdropRefused) {
      throw new Error("429 Too Many Requests");
    }
    h.svm.airdrop(address, lamports(amount));
    return "airdrop";
  },
};

export const creation = (intent: Address, slot = 1n): EngineTransaction => ({
  signature: `create-${intent}`,
  slot,
  blockTime: null,
  failed: false,
  emitted: [
    new Uint8Array([
      ...EVENT_IX_TAG,
      ...getIntentCreatedEventEncoder().encode({
        intent,
        owner: intent,
        nonce: 0n,
        kind: 4,
        inputMint: intent,
        outputMint: intent,
        receiver: intent,
        escrowed: 0n,
        expiresAt: 0n,
        rentPayer: intent,
        flags: 0,
        bounty: 0,
        createFee: 0,
      }),
    ]),
  ],
});

export const fakeFetch: Fetch = async (url, init) => {
  h.fetched.push({ url, body: init?.body, headers: init?.headers });
  const reply = h.jupiterReplies.shift() ?? { status: 503, body: {} };
  return { ok: reply.status === 200, status: reply.status, json: async () => reply.body };
};

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
  h.svm.airdrop(kp.address, lamports(100_000_000_000n));
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
  const authority = await boot();
  const feeRecipient = await funded();
  const programData = await findProgramDataAddress();
  const [eventAuthority] = await findEventAuthorityPda();
  await send(authority, [
    await getInitConfigInstructionAsync({
      authority,
      engineProgram: INTENT_ENGINE_PROGRAM_ADDRESS,
      programData,
      eventAuthority,
      program: INTENT_ENGINE_PROGRAM_ADDRESS,
      domain: DOMAIN,
      guardian: authority.address,
      feeRecipient: feeRecipient.address,
      enabledKinds: ALL_KINDS_MASK,
      feeBps: FEE_BPS,
      paused: 0,
    }),
  ]);
  const owner = await funded();
  const inputMint = await mint(authority);
  const outputMint = await mint(authority);
  const ownerInput = await ata(authority, owner.address, inputMint, 1_000n);
  await ata(authority, owner.address, outputMint);
  return { authority, feeRecipient, owner, inputMint, outputMint, ownerInput };
}
