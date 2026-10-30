import {
  type Address,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  generateKeyPairSigner,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  type Instruction,
  type KeyPairSigner,
  lamports,
  none,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
} from "@solana/kit";
import { getTransferSolInstruction } from "@solana-program/system";
import { getMintEncoder } from "@solana-program/token";
import type { LiteSVM } from "litesvm";
import { describe, expect, it, vi } from "vitest";
import { findAssociatedTokenAddress, NATIVE_MINT, TOKEN_PROGRAM_ADDRESS } from "@intent-engine/core";
import { INTENT_ENGINE_PROGRAM_ADDRESS } from "@intent-engine/core/internal";
import { svmTransport } from "../src/svm.js";
import { createTestWorld, ECONOMICS_UNSET, type TestWorld } from "../src/testing.js";
import type { Transport } from "../src/index.js";

const NOW = 1_700_000_000n;
const TOKEN_HEAD = 64;

async function signed(transport: Transport, payer: KeyPairSigner, instructions: readonly Instruction[]) {
  const latest = await transport.latestBlockhash();
  const tx = await signTransactionMessageWithSigners(
    pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(latest, m),
      (m) => appendTransactionMessageInstructions(instructions, m),
    ),
  );
  return { tx, wire: getBase64EncodedWireTransaction(tx), signature: getSignatureFromTransaction(tx), latest };
}

const addressBytes = (address: Address): number[] => Array.from(getAddressEncoder().encode(address));

function put(world: TestWorld, address: Address, owner: Address, data: Uint8Array): void {
  world.svm.setAccount({ address, data, executable: false, lamports: lamports(world.svm.minimumBalanceForRentExemption(BigInt(data.length))), programAddress: owner, space: BigInt(data.length) });
}

async function creditTokens(world: TestWorld, account: Address) {
  const payer = await world.wallet();
  const signature = await world.transport.send([getTransferSolInstruction({ source: payer, destination: account, amount: 1n })], payer);
  return world.transport.transactionOf?.(signature);
}

