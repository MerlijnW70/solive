import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { type Address, generateKeyPairSigner, type Instruction, type KeyPairSigner, lamports, none } from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  getCreateAssociatedTokenIdempotentInstructionAsync,
  getInitializeAccount3Instruction,
  getMintEncoder,
  getMintSize,
  getMintToInstruction,
  getTokenSize,
} from "@solana-program/token";
import { describe, expect, it } from "vitest";
import {
  attestedProofMessage,
  buildCloseIntent,
  buildExpireIntent,
  buildFillAttested,
  buildFillIntent,
  buildUpdateEconomics,
  findAssociatedTokenAddress,
  findEventAuthorityPda,
  findIntentPda,
  getCancelIntentInstructionAsync,
  getIntentSize,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  IntentStatus,
  Kind,
  NATIVE_MINT,
  signEd25519Instruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@intent-engine/core";
import { createClient, EscrowExpired, NotSettleable, type Transport } from "../src/index.js";
import { FEE_BPS, NOW, world } from "./svm.js";

const ROOT = process.env["INTENT_ENGINE_ROOT"] ?? fileURLToPath(new URL("../../..", import.meta.url));
const PAGE = readFileSync(`${ROOT}/docs/sdk.md`, "utf8") + "\n" + readFileSync(`${ROOT}/docs/sdk-client.md`, "utf8");
const LOCAL = "http://127.0.0.1:8899";
const SOL = 1_000_000_000n;
const SIGNATURE_FEE = 5_000n;
const BOUNTY = 20_000;
const CREATE_FEE = 30_000;
const TTL = 600n;
const PAY = SOL / 100n;
const JUDGE_FEE = PAY / 10n;
const SELL = SOL / 10n;
const MIN_OUT = 5_000_000n;
const SPEC = new Uint8Array(createHash("sha256").update("the spec").digest());

const CLAIMS = {
  fill: "Any wallet other than the owner and the receiver can fill an open swap intent before it expires.",
  settle: "Only a verdict signed by the judge the intent names settles a proof escrow; any wallet can send that signed verdict and pay for it.",
  late: "A fill or settle at or after the expiry fails with `IntentExpired`; `settleProof` throws `EscrowExpired` before it sends.",
  stranger: "Only the owner can cancel; another wallet's cancel fails with `Unauthorized`.",
  cancel: "The owner can cancel an open proof escrow until the judge settles it, also after it expires as long as nobody has expired it.",
  settled: "After a settle, the owner's cancel fails with `InvalidTransition`.",
  refused: "After a cancel, the judge's settle fails: `settleProof` throws `NotSettleable` before it sends, and the engine refuses the same transaction with `InvalidTransition`.",
  expire: "Anyone can expire an open intent at or after its expiry, which returns the escrow to the owner's token account and pays the expirer the crank bounty; before the expiry it fails with `NotExpired`.",
  close: "Anyone can close a filled, cancelled or expired intent, which returns the rent of the intent and its escrow account to the wallet that paid it, the owner for `createIntent`; the closer earns the crank bounty the intent still holds, except on a cancelled intent, where it goes to that wallet too.",
  open: "Closing an open intent fails with `InvalidTransition`.",
};

const section = (heading: string) => {
  const start = PAGE.indexOf(`\n## ${heading}\n`);
  const end = PAGE.indexOf("\n## ", start + 1);
  return start < 0 ? "" : PAGE.slice(start, end < 0 ? undefined : end);
};

const ata = (owner: Address, mint: Address) => findAssociatedTokenAddress({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });

async function setup() {
  const w = await world();
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
  const client = createClient({ url: LOCAL, transport: w.chain.transport });
  const settings = await client.config();
  const [a = 0, b = 0, c = 0, d = 0] = settings.kindFeeBps;
  await client.send(
    [
      await buildUpdateEconomics({
        admin: w.authority,
        economics: {
          kindFeeMask: settings.kindFeeMask,
          kindFeeBps: [a, b, c, d],
          partnerCutBps: settings.partnerCutBps,
          crankBounty: BOUNTY,
          createFee: CREATE_FEE,
        },
      }),
    ],
    w.authority,
  );
  const svm = w.chain.svm;
  const fresh = async () => {
    const signer = await generateKeyPairSigner();
    svm.airdrop(signer.address, lamports(10n * SOL));
    return signer;
  };
  const sol = (wallet: Address) => svm.getBalance(wallet) ?? 0n;
  const tokens = async (owner: Address, mint: Address = NATIVE_MINT) => {
    const found = svm.getAccount(await ata(owner, mint));
    return found.exists ? new DataView(found.data.buffer, found.data.byteOffset).getBigUint64(64, true) : null;
  };
  const at = (time: bigint) => {
    const clock = svm.getClock();
    clock.unixTimestamp = time;
    svm.setClock(clock);
  };
  const failure = async (pending: Promise<unknown>) => client.explain(await pending.then(() => null, (error: unknown) => error))?.name;
  const status = async (owner: Address, nonce: bigint) => (await client.intent(owner, nonce))?.intent.status;
  const swap = async (owner: KeyPairSigner, receiver?: Address) =>
    client.createIntent({
      signer: owner,
      params: { kind: Kind.SwapExactIn, amountIn: SELL, minOut: MIN_OUT },
      inputMint: NATIVE_MINT,
      outputMint: w.outputMint,
      expiresIn: TTL,
      ...(receiver === undefined ? {} : { receiver }),
    });
  const escrow = async (owner: KeyPairSigner, judge: Address) =>
    client.createIntent({
      signer: owner,
      params: { kind: Kind.AttestedResult, amountIn: PAY, minResult: 1n, maxResult: 1n, attestor: judge, specHash: SPEC, judgeFee: JUDGE_FEE },
      inputMint: NATIVE_MINT,
      outputMint: w.outputMint,
      expiresIn: TTL,
    });
  const outputFor = async (holder: KeyPairSigner, apart = false) => {
    const minted: Instruction[] = [];
    let account = await ata(holder.address, w.outputMint);
    if (apart) {
      const created = await generateKeyPairSigner();
      account = created.address;
      minted.push(
        getCreateAccountInstruction({
          payer: holder,
          newAccount: created,
          lamports: svm.minimumBalanceForRentExemption(BigInt(getTokenSize())),
          space: getTokenSize(),
          programAddress: TOKEN_PROGRAM_ADDRESS,
        }),
        getInitializeAccount3Instruction({ account, mint: w.outputMint, owner: holder.address }),
      );
    } else {
      minted.push(await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: holder, owner: holder.address, mint: w.outputMint }));
    }
    await w.chain.transport.send(minted, holder);
    await w.chain.transport.send([getMintToInstruction({ mint: w.outputMint, token: account, mintAuthority: w.authority, amount: MIN_OUT })], w.authority);
    return account;
  };
  const fill = async (solver: KeyPairSigner, owner: Address, nonce: bigint, solverOutput: Address) => {
    const held = await client.intent(owner, nonce);
    return client.send(
      [
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: solver, owner: solver.address, mint: NATIVE_MINT }),
        await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: solver, owner: w.feeRecipient.address, mint: NATIVE_MINT }),
        await buildFillIntent({
          solver,
          owner,
          nonce,
          inputMint: NATIVE_MINT,
          outputMint: w.outputMint,
          inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
          outputTokenProgram: TOKEN_PROGRAM_ADDRESS,
          receiver: held?.intent.receiver ?? owner,
          solverOutput,
          solverInput: await ata(solver.address, NATIVE_MINT),
          feeRecipient: w.feeRecipient.address,
          amountIn: SELL,
          amountOut: MIN_OUT,
          maxFeeBps: FEE_BPS,
        }),
      ],
      solver,
    );
  };
  const verdict = async (by: KeyPairSigner, sender: KeyPairSigner, owner: Address, nonce: bigint, judge: Address, payTo: Address) => {
    const held = await client.intent(owner, nonce);
    if (held === null) {
      throw new Error("no intent");
    }
    const payee = await ata(payTo, NATIVE_MINT);
    const fields = { amountIn: held.intent.escrowed - held.intent.filled, result: 1n, maxFeeBps: FEE_BPS };
    const message = await attestedProofMessage(by.address, {
      ...fields,
      domain: Uint8Array.from(settings.domain),
      intent: held.address,
      payee,
      filled: held.intent.filled,
      revision: held.intent.revision,
      specHash: SPEC,
    });
    const accounts = await Promise.all(
      [payTo, judge, w.feeRecipient.address].map((wallet) => getCreateAssociatedTokenIdempotentInstructionAsync({ payer: sender, owner: wallet, mint: NATIVE_MINT })),
    );
    return client.send(
      [
        ...accounts,
        await signEd25519Instruction(by, message),
        await buildFillAttested({
          ...fields,
          solver: sender,
          owner,
          nonce,
          inputMint: NATIVE_MINT,
          inputTokenProgram: TOKEN_PROGRAM_ADDRESS,
          payee,
          feeRecipient: w.feeRecipient.address,
          judge,
        }),
      ],
      sender,
    );
  };
  const crank = { inputMint: NATIVE_MINT, tokenProgram: TOKEN_PROGRAM_ADDRESS };
  const expire = async (cranker: KeyPairSigner, owner: Address, nonce: bigint) =>
    client.send([await buildExpireIntent({ ...crank, cranker, owner, nonce })], cranker);
  const close = async (cranker: KeyPairSigner, owner: Address, nonce: bigint) =>
    client.send([await buildCloseIntent({ ...crank, cranker, owner, nonce })], cranker);
  return { w, svm, client, fresh, sol, tokens, at, failure, status, swap, escrow, outputFor, fill, verdict, expire, close };
}

