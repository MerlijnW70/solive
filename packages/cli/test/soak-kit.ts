import { claimsOf } from "../src/agent/claims.js";
import { writeFile } from "node:fs/promises";
import {
  type Address,
  type Blockhash,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  generateKeyPairSigner,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getTransactionDecoder,
  type Instruction,
  type KeyPairSigner,
  partiallySignTransaction,
} from "@solana/kit";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { getCreateAccountInstruction, getTransferSolInstruction } from "@solana-program/system";
import {
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
  getTokenDecoder,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { type Config, findAssociatedTokenAddress, type IntentParams, Kind } from "@intent-engine/core";
import { buildInitUser, findConfigPda, getConfigDecoder } from "@intent-engine/core/internal";
import { type Transport } from "@intent-engine/client";
import { type RpcLike, rpcTransport } from "@intent-engine/client/internal";
import { agentServer } from "../src/agent/mcp.js";
import { budgetOf } from "../src/agent/budget.js";
import { relayOf } from "../src/agent/relay.js";
import { loadKeypairFile } from "../src/main.js";

export const url = process.env["DEVNET_RPC"];
export const keypair = process.env["DEVNET_KEYPAIR"];
export const minutes = Number(process.env["SOAK_MINUTES"] ?? "0");
export const reportPath = process.env["SOAK_REPORT"];
export const keysPath = process.env["SOAK_KEYS"];
export const seed = Number(process.env["SOAK_SEED"] ?? Date.now() % 2 ** 31);
export const TOKEN_2022_PROGRAM_ADDRESS = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;
export const OWNERS = 3;
export const OWNER_TOKENS = 10_000_000n;
export const SOLVER_TOKENS = 1_000_000_000n;
export const OWNER_LAMPORTS = 150_000_000n;
export const SOLVER_LAMPORTS = 100_000_000n;
export const AGENT_LAMPORTS = 200_000_000n;
export const SAFETY_SECONDS = 15n;
export const CHECK_EVERY = 5;
export const SIGNATURE_FEE = 5_000n;

export async function savableKey(): Promise<{ signer: KeyPairSigner; secret: number[] }> {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as { privateKey: CryptoKey; publicKey: CryptoKey };
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const secret = [...pkcs8.slice(-32), ...raw];
  return { signer: await createKeyPairSignerFromBytes(new Uint8Array(secret)), secret };
}

export type Outcome = "open" | "filled" | "refunded";
export type Origin = "plain" | "signed" | "agent";

export type Record_ = {
  world: World;
  owner: KeyPairSigner;
  nonce: bigint;
  intent: Address;
  kind: number;
  params: IntentParams;
  escrow: bigint;
  expiresAt: bigint;
  origin: Origin;
  rentPayer: Address;
  mandate: Address | null;
  outcome: Outcome;
  amountOut: bigint;
  fee: bigint;
  closed: boolean;
  revoked: boolean;
  superseded: boolean;
};

export type World = {
  name: string;
  tokenProgram: Address;
  inputMint: Address;
  outputMint: Address;
  ownerInputs: Address[];
  receivers: Address[];
  solverInput: Address;
  solverOutput: Address;
  feeAccount: Address;
  feeStart: bigint;
  mandates: (Address | null)[];
  mandateIds: (bigint | null)[];
};

export function rng(start: number) {
  let s = start >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function soakSetup() {
  const random = rng(seed);
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const between = (lo: bigint, hi: bigint) => lo + BigInt(Math.floor(random() * Number(hi - lo + 1n)));
  const rpc = createSolanaRpc(url ?? "");
  const transport: Transport = rpcTransport(rpc as unknown as RpcLike);
  const payer = (await loadKeypairFile(keypair ?? "")) as KeyPairSigner;
  const report = {
    seed,
    minutes,
    startedAt: new Date().toISOString(),
    steps: 0,
    checks: 0,
    ops: {} as Record<string, { ok: number; refused: number; unexpected: number }>,
    anomalies: [] as { step: number; op: string; detail: string }[],
    violations: [] as { step: number; detail: string }[],
    latencyMs: [] as number[],
    lamports: { payerStart: 0n, payerEnd: 0n },
  };
  const tally = (op: string, result: "ok" | "refused" | "unexpected") => {
    report.ops[op] ??= { ok: 0, refused: 0, unexpected: 0 };
    report.ops[op][result] += 1;
  };
  const timed = async <T>(work: () => Promise<T>) => {
    const started = Date.now();
    try {
      return await work();
    } finally {
      report.latencyMs.push(Date.now() - started);
    }
  };
  const send = (signer: KeyPairSigner, ixs: Instruction[]) => timed(() => transport.send(ixs, signer));
  const lamportsOf = async (address: Address) => (await transport.getAccount(address))?.lamports ?? 0n;
  const tokens = async (account: Address) => {
    const view = await transport.getAccount(account);
    return view === null ? 0n : getTokenDecoder().decode(view.data).amount;
  };
  report.lamports.payerStart = await lamportsOf(payer.address);

  const [configAddress] = await findConfigPda();
  const configView = await transport.getAccount(configAddress);
  if (configView === null) {
    throw new Error("config is not initialised on this cluster");
  }
  const config: Config = getConfigDecoder().decode(configView.data);
  const saved: { address: Address; secret: number[] }[] = [];
  const fund = async (lamports: bigint) => {
    const { signer: kp, secret } = await savableKey();
    saved.push({ address: kp.address, secret });
    if (keysPath !== undefined) {
      await writeFile(keysPath, JSON.stringify(saved));
    }
    await send(payer, [getTransferSolInstruction({ source: payer, destination: kp.address, amount: lamports })]);
    return kp;
  };
  const owners: KeyPairSigner[] = [];
  for (let i = 0; i < OWNERS; i++) {
    owners.push(await fund(OWNER_LAMPORTS));
  }
  const solver = await fund(SOLVER_LAMPORTS);
  const agent = await fund(AGENT_LAMPORTS);
  for (const owner of owners) {
    await send(owner, [await buildInitUser({ owner })]);
  }

  const makeWorld = async (name: string, tokenProgram: Address): Promise<World> => {
    const mint = async () => {
      const m = await generateKeyPairSigner();
      const space = BigInt(getMintSize());
      const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
      await send(payer, [
        getCreateAccountInstruction({ payer, newAccount: m, lamports: rent, space, programAddress: tokenProgram }),
        getInitializeMint2Instruction({ mint: m.address, decimals: 6, mintAuthority: payer.address }, { programAddress: tokenProgram }),
      ]);
      return m.address;
    };
    const ata = async (owner: Address, m: Address, amount: bigint) => {
      const address = await findAssociatedTokenAddress({ owner, mint: m, tokenProgram });
      await send(payer, [
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner, mint: m, tokenProgram }),
        ...(amount > 0n ? [getMintToInstruction({ mint: m, token: address, mintAuthority: payer, amount }, { programAddress: tokenProgram })] : []),
      ]);
      return address;
    };
    const inputMint = await mint();
    const outputMint = await mint();
    const ownerInputs = [];
    const receivers = [];
    for (const owner of owners) {
      ownerInputs.push(await ata(owner.address, inputMint, OWNER_TOKENS));
      receivers.push(await ata(owner.address, outputMint, 0n));
    }
    const feeAccount = await ata(config.feeRecipient, inputMint, 0n);
    return {
      name,
      tokenProgram,
      inputMint,
      outputMint,
      ownerInputs,
      receivers,
      solverInput: await ata(solver.address, inputMint, 0n),
      solverOutput: await ata(solver.address, outputMint, SOLVER_TOKENS),
      feeAccount,
      feeStart: await tokens(feeAccount),
      mandates: owners.map(() => null),
      mandateIds: owners.map(() => null),
    };
  };
  const worlds = [await makeWorld("spl", TOKEN_PROGRAM_ADDRESS), await makeWorld("token-2022", TOKEN_2022_PROGRAM_ADDRESS)];

  const relay = relayOf(payer, {
    maxLamports: 1_000_000_000n,
    maxTtl: 7_200n,
    perHour: 100_000,
    hourlyLamports: 100_000_000_000n,
    fees: new Map(worlds.map((w) => [w.inputMint, 0n])),
  });
  const [near, far] = InMemoryTransport.createLinkedPair();
  await agentServer({ transport, relay, agent: { signer: agent, budget: budgetOf(100_000_000_000n), owners: new Set(owners.map((o) => o.address)) }, claims: claimsOf() }).connect(near);
  const client = new Client({ name: "soak", version: "0.0.0" });
  await client.connect(far);
  const call = async (name: string, args: object) => {
    const result = await timed(() => client.callTool({ name: `solive_${name}`, arguments: args as Record<string, unknown> }));
    if (result.isError === true) {
      throw new Error(`${name}: ${JSON.stringify(result.structuredContent)}`);
    }
    return result.structuredContent as Record<string, any>;
  };
  const execute = async (prepared: { transaction: string; last_valid_block_height: string }, signer: KeyPairSigner) => {
    const tx = getTransactionDecoder().decode(getBase64Encoder().encode(prepared.transaction));
    const signed = await partiallySignTransaction([signer.keyPair], tx);
    const latest = { blockhash: "" as Blockhash, lastValidBlockHeight: BigInt(prepared.last_valid_block_height) };
    await timed(() => transport.sendWire(getBase64EncodedWireTransaction(signed), latest));
  };
  return { random, pick, between, transport, payer, report, tally, send, lamportsOf, tokens, config, owners, solver, agent, worlds, client, call, execute };
}

