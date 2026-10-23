import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type Address,
  type Blockhash,
  compileTransaction,
  createKeyPairSignerFromPrivateKeyBytes,
  createSignableMessage,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase16Decoder,
  getBase16Encoder,
  getPublicKeyFromAddress,
  type KeyPairSigner,
  lamports,
  none,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signBytes,
  verifySignature,
} from "@solana/kit";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { DEVNET_TEST_MINT, findAssociatedTokenAddress, NATIVE_MINT } from "@intent-engine/core";
import { getMintEncoder, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { beforeEach, describe, expect, it } from "vitest";
import { ENV_KEYPAIR, WALLET_NOT_MAINNET } from "../src/args.js";
import type { AgentContext } from "../src/agent/actions.js";
import { AgentRefusal } from "../src/agent/problems.js";
import { guardedSigner, signerOf, walletGuard } from "../src/agent/wallet/guard.js";
import { MAINNET_GENESIS, WALLET_NOTICE } from "../src/agent/wallet.js";
import { EXIT_OK } from "../src/main.js";
import { balance, cli, creation, h, resetHarness, runtime, saleBook, transport, world } from "./harness.js";

type Json = Record<string, unknown> & { [key: string]: any };

const contextOf = (wallet?: AgentContext["wallet"]) => ({ transport, ...(wallet === undefined ? {} : { wallet }) }) as unknown as AgentContext;

async function counted(): Promise<{ key: KeyPairSigner; real: KeyPairSigner; used: () => number }> {
  const real = await generateKeyPairSigner();
  let uses = 0;
  const key = {
    address: real.address,
    get keyPair() {
      uses++;
      return real.keyPair;
    },
    signMessages: (messages: Parameters<KeyPairSigner["signMessages"]>[0], config?: Parameters<KeyPairSigner["signMessages"]>[1]) => {
      uses++;
      return real.signMessages(messages, config);
    },
    signTransactions: (transactions: Parameters<KeyPairSigner["signTransactions"]>[0], config?: Parameters<KeyPairSigner["signTransactions"]>[1]) => {
      uses++;
      return real.signTransactions(transactions, config);
    },
  } as KeyPairSigner;
  return { key, real, used: () => uses };
}

const transactionFor = (payer: Address) =>
  compileTransaction(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayer(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: "11111111111111111111111111111111" as Blockhash, lastValidBlockHeight: 0n }, m),
    ),
  );

async function refused(attempt: Promise<unknown>): Promise<void> {
  const error = await attempt.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AgentRefusal);
  expect(error).toMatchObject({ problem: { code: "WalletNotMainnet", hint: WALLET_NOT_MAINNET } });
}

describe("the wallet's signer", () => {
  beforeEach(() => {
    resetHarness();
  });

  it("the wallet signer refuses every signature once the RPC serves mainnet, whatever tool asks", async () => {
    const { key, real, used } = await counted();
    const signer = guardedSigner(contextOf(), key);
    const bytes = new TextEncoder().encode("ballot");
    const tx = transactionFor(real.address);
    const signature = await signer.signBytes(bytes);
    expect(await verifySignature(await getPublicKeyFromAddress(real.address), signature, bytes)).toBe(true);
    const [own] = await signer.signTransactions([tx]);
    expect(own?.[real.address]).toEqual(await signBytes(real.keyPair.privateKey, tx.messageBytes));
    const [message] = await signer.signMessages([createSignableMessage("hello")]);
    expect(Object.keys(message ?? {})).toEqual([real.address]);
    const before = used();
    expect(before).toBeGreaterThan(0);
    h.genesis = MAINNET_GENESIS;
    const reads = h.genesisReads;
    await refused(signer.signBytes(bytes));
    await refused(signer.signTransactions([tx]));
    await refused(signer.signMessages([createSignableMessage("hello")]));
    expect(h.genesisReads - reads).toBe(3);
    expect(used()).toBe(before);
  });

  it("no wallet tool reaches the raw keypair", async () => {
    const agent = fileURLToPath(new URL("../src/agent", import.meta.url));
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? files(path) : path.endsWith(".ts") ? [path] : [];
      });
    const raw = /keyPair|loadSigner|KeyPairSigner|signCommitteeVote|signEd25519Instruction|partiallySignTransaction\b|(^|[^.])signBytes\(/;
    const guard = join(agent, "wallet", "guard.ts");
    const reaching = files(agent).filter((path) => path !== guard && raw.test(readFileSync(path, "utf8")));
    expect(reaching).toEqual([]);
    expect(readFileSync(guard, "utf8").match(/loadSigner/g)).toHaveLength(1);
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const real = await createKeyPairSignerFromPrivateKeyBytes(secret);
    h.files.set("key.json", JSON.stringify([...secret, ...getAddressEncoder().encode(real.address)]));
    h.env[ENV_KEYPAIR] = "key.json";
    const run = runtime({});
    const signer = await signerOf(
      contextOf({ url: "http://cluster", files: run, env: h.env, sleep: run.sleep, now: run.now, limits: walletGuard({ perTrade: new Map(), perHour: new Map() }, saleBook) }),
    );
    expect(signer.address).toBe(real.address);
    expect(Object.isFrozen(signer)).toBe(true);
    expect(Object.keys(signer).sort()).toEqual(["address", "signBytes", "signMessages", "signTransactions"]);
    expect(Object.values(signer).some((value) => value instanceof CryptoKey || (typeof value === "object" && value !== null && "privateKey" in value))).toBe(false);
    expect("keyPair" in signer).toBe(false);
    const bytes = new TextEncoder().encode("vote");
    expect(await verifySignature(await getPublicKeyFromAddress(real.address), await signer.signBytes(bytes), bytes)).toBe(true);
  });
});