describe("who can do what", () => {
  it("states on the sdk page exactly the claims these tests assert", () => {
    const bullets = [...section("Who can do what").matchAll(/^- (.+)$/gm)].map((m) => m[1]);
    expect(bullets).toEqual(Object.values(CLAIMS));
  });

  it(CLAIMS.fill, async () => {
    const { w, fresh, swap, outputFor, fill, failure, status, tokens } = await setup();
    const owner = await fresh();
    const receiver = await fresh();
    const own = await swap(owner);
    expect(await failure(fill(owner, owner.address, own.nonce, await outputFor(owner, true)))).toBe("SolverOutputNotAllowed");
    const theirs = await swap(owner, receiver.address);
    expect(await failure(fill(receiver, owner.address, theirs.nonce, await outputFor(receiver, true)))).toBe("SolverOutputNotAllowed");
    const solver = await fresh();
    await fill(solver, owner.address, own.nonce, await outputFor(solver));
    await fill(solver, owner.address, theirs.nonce, await outputFor(solver));
    expect(await status(owner.address, own.nonce)).toBe(IntentStatus.Filled);
    expect(await status(owner.address, theirs.nonce)).toBe(IntentStatus.Filled);
    expect(await tokens(owner.address, w.outputMint)).toBe(MIN_OUT);
    expect(await tokens(receiver.address, w.outputMint)).toBe(MIN_OUT);
  });

  it(CLAIMS.settle, async () => {
    const { w, fresh, escrow, verdict, failure, status, tokens } = await setup();
    const owner = await fresh();
    const judge = await generateKeyPairSigner();
    const worker = (await generateKeyPairSigner()).address;
    const job = await escrow(owner, judge.address);
    for (const forger of [owner, await fresh()]) {
      expect(await failure(verdict(forger, forger, owner.address, job.nonce, judge.address, worker))).toBe("SigPubkey");
    }
    const sender = await fresh();
    await verdict(judge, sender, owner.address, job.nonce, judge.address, worker);
    expect(await status(owner.address, job.nonce)).toBe(IntentStatus.Filled);
    expect(await tokens(judge.address)).toBe(JUDGE_FEE);
    expect((await tokens(worker)) ?? 0n).toBeGreaterThan(0n);
    expect(w.chain.svm.getBalance(judge.address) ?? 0n).toBe(0n);
  });

  it(CLAIMS.late, async () => {
    const { w, client, fresh, swap, escrow, outputFor, fill, failure, status, at } = await setup();
    const owner = await fresh();
    const judge = await generateKeyPairSigner();
    const solver = await fresh();
    const output = await outputFor(solver);
    const trade = await swap(owner);
    const job = await escrow(owner, judge.address);
    let held: readonly Instruction[] = [];
    const holding: Transport = {
      ...w.chain.transport,
      send: async (instructions) => {
        held = instructions;
        throw new Error("held back");
      },
    };
    const input = { judge, payer: owner, owner: owner.address, nonce: job.nonce, payTo: solver.address, result: 1n };
    await expect(createClient({ url: LOCAL, transport: holding }).settleProof(input)).rejects.toThrow("held back");
    at(NOW + TTL);
    expect(await failure(fill(solver, owner.address, trade.nonce, output))).toBe("IntentExpired");
    await expect(client.settleProof(input)).rejects.toThrow(EscrowExpired);
    expect(await failure(w.chain.transport.send(held, owner))).toBe("IntentExpired");
    at(NOW + TTL + 1n);
    expect(await failure(fill(solver, owner.address, trade.nonce, output))).toBe("IntentExpired");
    expect(await status(owner.address, trade.nonce)).toBe(IntentStatus.Open);
    expect(await status(owner.address, job.nonce)).toBe(IntentStatus.Open);
  });

  it(CLAIMS.stranger, async () => {
    const { client, fresh, escrow, failure, status, tokens } = await setup();
    const owner = await fresh();
    const stranger = await fresh();
    const job = await escrow(owner, (await generateKeyPairSigner()).address);
    await client.send([await getCreateAssociatedTokenIdempotentInstructionAsync({ payer: stranger, owner: stranger.address, mint: NATIVE_MINT })], stranger);
    const [eventAuthority] = await findEventAuthorityPda();
    const cancel = await getCancelIntentInstructionAsync({
      owner: stranger,
      intent: job.intent,
      inputMint: NATIVE_MINT,
      refundTo: await ata(stranger.address, NATIVE_MINT),
      eventAuthority,
      program: INTENT_ENGINE_PROGRAM_ADDRESS,
      ext: new Uint8Array(),
    });
    expect(await failure(client.send([cancel], stranger))).toBe("Unauthorized");
    expect(await status(owner.address, job.nonce)).toBe(IntentStatus.Open);
    expect(await tokens(stranger.address)).toBe(0n);
  });

  it(CLAIMS.cancel, async () => {
    const { client, fresh, escrow, expire, failure, status, tokens, at } = await setup();
    const owner = await fresh();
    const judge = (await generateKeyPairSigner()).address;
    const now = await escrow(owner, judge);
    const late = await escrow(owner, judge);
    const expired = await escrow(owner, judge);
    await client.cancel(owner, now.nonce);
    expect(await tokens(owner.address)).toBe(PAY);
    at(NOW + TTL + 1n);
    await client.cancel(owner, late.nonce);
    expect(await tokens(owner.address)).toBe(2n * PAY);
    await expire(await fresh(), owner.address, expired.nonce);
    expect(await failure(client.cancel(owner, expired.nonce))).toBe("InvalidTransition");
    expect(await status(owner.address, now.nonce)).toBe(IntentStatus.Cancelled);
    expect(await status(owner.address, late.nonce)).toBe(IntentStatus.Cancelled);
    expect(await status(owner.address, expired.nonce)).toBe(IntentStatus.Expired);
  });

  it(CLAIMS.settled, async () => {
    const { client, fresh, escrow, failure, status } = await setup();
    const owner = await fresh();
    const judge = await generateKeyPairSigner();
    const job = await escrow(owner, judge.address);
    await client.settleProof({ judge, payer: owner, owner: owner.address, nonce: job.nonce, payTo: (await generateKeyPairSigner()).address, result: 1n });
    expect(await failure(client.cancel(owner, job.nonce))).toBe("InvalidTransition");
    expect(await status(owner.address, job.nonce)).toBe(IntentStatus.Filled);
  });

  it(CLAIMS.refused, async () => {
    const { w, client, fresh, escrow, failure, status, tokens } = await setup();
    const owner = await fresh();
    const judge = await generateKeyPairSigner();
    const worker = (await generateKeyPairSigner()).address;
    const job = await escrow(owner, judge.address);
    let held: readonly Instruction[] = [];
    const holding: Transport = {
      ...w.chain.transport,
      send: async (instructions) => {
        held = instructions;
        throw new Error("held back");
      },
    };
    const input = { judge, payer: owner, owner: owner.address, nonce: job.nonce, payTo: worker, result: 1n };
    await expect(createClient({ url: LOCAL, transport: holding }).settleProof(input)).rejects.toThrow("held back");
    expect(held.length).toBeGreaterThan(0);
    await client.cancel(owner, job.nonce);
    await expect(client.settleProof(input)).rejects.toThrow(NotSettleable);
    expect(await failure(w.chain.transport.send(held, owner))).toBe("InvalidTransition");
    expect(await status(owner.address, job.nonce)).toBe(IntentStatus.Cancelled);
    expect(await tokens(owner.address)).toBe(PAY);
    expect(await tokens(worker)).toBeNull();
  });

  it(CLAIMS.expire, async () => {
    const { fresh, swap, expire, failure, status, tokens, sol, at } = await setup();
    const owner = await fresh();
    const cranker = await fresh();
    const trade = await swap(owner);
    expect(await failure(expire(cranker, owner.address, trade.nonce))).toBe("NotExpired");
    at(NOW + TTL - 1n);
    expect(await failure(expire(cranker, owner.address, trade.nonce))).toBe("NotExpired");
    at(NOW + TTL);
    const before = sol(cranker.address);
    await expire(cranker, owner.address, trade.nonce);
    expect(sol(cranker.address) - before).toBe(BigInt(BOUNTY) - SIGNATURE_FEE);
    expect(await status(owner.address, trade.nonce)).toBe(IntentStatus.Expired);
    expect(await tokens(owner.address)).toBe(SELL);
  });

  it(CLAIMS.close, async () => {
    const { svm, client, fresh, swap, outputFor, fill, expire, close, sol, at } = await setup();
    const owner = await fresh();
    const closer = await fresh();
    const solver = await fresh();
    const filled = await swap(owner);
    const cancelled = await swap(owner);
    const expired = await swap(owner);
    await fill(solver, owner.address, filled.nonce, await outputFor(solver));
    await client.cancel(owner, cancelled.nonce);
    at(NOW + TTL);
    await expire(await fresh(), owner.address, expired.nonce);
    const rent = svm.minimumBalanceForRentExemption(BigInt(getIntentSize())) + svm.minimumBalanceForRentExemption(BigInt(getTokenSize()));
    const bounty = BigInt(BOUNTY);
    for (const [nonce, toCloser, toOwner] of [
      [filled.nonce, bounty, rent],
      [cancelled.nonce, 0n, rent + bounty],
      [expired.nonce, 0n, rent],
    ] as const) {
      const [ownerBefore, closerBefore] = [sol(owner.address), sol(closer.address)];
      await close(closer, owner.address, nonce);
      expect(sol(owner.address) - ownerBefore).toBe(toOwner);
      expect(sol(closer.address) - closerBefore).toBe(toCloser - SIGNATURE_FEE);
      expect(await client.intent(owner.address, nonce)).toBeNull();
      expect(svm.getAccount((await findIntentPda({ owner: owner.address, nonce }))[0]).exists).toBe(false);
    }
  });

  it(CLAIMS.open, async () => {
    const { fresh, swap, close, failure, status } = await setup();
    const owner = await fresh();
    const trade = await swap(owner);
    expect(await failure(close(await fresh(), owner.address, trade.nonce))).toBe("InvalidTransition");
    expect(await status(owner.address, trade.nonce)).toBe(IntentStatus.Open);
  });
});
