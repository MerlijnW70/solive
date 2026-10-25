import {
  type Address,
  createNoopSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Instruction,
} from "@solana/kit";
import { getApproveCheckedInstructionDataDecoder } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import { findAssociatedTokenAddress, IntentCoreError, Kind } from "../src/index.js";
import {
  U64_MAX,
  buildApproveForIntent,
  buildInitConfig,
  buildLowerPause,
  buildRaisePause,
  buildUpdateConfig,
  buildProposeAdmin,
  buildAcceptAdmin,
  getUpdateConfigInstructionDataDecoder,
  getProposeAdminInstructionDataDecoder,
  findProgramDataAddress,
  getInitConfigInstructionDataDecoder,
  getLowerPauseInstructionDataDecoder,
  getRaisePauseInstructionDataDecoder,
  UPGRADEABLE_LOADER_ADDRESS,
  buildCloseIntent,
  buildExpireIntent,
  buildFillAttestedSplit,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  validateIxAgainstIdl,
  MAX_RECIPIENTS,
  MAX_SPLIT_RECIPIENTS,
  splitN,
  splitPayout,
} from "../src/internal.js";
import { InvalidInput } from "../src/errors.js";
import { announced, feeRecipient, idl, inputMint, meta, owner, solver, splitWeights, swap, TOKEN } from "./builder-fixtures.js";

describe("refund overrides and exact approvals", () => {
  const ref = { owner, nonce: 3n, inputMint, tokenProgram: TOKEN };
  const other = "So11111111111111111111111111111111111111112" as Address;

  it("defaults expire and close refunds to the canonical account and honours an override", async () => {
    const canonical = await findAssociatedTokenAddress({ owner, mint: inputMint, tokenProgram: TOKEN });
    const cranker = createNoopSigner(solver.address);
    const expireDefault = await buildExpireIntent({ ...ref, cranker });
    const expireOverride = await buildExpireIntent({ ...ref, cranker, refundTo: other });
    const closeDefault = await buildCloseIntent({ ...ref, cranker: solver });
    const closeOverride = await buildCloseIntent({ ...ref, cranker: solver, refundTo: other });
    const refundOf = (ix: Instruction, idx: number) => meta(ix, idx).address;
    const expireIdx = idl.instructions.find((i) => i.name === "expire_intent")?.accounts.findIndex((a) => a.name === "refund_to") ?? -1;
    const closeIdx = idl.instructions.find((i) => i.name === "close_intent")?.accounts.findIndex((a) => a.name === "refund_to") ?? -1;
    expect(refundOf(expireDefault, expireIdx)).toBe(canonical);
    expect(refundOf(expireOverride, expireIdx)).toBe(other);
    expect(refundOf(closeDefault, closeIdx)).toBe(canonical);
    expect(refundOf(closeOverride, closeIdx)).toBe(other);
  });

  it("close intent uses the intent rent payer", async () => {
    const payerIdx = idl.instructions.find((i) => i.name === "close_intent")?.accounts.findIndex((a) => a.name === "rent_payer") ?? -1;
    expect(payerIdx).toBeGreaterThanOrEqual(0);
    const payerOf = (ix: Instruction) => meta(ix, payerIdx).address;
    const relayed = { rentPayer: other };
    expect(payerOf(await buildCloseIntent({ ...ref, cranker: solver, intent: relayed }))).toBe(other);
    expect(payerOf(await buildCloseIntent({ ...ref, cranker: solver, intent: relayed, rentPayer: feeRecipient }))).toBe(feeRecipient);
    expect(payerOf(await buildCloseIntent({ ...ref, cranker: solver, intent: { rentPayer: owner } }))).toBe(owner);
    expect(payerOf(await buildCloseIntent({ ...ref, cranker: solver }))).toBe(owner);
  });

  it("approves exactly the escrow of the intent", async () => {
    const swap = { kind: Kind.SwapExactIn, amountIn: 1234n, minOut: 1n } as const;
    const ix = await buildApproveForIntent({
      owner: createNoopSigner(owner),
      mint: inputMint,
      tokenProgram: TOKEN,
      decimals: 6,
      params: swap,
    });
    expect(getApproveCheckedInstructionDataDecoder().decode(ix.data).amount).toBe(1234n);
    await expect(
      buildApproveForIntent({
        owner: createNoopSigner(owner),
        mint: inputMint,
        tokenProgram: TOKEN,
        decimals: 6,
        params: { ...swap, amountIn: 0n },
      }),
    ).rejects.toThrow();
  });

  it("approve for intent covers the relayer fee", async () => {
    const swap = { kind: Kind.SwapExactIn, amountIn: 1234n, minOut: 1n } as const;
    const approved = async (extra: { relayerFee?: bigint }) =>
      getApproveCheckedInstructionDataDecoder().decode(
        (await buildApproveForIntent({ owner: createNoopSigner(owner), mint: inputMint, tokenProgram: TOKEN, decimals: 6, params: swap, ...extra })).data,
      ).amount;
    expect(await approved({ relayerFee: 66n })).toBe(1300n);
    expect(await approved({ relayerFee: 0n })).toBe(1234n);
    const signed = { relayerFee: 5n, submitBy: 9n, nonce: 1n };
    expect(await approved(signed)).toBe(1239n);
    await expect(approved({ relayerFee: -1n })).rejects.toThrow(InvalidInput);
    await expect(approved({ relayerFee: U64_MAX })).rejects.toThrow(InvalidInput);
  });

  it("approve for intent adds to an existing allowance", async () => {
    const swap = { kind: Kind.SwapExactIn, amountIn: 1234n, minOut: 1n } as const;
    const approved = async (extra: { relayerFee?: bigint; alreadyApproved?: bigint }) =>
      getApproveCheckedInstructionDataDecoder().decode(
        (await buildApproveForIntent({ owner: createNoopSigner(owner), mint: inputMint, tokenProgram: TOKEN, decimals: 6, params: swap, ...extra })).data,
      ).amount;
    expect(await approved({ alreadyApproved: 1_000n })).toBe(2234n);
    expect(await approved({ alreadyApproved: 1_000n, relayerFee: 6n })).toBe(2240n);
    expect(await approved({ alreadyApproved: 0n })).toBe(1234n);
    expect(await approved({ alreadyApproved: U64_MAX - 1234n })).toBe(U64_MAX);
    await expect(approved({ alreadyApproved: U64_MAX - 1233n })).rejects.toThrow(InvalidInput);
    await expect(approved({ alreadyApproved: -5n })).rejects.toThrow(InvalidInput);
  });
});