export const common = (w: World) => ({
  inputMint: w.inputMint,
  outputMint: w.outputMint,
  inputTokenProgram: w.tokenProgram,
  outputTokenProgram: w.tokenProgram,
});
export const escrowOf = (p: IntentParams) => ("makeAmount" in p ? p.makeAmount : (p as { amountIn: bigint }).amountIn);
export const paysAtLeast = (p: IntentParams) =>
  p.kind === Kind.SwapExactIn ? p.minOut : p.kind === Kind.LimitOrder ? p.takeAmount : p.kind === Kind.DutchAuction ? p.startOut : 0n;
export const belowFloor = (p: IntentParams) =>
  p.kind === Kind.SwapExactIn ? p.minOut - 1n : p.kind === Kind.LimitOrder ? p.takeAmount - 1n : p.kind === Kind.DutchAuction ? p.endOut - 1n : 0n;
export const toOrder = (p: IntentParams) =>
  p.kind === Kind.SwapExactIn
    ? { kind: "swap", amount_in: p.amountIn.toString(), min_out: p.minOut.toString() }
    : p.kind === Kind.LimitOrder
      ? { kind: "limit", make_amount: p.makeAmount.toString(), take_amount: p.takeAmount.toString() }
      : p.kind === Kind.DutchAuction
        ? {
            kind: "dutch",
            amount_in: p.amountIn.toString(),
            start_out: p.startOut.toString(),
            end_out: p.endOut.toString(),
            start_time: p.startTs.toString(),
            end_time: p.endTs.toString(),
          }
        : null;
export const fresh = (
  w: World,
  owner: KeyPairSigner,
  nonce: bigint,
  intent: Address,
  params: IntentParams,
  expiresAt: bigint,
  origin: Origin,
  rentPayer: Address,
  mandate: Address | null,
): Record_ => ({
  world: w,
  owner,
  nonce,
  intent,
  kind: params.kind,
  params,
  escrow: escrowOf(params),
  expiresAt,
  origin,
  rentPayer,
  mandate,
  outcome: "open",
  amountOut: 0n,
  fee: 0n,
  closed: false,
  revoked: false,
  superseded: false,
});