describe("the svm transport, edge by edge", () => {
  it("puts signature verification back to on after a simulation when the LiteSVM exposes no switch to read it", async () => {
    const world = await createTestWorld({ start: NOW });
    const flags: boolean[] = [];
    const hidden = new Proxy(world.svm, {
      get(target, property) {
        if (property === "inner") {
          return undefined;
        }
        const value: unknown = Reflect.get(target, property, target);
        if (property === "withSigverify") {
          return (flag: boolean) => {
            flags.push(flag);
            return (value as (flag: boolean) => unknown).call(target, flag);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as LiteSVM;
    const transport = svmTransport(hidden, { offline: true });
    const payer = await world.wallet();
    const { wire } = await signed(transport, payer, [getTransferSolInstruction({ source: payer, destination: world.admin.address, amount: 1n })]);
    await transport.simulate?.(wire);
    expect(flags).toEqual([false, true]);
  });

  it("matches a filter whose bytes end exactly where the account ends, and not one that runs past the end", async () => {
    const world = await createTestWorld({ start: NOW });
    const [account] = world.svm.getProgramAccounts(INTENT_ENGINE_PROGRAM_ADDRESS);
    if (account === undefined) {
      throw new Error("the world holds no engine account");
    }
    const data = new Uint8Array(account.data);
    const discriminator = data.slice(0, 8);
    const tail = data.slice(-3);
    const fitting = await world.transport.engineAccounts?.({ discriminator, match: [{ offset: data.length - 3, bytes: tail }] });
    expect((fitting ?? []).map((found) => found.address)).toContain(account.address);
    const overrun = await world.transport.engineAccounts?.({ discriminator, match: [{ offset: data.length - 2, bytes: tail }] });
    expect((overrun ?? []).map((found) => found.address)).not.toContain(account.address);
  });

  it("reads the holdings of a token account that is exactly as long as a token account's head, and none of an account it cannot be", async () => {
    const world = await createTestWorld({ start: NOW });
    const [held, minted, owned, stranger, shortToken] = await Promise.all([generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner(), generateKeyPairSigner()]);
    const head = Uint8Array.from([...addressBytes(minted.address), ...addressBytes(owned.address)]);
    expect(head.length).toBe(TOKEN_HEAD);
    put(world, held.address, TOKEN_PROGRAM_ADDRESS, head);
    expect((await creditTokens(world, held.address))?.tokens).toEqual([{ account: held.address, mint: minted.address, owner: owned.address }]);
    put(world, stranger.address, (await generateKeyPairSigner()).address, new Uint8Array(100).fill(7));
    expect((await creditTokens(world, stranger.address))?.tokens).toBeUndefined();
    put(world, shortToken.address, TOKEN_PROGRAM_ADDRESS, new Uint8Array(10).fill(7));
    expect((await creditTokens(world, shortToken.address))?.tokens).toBeUndefined();
  });

  it("returns the signature of a wire LiteSVM already ran outside the transport, without recording a failure", async () => {
    const world = await createTestWorld({ start: NOW });
    const payer = await world.wallet();
    const { tx, wire, signature, latest } = await signed(world.transport, payer, [getTransferSolInstruction({ source: payer, destination: world.admin.address, amount: 3n })]);
    world.svm.sendTransaction(tx);
    expect(await world.transport.sendWire(wire, latest)).toBe(signature);
    expect(await world.transport.signatureStatuses?.([signature])).toEqual([null]);
  });
});

describe("the test world, edge by edge", () => {
  const engineTransactions = async (world: TestWorld) => (await world.transport.signaturesOf?.(INTENT_ENGINE_PROGRAM_ADDRESS, 20))?.length;

  it("sends the economics update only when a fee differs from the unset one, whichever of them it is", async () => {
    const unset = { ...ECONOMICS_UNSET, feeBps: 5 };
    expect(await engineTransactions(await createTestWorld({ start: NOW, fees: unset }))).toBe(1);
    for (const changed of [{ kindFeeMask: 30 }, { kindFeeBps: [0, 0, 5, 0] as const }, { partnerCutBps: 2_000 }, { crankBounty: 100_000 }, { createFee: 7_000 }]) {
      const world = await createTestWorld({ start: NOW, fees: { ...unset, ...changed } });
      expect(await engineTransactions(world)).toBe(2);
      expect(await world.client.config()).toMatchObject(changed);
    }
  });

  it("airdrops nothing to a wallet asked to hold nothing", async () => {
    const world = await createTestWorld({ start: NOW });
    const airdrop = vi.spyOn(world.svm, "airdrop");
    const empty = await world.wallet(0);
    expect(airdrop).not.toHaveBeenCalled();
    expect(world.svm.getBalance(empty.address)).toBeNull();
    expect(world.svm.getBalance((await world.wallet(1)).address)).toBe(1_000_000_000n);
    expect(airdrop).toHaveBeenCalledTimes(1);
  });

  it("sends no mint instruction for an empty token account of a mint it holds no authority over", async () => {
    const world = await createTestWorld({ start: NOW });
    const keyless = (await generateKeyPairSigner()).address;
    const owner = await world.wallet();
    put(world, keyless, TOKEN_PROGRAM_ADDRESS, Uint8Array.from(getMintEncoder().encode({ mintAuthority: none(), supply: 0n, decimals: 6, isInitialized: true, freezeAuthority: none() })));
    const account = await world.tokens(owner.address, keyless, 0n);
    expect(account).toBe(await findAssociatedTokenAddress({ owner: owner.address, mint: keyless, tokenProgram: TOKEN_PROGRAM_ADDRESS }));
    expect(await world.tokenBalance(owner.address, keyless)).toBe(0n);
  });

  it("sends no sync for an empty wrapped SOL account, and one for a funded one", async () => {
    const world = await createTestWorld({ start: NOW });
    const owner = await world.wallet();
    const empty = await world.tokens(owner.address, NATIVE_MINT, 0n);
    expect((await world.transport.signaturesOf?.(empty, 10))?.length).toBe(1);
    const funded = await world.wallet();
    const account = await world.tokens(funded.address, NATIVE_MINT, 9n);
    expect((await world.transport.signaturesOf?.(account, 10))?.length).toBe(2);
    expect(await world.tokenBalance(funded.address, NATIVE_MINT)).toBe(9n);
  });

  it("reads a token balance only from an account long enough to hold one", async () => {
    const world = await createTestWorld({ start: NOW });
    const owner = await world.wallet();
    const mint = await world.mint(6);
    const account = await findAssociatedTokenAddress({ owner: owner.address, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    for (const [length, expected] of [
      [60, 0n],
      [71, 0n],
      [72, 5n],
    ] as const) {
      const data = new Uint8Array(length);
      if (length >= 72) {
        new DataView(data.buffer).setBigUint64(64, 5n, true);
      }
      put(world, account, TOKEN_PROGRAM_ADDRESS, data);
      expect(await world.tokenBalance(owner.address, mint)).toBe(expected);
    }
  });
});