async function connect(): Promise<Client> {
  h.served.length = 0;
  const started = await cli(["mcp", "--url", "devnet", "--wallet", "--all-tools"], {});
  expect([started.code, started.err]).toEqual([EXIT_OK, WALLET_NOTICE.join("\n")]);
  const server = h.served[0];
  if (server === undefined) {
    throw new Error("no server was started");
  }
  const [near, far] = InMemoryTransport.createLinkedPair();
  await server.connect(near);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(far);
  return client;
}

async function call(client: Client, name: string, args: object = {}) {
  const result = await client.callTool({ name: `solive_${name}`, arguments: args as Record<string, unknown> });
  return { error: result.isError === true, value: result.structuredContent as Json };
}

async function ok(client: Client, name: string, args: object = {}): Promise<Json> {
  const { error, value } = await call(client, name, args);
  expect(error, JSON.stringify(value)).toBe(false);
  return value;
}

describe("a wallet server whose RPC turns to mainnet after a split release preview", () => {
  let client: Client;

  beforeEach(async () => {
    await world();
    h.files.clear();
    for (const name of Object.keys(h.env)) {
      delete h.env[name];
    }
    const space = BigInt(getMintSize());
    for (const address of [NATIVE_MINT, DEVNET_TEST_MINT]) {
      h.svm.setAccount({
        address,
        data: Uint8Array.from(getMintEncoder().encode({ mintAuthority: none(), supply: 0n, decimals: 9, isInitialized: true, freezeAuthority: none() })),
        executable: false,
        lamports: lamports(h.svm.minimumBalanceForRentExemption(space)),
        programAddress: TOKEN_PROGRAM_ADDRESS,
        space,
      });
    }
    client = await connect();
  });

  it("wallet_attest_split signs nothing once the RPC serves mainnet after its preview", async () => {
    const owner = (await ok(client, "wallet_setup"))["address"] as Address;
    const coauthor = await generateKeyPairSigner();
    const escrow = await ok(client, "wallet_escrow", { sell: "SOL", amount: "0.05", attestor: owner, min_result: "1", max_result: "1", spec_hash: "a".repeat(64), send: true });
    const intent = escrow["intent"] as Address;
    const release = { owner, nonce: escrow["nonce"] as string, delivered_sha256: "ab".repeat(32), received_outside_announcement: true };
    h.engineLog = [creation(intent)];
    const recipients = [{ wallet: coauthor.address, weight: 10000 }];
    const shown = await ok(client, "wallet_attest_split", { ...release, recipients });
    expect(shown).toMatchObject({ sent: false });
    const envelope = Uint8Array.from(getBase16Encoder().encode(shown["envelope"] as string));
    const signed = [{ ...recipients[0], signature: getBase16Decoder().decode(new Uint8Array(await signBytes(coauthor.keyPair.privateKey, envelope))) }];
    const payee = await findAssociatedTokenAddress({ owner: coauthor.address, mint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    h.wires.length = 0;
    h.simulated.length = 0;
    h.genesis = MAINNET_GENESIS;
    const { value } = await call(client, "wallet_attest_split", { ...release, recipients: signed, approval: shown["approval"], send: true });
    expect(value).toMatchObject({ code: "WalletNotMainnet", hint: WALLET_NOT_MAINNET });
    expect(value).not.toHaveProperty("signature");
    expect(h.simulated).toEqual([]);
    expect(h.wires).toEqual([]);
    expect(balance(payee)).toBe(-1n);
    expect(h.svm.getAccount(intent).exists).toBe(true);
  });
});
