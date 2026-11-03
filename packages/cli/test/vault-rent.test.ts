import { type Address, generateKeyPairSigner, lamports, none } from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import { getInitializeAccount3Instruction, getMintEncoder } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { findVaultPda, TOKEN_2022_PROGRAM_ADDRESS } from "@intent-engine/core/internal";
import { TOKEN_ACCOUNT_BYTES, vaultBytes } from "../src/agent/budget.js";
import { escrowCosts, vaultRent } from "../src/agent/wallet/costs.js";
import { funded, h, mint as plainMint, send, transport, world } from "./harness.js";
import { heldEscrow } from "./held-kit.js";
import { keyed } from "./announce.js";

const WORK = "5c".repeat(32);
const VAULT = "its token vault";

function extended(extensions: readonly (readonly [number, number])[]): Uint8Array {
  const base = getMintEncoder().encode({ mintAuthority: none(), supply: 0n, decimals: 6, isInitialized: true, freezeAuthority: none() });
  const size = extensions.reduce((total, [, length]) => total + 4 + length, 166);
  const data = new Uint8Array(size);
  data.set(base);
  data[165] = 1;
  const view = new DataView(data.buffer);
  let at = 166;
  for (const [type, length] of extensions) {
    view.setUint16(at, type, true);
    view.setUint16(at + 2, length, true);
    at += 4 + length;
  }
  return data;
}

async function presetMint(data: Uint8Array): Promise<Address> {
  const at = (await generateKeyPairSigner()).address;
  h.svm.setAccount({ address: at, data, executable: false, lamports: lamports(h.svm.minimumBalanceForRentExemption(BigInt(data.length))), programAddress: TOKEN_2022_PROGRAM_ADDRESS, space: BigInt(data.length) });
  return at;
}

async function opens(mint: Address, space: number): Promise<boolean> {
  const payer = await funded();
  const account = await generateKeyPairSigner();
  return send(payer, [
    getCreateAccountInstruction({ payer, newAccount: account, lamports: h.svm.minimumBalanceForRentExemption(BigInt(space)), space, programAddress: TOKEN_2022_PROGRAM_ADDRESS }),
    getInitializeAccount3Instruction({ account: account.address, mint, owner: payer.address }, { programAddress: TOKEN_2022_PROGRAM_ADDRESS }),
  ]).then(
    () => true,
    () => false,
  );
}

const vaultLine = async (owner: Address, sell: Address, buy: Address): Promise<bigint | undefined> =>
  (await escrowCosts(transport, { owner, sell, buy, claims: false })).rent.find((cost) => cost.what === VAULT)?.lamports;

describe("the vault an escrow opens", () => {
  it("is as large as the program makes it for a Token-2022 sell mint, and the preview prices that size", async () => {
    const w = await world();
    const judge = await keyed();
    const made = await heldEscrow(await keyed(), WORK, transport, judge.address);
    const [vault] = await findVaultPda({ intent: made.intent });
    const opened = h.svm.getAccount(vault);
    const mintAccount = h.svm.getAccount(made.mint);
    expect(opened.exists && mintAccount.exists).toBe(true);
    if (!opened.exists || !mintAccount.exists) {
      return;
    }
    const sized = vaultBytes({ owner: mintAccount.programAddress, data: mintAccount.data });
    expect([opened.programAddress, opened.data.length, sized]).toEqual([TOKEN_2022_PROGRAM_ADDRESS, TOKEN_ACCOUNT_BYTES, TOKEN_ACCOUNT_BYTES]);
    expect(await vaultRent(transport, made.mint)).toBe(BigInt(opened.lamports));
    expect(await vaultLine(made.owner.address, made.mint, w.outputMint)).toBe(BigInt(opened.lamports));
  });

  it.each([
    ["a transfer fee", [[1, 108]], 178],
    ["a non-transferable mint", [[9, 0]], 174],
    ["a transfer hook", [[14, 64]], 171],
    ["a transfer fee and a transfer hook", [[1, 108], [14, 64]], 183],
    ["every extension the program accepts", [[10, 52], [18, 64], [19, 8], [20, 64], [21, 80], [22, 64], [23, 72], [25, 56]], 165],
  ] as const)("sizes a Token-2022 vault for %s the way the token program needs it, and the preview shows that rent", async (_, extensions, bytes) => {
    const w = await world();
    const data = extended(extensions);
    const sell = await presetMint(data);
    expect(vaultBytes({ owner: TOKEN_2022_PROGRAM_ADDRESS, data })).toBe(bytes);
    expect(await opens(sell, bytes)).toBe(true);
    if (bytes > TOKEN_ACCOUNT_BYTES) {
      expect(await opens(sell, TOKEN_ACCOUNT_BYTES)).toBe(false);
    }
    const rent = h.svm.minimumBalanceForRentExemption(BigInt(bytes));
    expect(await vaultLine(w.owner.address, sell, w.outputMint)).toBe(rent);
    expect(await vaultLine(w.owner.address, await plainMint(w.authority), w.outputMint)).toBe(h.svm.minimumBalanceForRentExemption(BigInt(TOKEN_ACCOUNT_BYTES)));
  });

  it("sizes a classic token vault at the base size whatever its data", () => {
    expect(vaultBytes({ owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address, data: extended([[1, 108]]) })).toBe(TOKEN_ACCOUNT_BYTES);
  });
});
