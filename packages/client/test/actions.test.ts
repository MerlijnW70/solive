import { createHash } from "node:crypto";
import { type Address, generateKeyPairSigner, type KeyPairSigner, lamports, none } from "@solana/kit";
import { getMintEncoder, getMintSize } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import {
  findAssociatedTokenAddress,
  findIntentPda,
  IntentStatus,
  Kind,
  NATIVE_MINT,
  TOKEN_PROGRAM_ADDRESS,
} from "@intent-engine/core";
import { createClient, loadUser, NotSettleable, type Transport } from "../src/index.js";
import { svmTransport } from "../src/svm.js";
import { FEE_BPS, NOW, world, type World } from "./svm.js";

const LOCAL = "http://127.0.0.1:8899";
const SOL = 1_000_000_000n;
const SPEC = new Uint8Array(createHash("sha256").update("the spec").digest());

function nativeMint(w: World): void {
  const space = BigInt(getMintSize());
  w.chain.svm.setAccount({
    address: NATIVE_MINT,
    data: Uint8Array.from(
      getMintEncoder().encode({ mintAuthority: none(), supply: 0n, decimals: 9, isInitialized: true, freezeAuthority: none() }),
    ),
    executable: false,
    lamports: lamports(w.chain.svm.minimumBalanceForRentExemption(space)),
    programAddress: TOKEN_PROGRAM_ADDRESS,
    space,
  });
}

const ata = (owner: Address, mint: Address) => findAssociatedTokenAddress({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });

async function setup() {
  const w = await world();
  nativeMint(w);
  const inner = svmTransport(w.chain.svm);
  const counted = { sends: 0, reads: new Map<Address, number>() };
  const transport: Transport = {
    ...inner,
    getAccount: async (address) => {
      counted.reads.set(address, (counted.reads.get(address) ?? 0) + 1);
      return inner.getAccount(address);
    },
    send: async (instructions, payer) => {
      counted.sends++;
      return inner.send(instructions, payer);
    },
  };
  const client = createClient({ url: LOCAL, transport });
  const fresh = async (sol = 10n) => {
    const signer = await generateKeyPairSigner();
    if (sol > 0n) {
      w.chain.svm.airdrop(signer.address, lamports(sol * SOL));
    }
    return signer;
  };
  const tokens = async (owner: Address, mint: Address = NATIVE_MINT) => {
    const found = w.chain.svm.getAccount(await ata(owner, mint));
    return found.exists ? new DataView(found.data.buffer, found.data.byteOffset).getBigUint64(64, true) : null;
  };
  return { w, client, counted, fresh, tokens };
}

const proofOf = (judge: Address, amountIn: bigint, judgeFee: bigint, specHash = SPEC) =>
  ({ kind: Kind.AttestedResult, amountIn, minResult: 1n, maxResult: 3n, attestor: judge, specHash, judgeFee }) as const;