describe("split payouts", () => {
  it("validate sizes vec arguments of fill_attested_split", async () => {
    const solverSigner = createNoopSigner(owner);
    for (const count of [1, 3, MAX_SPLIT_RECIPIENTS]) {
      const recipients = Array.from({ length: count }, (_, i) => (i % 2 === 0 ? owner : feeRecipient));
      const weights = splitWeights(count);
      const ix = await buildFillAttestedSplit({
        ...announced,
        solver: solverSigner,
        owner,
        nonce: 7n,
        inputMint,
        inputTokenProgram: TOKEN,
        recipients,
        weights,
        amountIn: 400n,
        result: 1n,
        maxFeeBps: 100,
      });
      expect(validateIxAgainstIdl(ix, idl), String(count)).toEqual([]);
      const data = ix.data ?? new Uint8Array();
      const longer = { ...ix, data: new Uint8Array([...data, 0]) };
      expect(validateIxAgainstIdl(longer, idl)).toEqual([`fill_attested_split: data is ${data.length + 1} bytes, expected ${data.length}`]);
      const shorter = { ...ix, data: data.slice(0, -1) };
      expect(validateIxAgainstIdl(shorter, idl)[0]).toMatch(/^fill_attested_split: data is \d+ bytes, expected \d+$/);
    }
  });

  it("caps a split payout at the recipients fill_attested_split takes", () => {
    expect(MAX_SPLIT_RECIPIENTS).toBe(8);
    expect(MAX_RECIPIENTS).toBe(16);
    expect(splitPayout(100n, splitWeights(8))).toHaveLength(8);
    expect(() => splitPayout(100n, splitWeights(9))).toThrow(new IntentCoreError("InvalidParams"));
    expect(splitN(100n, splitWeights(9))).toHaveLength(9);
    expect(() => splitN(100n, splitWeights(9), MAX_SPLIT_RECIPIENTS)).toThrow(new IntentCoreError("InvalidParams"));
  });
});

