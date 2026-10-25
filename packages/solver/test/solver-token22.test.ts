import {
  AccountRole,
  type Address,
  generateKeyPairSigner,
  getAddressEncoder,
  type Instruction,
  type KeyPairSigner,
  lamports,
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import { getCreateAssociatedTokenIdempotentInstructionAsync, getMintSize, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { LiteSVM } from "litesvm";
import { describe, expect, it } from "vitest";
import { findAssociatedTokenAddress } from "@intent-engine/core";
import {
  createdRent,
  remembering,
  rentExempt,
  TOKEN_2022_ACCOUNT_SPACE,
  TOKEN_2022_PROGRAM,
  TOKEN_ACCOUNT_SPACE,
  tokenAccountSpace,
} from "../src/index.js";
import { svmTools } from "./solver-engine.js";

let svm: LiteSVM;
const { send, funded } = svmTools(() => svm);

describe("token 2022 accounts the solver opens", () => {
  const TRANSFER_FEE = Uint8Array.from([26, 0, 0, 0, 50, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  const NON_TRANSFERABLE = Uint8Array.from([32]);
  const MINT_SPACE = { transferFee: 112, nonTransferable: 4, transferHook: 68 };

  async function mint2022(payer: KeyPairSigner, extensions: { data: Uint8Array; space: number }[]): Promise<Address> {
    const m = await generateKeyPairSigner();
    const space = BigInt(extensions.length === 0 ? getMintSize() : TOKEN_ACCOUNT_SPACE + 1 + extensions.reduce((sum, e) => sum + e.space, 0));
    const mintData = new Uint8Array(35);
    mintData.set([20, 6]);
    mintData.set(getAddressEncoder().encode(payer.address), 2);
    const only = (data: Uint8Array): Instruction => ({
      programAddress: TOKEN_2022_PROGRAM,
      accounts: [{ address: m.address, role: AccountRole.WRITABLE }],
      data,
    });
    await send(payer, [
      getCreateAccountInstruction({
        payer,
        newAccount: m,
        lamports: svm.minimumBalanceForRentExemption(space),
        space,
        programAddress: TOKEN_2022_PROGRAM,
      }),
      ...extensions.map((e) => only(e.data)),
      only(mintData),
    ]);
    return m.address;
  }

  it("token 2022 rent follows the mint extensions", async () => {
    svm = new LiteSVM();
    const payer = await funded();
    const hookData = new Uint8Array(66);
    hookData.set([36, 0]);
    hookData.set(getAddressEncoder().encode(payer.address), 2);
    hookData.set(getAddressEncoder().encode((await generateKeyPairSigner()).address), 34);
    const fee = { data: TRANSFER_FEE, space: MINT_SPACE.transferFee };
    const cases = [
      { mint: await mint2022(payer, []), space: TOKEN_2022_ACCOUNT_SPACE },
      { mint: await mint2022(payer, [fee]), space: TOKEN_2022_ACCOUNT_SPACE + 12 },
      {
        mint: await mint2022(payer, [
          fee,
          { data: hookData, space: MINT_SPACE.transferHook },
          { data: NON_TRANSFERABLE, space: MINT_SPACE.nonTransferable },
        ]),
        space: TOKEN_2022_ACCOUNT_SPACE + 12 + 5 + 4,
      },
    ];
    const reads: Address[] = [];
    const unused = () => Promise.reject(new Error("unused"));
    const chain = remembering({
      config: unused,
      intents: unused,
      now: unused,
      tokenProgram: unused,
      exists: unused,
      lookupTables: unused,
      blockhash: unused,
      tokenAmount: unused,
      mintData: async (m) => {
        reads.push(m);
        const account = svm.getAccount(m);
        return account.exists ? new Uint8Array(account.data) : null;
      },
    });
    for (const { mint: m, space } of cases) {
      const owner = (await generateKeyPairSigner()).address;
      const create = await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner, mint: m, tokenProgram: TOKEN_2022_PROGRAM });
      const rent = await createdRent([create, create], async () => false, (address) => chain.mintData?.(address) ?? Promise.resolve(null));
      expect(await createdRent([create], async () => false, (address) => chain.mintData?.(address) ?? Promise.resolve(null))).toBe(rent);
      await send(payer, [create]);
      const opened = svm.getAccount(await findAssociatedTokenAddress({ owner, mint: m, tokenProgram: TOKEN_2022_PROGRAM }));
      if (!opened.exists) {
        throw new Error("token account missing");
      }
      expect(opened.data.length).toBe(space);
      expect(rent).toBe(opened.lamports);
      expect(rent).toBe(rentExempt(space));
      expect(tokenAccountSpace(TOKEN_2022_PROGRAM, (await chain.mintData?.(m)) ?? null)).toBe(space);
    }
    expect(reads).toEqual(cases.map((c) => c.mint));
    expect(tokenAccountSpace(TOKEN_PROGRAM_ADDRESS, null)).toBe(TOKEN_ACCOUNT_SPACE);
    expect(tokenAccountSpace(TOKEN_2022_PROGRAM, null)).toBe(TOKEN_2022_ACCOUNT_SPACE);
  });
});