describe("one call per action", () => {
  it("reads a mint once per client and the cluster's clock", async () => {
    const { w, client, counted } = await setup();
    expect(await client.mint(w.inputMint)).toEqual({ decimals: 6, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(await client.mint(w.inputMint)).toEqual({ decimals: 6, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    expect(counted.reads.get(w.inputMint)).toBe(1);
    expect(await client.mint(NATIVE_MINT)).toEqual({ decimals: 9, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    await expect(client.mint(w.owner.address)).rejects.toThrow("is not a token mint");
    expect(await client.chainTime()).toBe(NOW);
  });

  it("creates for a fresh wallet in one transaction: registers it, wraps its SOL and opens the receiver's account", async () => {
    const { w, client, counted, fresh, tokens } = await setup();
    const signer = await fresh();
    const receiver = (await generateKeyPairSigner()).address;
    const swap = { kind: Kind.SwapExactIn, amountIn: SOL / 10n, minOut: 5n } as const;
    expect(await loadUser(client.transport, signer.address)).toBeNull();
    expect(await tokens(signer.address)).toBeNull();
    expect(await tokens(receiver, w.outputMint)).toBeNull();

    const created = await client.createIntent({ signer, params: swap, inputMint: NATIVE_MINT, outputMint: w.outputMint, receiver, expiresIn: 600n });
    expect(counted.sends).toBe(1);
    expect(created.nonce).toBe(0n);
    expect(created.intent).toBe((await findIntentPda({ owner: signer.address, nonce: 0n }))[0]);
    expect((await client.intent(signer.address, 0n))?.intent).toMatchObject({
      escrowed: SOL / 10n,
      status: IntentStatus.Open,
      expiresAt: NOW + 600n,
      receiver: await ata(receiver, w.outputMint),
    });
    expect(await loadUser(client.transport, signer.address)).not.toBeNull();
    expect(await tokens(signer.address)).toBe(0n);
    expect(await tokens(receiver, w.outputMint)).toBe(0n);

    const next = await client.createIntent({ signer, params: swap, inputMint: NATIVE_MINT, outputMint: w.outputMint });
    expect(next.nonce).toBe(1n);
    expect((await client.intent(signer.address, 1n))?.intent).toMatchObject({
      expiresAt: NOW + 3_600n,
      receiver: await ata(signer.address, w.outputMint),
    });
    expect(await tokens(signer.address, w.outputMint)).toBe(0n);
    expect((await client.intents({ owner: signer.address })).map(({ intent }) => intent.nonce)).toEqual([0n, 1n]);
  });

  it("cancels by nonce and returns the escrow to the owner's token account", async () => {
    const { w, client, fresh, tokens } = await setup();
    const signer = await fresh();
    const swap = { kind: Kind.SwapExactIn, amountIn: SOL / 4n, minOut: 5n } as const;
    const { nonce } = await client.createIntent({ signer, params: swap, inputMint: NATIVE_MINT, outputMint: w.outputMint, nonce: 7n });
    expect(nonce).toBe(7n);
    expect(await tokens(signer.address)).toBe(0n);

    await client.cancel(signer, nonce);
    expect((await client.intent(signer.address, nonce))?.intent.status).toBe(IntentStatus.Cancelled);
    expect(await tokens(signer.address)).toBe(SOL / 4n);
  });

  it("unwraps a wallet's wrapped SOL back to SOL, and does nothing when it holds none", async () => {
    const { w, client, counted, fresh, tokens } = await setup();
    const signer = await fresh();
    expect(await client.unwrap(signer)).toBeNull();
    expect(counted.sends).toBe(0);
    const swap = { kind: Kind.SwapExactIn, amountIn: SOL / 4n, minOut: 5n } as const;
    const { nonce } = await client.createIntent({ signer, params: swap, inputMint: NATIVE_MINT, outputMint: w.outputMint });
    await client.cancel(signer, nonce);
    const wrapped = w.chain.svm.getAccount(await ata(signer.address, NATIVE_MINT));
    expect(wrapped.exists).toBe(true);
    const before = w.chain.svm.getBalance(signer.address) ?? 0n;
    const sends = counted.sends;

    expect(typeof (await client.unwrap(signer))).toBe("string");
    expect(counted.sends).toBe(sends + 1);
    expect(await tokens(signer.address)).toBeNull();
    expect((w.chain.svm.getBalance(signer.address) ?? 0n) - before).toBe((wrapped.exists ? wrapped.lamports : 0n) - 5_000n);
    expect(await client.unwrap(signer)).toBeNull();
    expect(counted.sends).toBe(sends + 1);
  });

  async function escrowed(judge: KeyPairSigner, pay: bigint, judgeFee: bigint) {
    const context = await setup();
    const owner = await context.fresh();
    const { nonce } = await context.client.createIntent({
      signer: owner,
      params: proofOf(judge.address, pay, judgeFee),
      inputMint: NATIVE_MINT,
      outputMint: context.w.outputMint,
    });
    return { ...context, owner, nonce };
  }

  it("settles a proof as a separate judge, creating the worker's, treasury's and judge's accounts, with exact shares", async () => {
    const judge = await generateKeyPairSigner();
    const pay = 1_000_000n;
    const judgeFee = 100_000n;
    const { w, client, owner, nonce, tokens } = await escrowed(judge, pay, judgeFee);
    w.chain.svm.airdrop(judge.address, lamports(SOL));
    const worker = (await generateKeyPairSigner()).address;
    for (const wallet of [worker, judge.address, w.feeRecipient.address]) {
      expect(await tokens(wallet)).toBeNull();
    }
    const ownerLamports = w.chain.svm.getBalance(owner.address);

    await client.settleProof({ judge, owner: owner.address, nonce, payTo: worker, result: 2n });
    const fee = ((pay - judgeFee) * BigInt(FEE_BPS)) / 10_000n;
    expect(await tokens(worker)).toBe(pay - judgeFee - fee);
    expect(await tokens(judge.address)).toBe(judgeFee);
    expect(await tokens(w.feeRecipient.address)).toBe(fee);
    const held = await Promise.all([worker, judge.address, w.feeRecipient.address].map((wallet) => tokens(wallet)));
    expect(held.reduce<bigint>((sum, amount) => sum + (amount ?? 0n), 0n)).toBe(pay);
    expect((await client.intent(owner.address, nonce))?.intent).toMatchObject({ status: IntentStatus.Filled, filled: pay });
    expect(w.chain.svm.getBalance(owner.address)).toBe(ownerLamports);
    expect(w.chain.svm.getBalance(judge.address)).toBeLessThan(SOL);
  });

  it("lets another wallet pay the fee and rent so the judge needs no SOL", async () => {
    const judge = await generateKeyPairSigner();
    const { client, owner, nonce, tokens, w } = await escrowed(judge, 2_000_000n, 0n);
    const worker = (await generateKeyPairSigner()).address;

    await client.settleProof({ judge, owner: owner.address, nonce, payTo: worker, result: 1n, payer: owner });
    const fee = (2_000_000n * BigInt(FEE_BPS)) / 10_000n;
    expect(await tokens(worker)).toBe(2_000_000n - fee);
    expect(await tokens(judge.address)).toBeNull();
    expect(w.chain.svm.getBalance(judge.address) ?? 0n).toBe(0n);
  });

  it("refuses to settle anything but an open proof intent its judge signs, and sends nothing", async () => {
    const judge = await generateKeyPairSigner();
    const { w, client, counted, owner, nonce, fresh } = await escrowed(judge, 1_000_000n, 0n);
    w.chain.svm.airdrop(judge.address, lamports(SOL));
    const worker = (await generateKeyPairSigner()).address;
    const settle = (n: bigint, by: KeyPairSigner = judge) => client.settleProof({ judge: by, owner: owner.address, nonce: n, payTo: worker, result: 1n });

    const swap = await client.createIntent({ signer: owner, params: { kind: Kind.SwapExactIn, amountIn: 10n, minOut: 1n }, inputMint: NATIVE_MINT, outputMint: w.outputMint });
    const plain = await client.createIntent({ signer: owner, params: proofOf(judge.address, 10n, 0n, new Uint8Array(32)), inputMint: NATIVE_MINT, outputMint: w.outputMint });
    const before = counted.sends;
    await expect(settle(swap.nonce)).rejects.toThrow(NotSettleable);
    await expect(settle(swap.nonce)).rejects.toThrow("is not an AttestedResult intent");
    await expect(settle(plain.nonce)).rejects.toThrow("commits no spec hash");
    await expect(settle(nonce, await fresh(1n))).rejects.toThrow(`names ${judge.address} as its judge`);
    expect(counted.sends).toBe(before);

    await settle(nonce);
    await expect(settle(nonce)).rejects.toThrow("is not open");
  });
});
