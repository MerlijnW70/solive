import {
  AccountRole,
  type Address,
  address,
  createSolanaRpc,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase64Decoder,
  getProgramDerivedAddress,
  getU64Encoder,
  type Instruction,
  type KeyPairSigner,
} from "@solana/kit";
import { getCreateAccountInstruction, getTransferSolInstruction } from "@solana-program/system";
import {
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeAccount3Instruction,
  getInitializeMint2Instruction,
  getMintSize,
  getMintToInstruction,
  getTokenDecoder,
  getTokenSize,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { describe, expect, it } from "vitest";
import {
  buildCreateIntent,
  buildInitUser,
  findAssociatedTokenAddress,
  findConfigPda,
  findIntentPda,
  getConfigDecoder,
  getIntentDecoder,
  IntentStatus,
  Kind,
} from "@intent-engine/core";
import { DEFAULT_MAX_SOL_COST, SIMULATION_REFUSED } from "@intent-engine/solver";
import { chainTime, type RpcLike, rpcTransport } from "@intent-engine/client";
import { run } from "../src/commands.js";
import { loadKeypairFile } from "../src/main.js";

const url = process.env["DEVNET_RPC"];
const keypair = process.env["DEVNET_KEYPAIR"];
const SWAP_PROGRAM = address("SwapsVeCiPHMUAtzQWZw7RjsKjgCjhwU55QGu4U1Szw");
const SWAP_SIZE = 324n;
const MARKET = "https://market.devnet.invalid";
const DEPTH = 1_000_000n;
const ESCROW = 400n;
const MIN_OUT = 300n;
const SLIPPAGE_BPS = 100n;
const TRADE_FEE = [25n, 10_000n] as const;
const OWNER_FEE = [5n, 10_000n] as const;
const EXCEEDED_SLIPPAGE = "{ Custom: 16n }";

const u64 = (value: bigint) => new Uint8Array(getU64Encoder().encode(value));
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

function poolOut(amountIn: bigint, source: bigint, destination: bigint): bigint {
  const fee = (amount: bigint, [num, den]: readonly [bigint, bigint]) => {
    const raw = (amount * num) / den;
    return raw === 0n && num > 0n ? 1n : raw;
  };
  const traded = amountIn - fee(amountIn, TRADE_FEE) - fee(amountIn, OWNER_FEE);
  return destination - (source * destination + source + traded - 1n) / (source + traded);
}

describe.skipIf(url === undefined || keypair === undefined)("devnet solve smoke", () => {
  const tokenProgram = TOKEN_PROGRAM_ADDRESS;
  it(`solves an intent through a live pool and refuses a route that over-quotes on ${tokenProgram}`, async () => {
    const rpc = createSolanaRpc(url ?? "");
    const transport = rpcTransport(rpc as unknown as RpcLike);
    const payer = (await loadKeypairFile(keypair ?? "")) as KeyPairSigner;
    const send = (signer: KeyPairSigner, ixs: Instruction[]) => transport.send(ixs, signer);
    const amountOf = async (account: Address) => {
      const view = await transport.getAccount(account);
      return view === null ? -1n : getTokenDecoder().decode(view.data).amount;
    };
    const [configAddress] = await findConfigPda();
    const configView = await transport.getAccount(configAddress);
    if (configView === null) {
      throw new Error("config is not initialised on this cluster");
    }
    const config = getConfigDecoder().decode(configView.data);
    const fund = async (lamports: bigint) => {
      const kp = await generateKeyPairSigner();
      await send(payer, [getTransferSolInstruction({ source: payer, destination: kp.address, amount: lamports })]);
      return kp;
    };
    const mint = async (authority: Address, decimals = 6) => {
      const m = await generateKeyPairSigner();
      const space = BigInt(getMintSize());
      await send(payer, [
        getCreateAccountInstruction({
          payer,
          newAccount: m,
          lamports: await rpc.getMinimumBalanceForRentExemption(space).send(),
          space,
          programAddress: tokenProgram,
        }),
        getInitializeMint2Instruction({ mint: m.address, decimals, mintAuthority: authority }, { programAddress: tokenProgram }),
      ]);
      return m.address;
    };
    const account = async (owner: Address, m: Address, amount = 0n) => {
      const a = await generateKeyPairSigner();
      const space = BigInt(getTokenSize());
      await send(payer, [
        getCreateAccountInstruction({
          payer,
          newAccount: a,
          lamports: await rpc.getMinimumBalanceForRentExemption(space).send(),
          space,
          programAddress: tokenProgram,
        }),
        getInitializeAccount3Instruction({ account: a.address, mint: m, owner }, { programAddress: tokenProgram }),
        ...(amount > 0n
          ? [getMintToInstruction({ mint: m, token: a.address, mintAuthority: payer, amount }, { programAddress: tokenProgram })]
          : []),
      ]);
      return a.address;
    };
    const ata = async (owner: Address, m: Address, amount = 0n) => {
      const a = await findAssociatedTokenAddress({ owner, mint: m, tokenProgram });
      await send(payer, [
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner, mint: m, tokenProgram }),
        ...(amount > 0n
          ? [getMintToInstruction({ mint: m, token: a, mintAuthority: payer, amount }, { programAddress: tokenProgram })]
          : []),
      ]);
      return a;
    };

    const inputMint = await mint(payer.address);
    const outputMint = await mint(payer.address);
    const swap = await generateKeyPairSigner();
    const [authority] = await getProgramDerivedAddress({
      programAddress: SWAP_PROGRAM,
      seeds: [getAddressEncoder().encode(swap.address)],
    });
    const poolMint = await mint(authority, 2);
    const poolInput = await account(authority, inputMint, DEPTH);
    const poolOutput = await account(authority, outputMint, DEPTH);
    const poolFee = await account(payer.address, poolMint);
    const poolShares = await account(payer.address, poolMint);
    await send(payer, [
      getCreateAccountInstruction({
        payer,
        newAccount: swap,
        lamports: await rpc.getMinimumBalanceForRentExemption(SWAP_SIZE).send(),
        space: SWAP_SIZE,
        programAddress: SWAP_PROGRAM,
      }),
      {
        programAddress: SWAP_PROGRAM,
        accounts: [
          { address: swap.address, role: AccountRole.WRITABLE },
          { address: authority, role: AccountRole.READONLY },
          { address: poolInput, role: AccountRole.READONLY },
          { address: poolOutput, role: AccountRole.READONLY },
          { address: poolMint, role: AccountRole.WRITABLE },
          { address: poolFee, role: AccountRole.READONLY },
          { address: poolShares, role: AccountRole.WRITABLE },
          { address: tokenProgram, role: AccountRole.READONLY },
        ],
        data: concat(
          Uint8Array.of(0),
          u64(TRADE_FEE[0]),
          u64(TRADE_FEE[1]),
          u64(OWNER_FEE[0]),
          u64(OWNER_FEE[1]),
          u64(0n),
          u64(0n),
          u64(20n),
          u64(100n),
          Uint8Array.of(0),
          new Uint8Array(32),
        ),
      },
    ]);

    const owner = await fund(30_000_000n);
    const solver = await fund(30_000_000n);
    await ata(owner.address, inputMint, ESCROW);
    const receiver = await ata(owner.address, outputMint);
    const solverInput = await ata(solver.address, inputMint);
    const solverOutput = await ata(solver.address, outputMint);
    await ata(config.feeRecipient, inputMint);
    await send(owner, [await buildInitUser({ owner })]);
    await send(owner, [
      await buildCreateIntent({
        owner,
        inputMint,
        outputMint,
        inputTokenProgram: tokenProgram,
        outputTokenProgram: tokenProgram,
        treasury: config.feeRecipient,
        maxCreateFee: config.createFee,
        maxBounty: config.crankBounty,
        nonce: 0n,
        params: { kind: Kind.SwapExactIn, amountIn: ESCROW, minOut: MIN_OUT },
        expiresAt: (await chainTime(transport)) + 3_600n,
      }),
    ]);
    const [intent] = await findIntentPda({ owner: owner.address, nonce: 0n });

    const market = (overstate: bigint) => async (target: string, init?: RequestInit) => {
      const reply = (status: number, body: unknown) =>
        ({ ok: status === 200, status, json: async () => body }) as unknown as Response;
      const asked = new URL(target);
      if (asked.pathname === "/quote") {
        const amountIn = BigInt(asked.searchParams.get("amount") ?? "0");
        if (asked.searchParams.get("inputMint") !== inputMint || asked.searchParams.get("outputMint") !== outputMint) {
          return reply(404, {});
        }
        const out = poolOut(amountIn, await amountOf(poolInput), await amountOf(poolOutput));
        const floor = (out * (10_000n - SLIPPAGE_BPS)) / 10_000n + overstate;
        return reply(200, { inputMint, outputMint, swapMode: "ExactIn", inAmount: amountIn.toString(), otherAmountThreshold: floor.toString() });
      }
      const { quoteResponse, userPublicKey } = JSON.parse(String(init?.body)) as {
        quoteResponse: { inAmount: string; otherAmountThreshold: string };
        userPublicKey: Address;
      };
      const meta = (pubkey: Address, isWritable: boolean, isSigner = false) => ({ pubkey, isWritable, isSigner });
      return reply(200, {
        setupInstructions: [],
        swapInstruction: {
          programId: SWAP_PROGRAM,
          accounts: [
            meta(swap.address, false),
            meta(authority, false),
            meta(userPublicKey, false, true),
            meta(await findAssociatedTokenAddress({ owner: userPublicKey, mint: inputMint, tokenProgram }), true),
            meta(poolInput, true),
            meta(poolOutput, true),
            meta(await findAssociatedTokenAddress({ owner: userPublicKey, mint: outputMint, tokenProgram }), true),
            meta(poolMint, true),
            meta(poolFee, true),
            meta(tokenProgram, false),
          ],
          data: getBase64Decoder().decode(
            concat(Uint8Array.of(1), u64(BigInt(quoteResponse.inAmount)), u64(BigInt(quoteResponse.otherAmountThreshold))),
          ),
        },
        addressLookupTableAddresses: [],
      });
    };
    const solve = async (overstate: bigint) =>
      (await run(
        {
          name: "solve",
          url: url ?? "",
          priority: 0n,
          keypair: "solver",
          jupiter: MARKET,
          issue: [],
          jito: undefined,
          tipLamports: 0n,
          minProfit: new Map([[outputMint, 1n]]),
          maxFeeBps: config.feeBps,
          maxSolCost: DEFAULT_MAX_SOL_COST,
          slippageBps: Number(SLIPPAGE_BPS),
          routeProgram: SWAP_PROGRAM,
          lookupTables: [],
          watch: null,
        },
        {
          transport: () => transport,
          loadSigner: async () => solver,
          readText: async () => {
            throw new Error("the devnet solve smoke reads no files");
          },
          writeText: async () => {
            throw new Error("the devnet solve smoke writes no files");
          },
          saveText: async () => {
            throw new Error("the devnet solve smoke writes no files");
          },
          home: "",
          sleep: async () => false,
          env: {},
          now: () => 0n,
          fetch: market(overstate),
          entropy: () => 0,
          serve: async () => {
            throw new Error("the devnet solve smoke runs no agent server");
          },
          intentChanges: () => {
            throw new Error("the devnet solve smoke watches no intents");
          },
        },
      )) as {
        filled: { intent: Address; profit: bigint }[];
        sent: { intent: Address }[];
        failed: { intent: Address; error: string }[];
        skipped: { intent: Address; reason: string }[];
      };
    const mine = <T extends { intent: Address }>(rows: T[]) => rows.filter((row) => row.intent === intent);

    const depth = [await amountOf(poolInput), await amountOf(poolOutput)];
    const lying = await solve(1_000n);
    expect([mine(lying.filled), mine(lying.sent)]).toEqual([[], []]);
    expect(mine(lying.failed)).toEqual([{ intent, error: expect.stringContaining(SIMULATION_REFUSED) }]);
    expect(mine(lying.failed)[0]?.error).toContain(EXCEEDED_SLIPPAGE);
    expect([await amountOf(poolInput), await amountOf(poolOutput)]).toEqual(depth);
    expect(await amountOf(receiver)).toBe(0n);

    const honest = await solve(0n);
    expect(mine(honest.failed)).toEqual([]);
    expect(mine(honest.filled)).toHaveLength(1);
    const profit = mine(honest.filled)[0]?.profit ?? 0n;
    expect(profit).toBeGreaterThan(0n);
    expect(await amountOf(receiver)).toBe(MIN_OUT);
    const swapped = depth[1]! - (await amountOf(poolOutput));
    expect(await amountOf(solverOutput)).toBe(swapped - MIN_OUT);
    expect(swapped - MIN_OUT).toBeGreaterThanOrEqual(profit);
    expect(await amountOf(solverInput)).toBe(0n);
    const filled = await transport.getAccount(intent);
    expect(filled === null ? -1 : getIntentDecoder().decode(filled.data).status).toBe(IntentStatus.Filled);
  }, 900_000);
});