describe("admin builders", () => {
  it("derives program data from the upgradeable loader and passes every setting through", async () => {
    expect(UPGRADEABLE_LOADER_ADDRESS).toBe("BPFLoaderUpgradeab1e11111111111111111111111");
    const [expected] = await getProgramDerivedAddress({
      programAddress: UPGRADEABLE_LOADER_ADDRESS,
      seeds: [getAddressEncoder().encode(INTENT_ENGINE_PROGRAM_ADDRESS)],
    });
    expect(await findProgramDataAddress()).toBe(expected);
    const authority = createNoopSigner(owner);
    const domain = new Uint8Array(32).fill(9);
    const ix = await buildInitConfig({
      authority,
      domain,
      guardian: solver.address,
      feeRecipient,
      enabledKinds: 6n,
      feeBps: 7,
      paused: 2,
    });
    expect(validateIxAgainstIdl(ix, idl)).toEqual([]);
    const programDataIdx =
      idl.instructions.find((i) => i.name === "init_config")?.accounts.findIndex((a) => a.name === "program_data") ?? -1;
    expect(meta(ix, programDataIdx).address).toBe(expected);
    const args = getInitConfigInstructionDataDecoder().decode(ix.data ?? new Uint8Array());
    expect(args).toMatchObject({
      guardian: solver.address,
      feeRecipient,
      enabledKinds: 6n,
      feeBps: 7,
      paused: 2,
    });
    expect(Array.from(args.domain)).toEqual(Array.from(domain));
    const raise = await buildRaisePause({ authority, flags: 1 });
    const lower = await buildLowerPause({ admin: authority, flags: 3 });
    expect(validateIxAgainstIdl(raise, idl)).toEqual([]);
    expect(validateIxAgainstIdl(lower, idl)).toEqual([]);
    expect(getRaisePauseInstructionDataDecoder().decode(raise.data ?? new Uint8Array()).flags).toBe(1);
    expect(getLowerPauseInstructionDataDecoder().decode(lower.data ?? new Uint8Array()).flags).toBe(3);
    expect(meta(raise, 0).address).toBe(owner);
    expect(meta(lower, 0).address).toBe(owner);
 
    const update = await buildUpdateConfig({
      admin: authority,
      update: { guardian: solver.address, feeRecipient, enabledKinds: 6n, feeBps: 9, fillDisabledKinds: 4n },
    });
    expect(validateIxAgainstIdl(update, idl)).toEqual([]);
    expect(getUpdateConfigInstructionDataDecoder().decode(update.data ?? new Uint8Array())).toMatchObject({
      guardian: solver.address,
      feeRecipient,
      enabledKinds: 6n,
      feeBps: 9,
      fillDisabledKinds: 4n,
    });
    expect(meta(update, 0).address).toBe(owner);
    const propose = await buildProposeAdmin({ admin: authority, pendingAdmin: feeRecipient });
    expect(validateIxAgainstIdl(propose, idl)).toEqual([]);
    expect(getProposeAdminInstructionDataDecoder().decode(propose.data ?? new Uint8Array()).pendingAdmin).toBe(feeRecipient);
    expect(meta(propose, 0).address).toBe(owner);
    const accept = await buildAcceptAdmin({ pendingAdmin: authority });
    expect(validateIxAgainstIdl(accept, idl)).toEqual([]);
    expect(meta(accept, 0).address).toBe(owner);
  });
});
