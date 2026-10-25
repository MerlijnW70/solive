import type { Address, Instruction } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { findAssociatedTokenAddress, IntentCoreError, Kind } from "../src/index.js";
import {
  buildCreateIntent,
  buildFillIntent,
  buildFillAttested,
  buildFillAttestedSplit,
  getFillAttestedSplitInstructionDataDecoder,
  buildFlashFill,
  getBeginFillInstructionDataDecoder,
  findEventAuthorityPda,
  findIntentPda,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  validateIxAgainstIdl,
  MAX_CRANK_BOUNTY,
  MAX_CREATE_FEE,
} from "../src/internal.js";
import { InvalidInput } from "../src/errors.js";
import { announced, everyBuilt, feeRecipient, golden42, idl, inputMint, meta, outputMint, owner, ownerSigner, solver, TOKEN, TOKEN_2022 } from "./builder-fixtures.js";

describe("offline builders", () => {
  it("produce instructions the IDL accepts, for every user-facing instruction", async () => {
    for (const [name, ix] of Object.entries(await everyBuilt())) {
      expect(validateIxAgainstIdl(ix, idl), name).toEqual([]);
      expect(ix.programAddress, name).toBe(INTENT_ENGINE_PROGRAM_ADDRESS);
    }
  });

  it("derive the intent, vault, event authority and canonical token accounts", async () => {
    const built = await everyBuilt();
    const create = built["create_intent"];
    if (!create || !golden42) {
      throw new Error("missing fixture");
    }
    const [eventAuthority] = await findEventAuthorityPda();
    const at = (name: string) => {
      const i = idl.instructions
        .find((x) => x.name === "create_intent")
        ?.accounts.findIndex((a) => a.name === name);
      return meta(create, i ?? -1).address;
    };
    expect(at("intent")).toBe(golden42.address);
    expect(at("vault")).toBe(golden42.vault);
    expect(at("event_authority")).toBe(eventAuthority);
    expect(at("owner_input")).toBe(
      await findAssociatedTokenAddress({ owner, mint: inputMint, tokenProgram: TOKEN }),
    );
    expect(at("receiver")).toBe(
      await findAssociatedTokenAddress({ owner, mint: outputMint, tokenProgram: TOKEN_2022 }),
    );
    expect(at("receiver_authority")).toBe(owner);
  });

  it("send fill fees to the recipient's canonical account and omit it when no recipient is given", async () => {
    const base = {
      solver,
      owner,
      nonce: 1n,
      inputMint,
      outputMint,
      inputTokenProgram: TOKEN,
      outputTokenProgram: TOKEN,
      receiver: owner,
      solverOutput: solver.address,
      solverInput: solver.address,
      amountIn: 1n,
      amountOut: 1n,
      maxFeeBps: 100,
    };
    const feeIndex = idl.instructions
      .find((x) => x.name === "fill_intent")
      ?.accounts.findIndex((a) => a.name === "fee_to");
    const withFee = await buildFillIntent({ ...base, feeRecipient });
    const without = await buildFillIntent(base);
    expect(meta(withFee, feeIndex ?? -1).address).toBe(
      await findAssociatedTokenAddress({ owner: feeRecipient, mint: inputMint, tokenProgram: TOKEN }),
    );
    expect(meta(without, feeIndex ?? -1).address).toBe(INTENT_ENGINE_PROGRAM_ADDRESS);
    expect(validateIxAgainstIdl(without, idl)).toEqual([]);
  });

  it("seat each co-author's canonical account and carry the recipients and weights it signs", async () => {
    const recipients = [
      "So1ver1111111111111111111111111111111111111",
      feeRecipient,
      owner,
    ] as Address[];
    const weights = [6000, 3000, 1000];
    const ix = await buildFillAttestedSplit({
      ...announced,
      solver,
      owner,
      nonce: 7n,
      inputMint,
      inputTokenProgram: TOKEN,
      recipients,
      weights,
      feeRecipient,
      amountIn: 400n,
      result: 1n,
      maxFeeBps: 100,
    });
    expect(ix.programAddress).toBe(INTENT_ENGINE_PROGRAM_ADDRESS);
    const slot = (name: string) =>
      idl.instructions
        .find((x) => x.name === "fill_attested_split")
        ?.accounts.findIndex((a) => a.name === name) ?? -1;
    for (const [i, name] of ["recipient0", "recipient1", "recipient2"].entries()) {
      const recipient = recipients[i];
      if (recipient === undefined) {
        throw new Error("missing recipient");
      }
      expect(meta(ix, slot(name)).address).toBe(
        await findAssociatedTokenAddress({ owner: recipient, mint: inputMint, tokenProgram: TOKEN }),
      );
    }
    expect(meta(ix, slot("recipient3")).address).toBe(INTENT_ENGINE_PROGRAM_ADDRESS);
    const data = getFillAttestedSplitInstructionDataDecoder().decode(ix.data ?? new Uint8Array());
    expect(data.claim.recipients).toEqual(recipients);
    expect(data.claim.weights).toEqual(weights);
    expect(data.fill).toEqual({ amountIn: 400n, result: 1n, maxFeeBps: 100 });
  });

  it("seat the claims board and the stake receiver only when given", async () => {
    const claims = "SysvarRent111111111111111111111111111111111" as Address;
    const stakeTo = "SysvarC1ock11111111111111111111111111111111" as Address;
    const base = { solver, owner, nonce: 7n, inputMint, inputTokenProgram: TOKEN, payee: owner, amountIn: 400n, result: 1n, maxFeeBps: 100 };
    const slot = (name: string) =>
      idl.instructions.find((x) => x.name === "fill_attested")?.accounts.findIndex((a) => a.name === name) ?? -1;
    const given = await buildFillAttested({ ...base, claims, stakeTo });
    const without = await buildFillAttested(base);
    expect(meta(given, slot("claims")).address).toBe(claims);
    expect(meta(given, slot("stake_to")).address).toBe(stakeTo);
    expect(meta(without, slot("claims")).address).toBe(INTENT_ENGINE_PROGRAM_ADDRESS);
    expect(meta(without, slot("stake_to")).address).toBe(INTENT_ENGINE_PROGRAM_ADDRESS);
    expect(validateIxAgainstIdl(given, idl)).toEqual([]);
    expect(validateIxAgainstIdl(without, idl)).toEqual([]);
  });

  it("reject a split with no recipients or a weight count that does not match", async () => {
    const base = {
      solver,
      owner,
      nonce: 7n,
      inputMint,
      inputTokenProgram: TOKEN,
      amountIn: 400n,
      result: 1n,
      maxFeeBps: 100,
    };
    await expect(buildFillAttestedSplit({ ...base, ...announced, recipients: [], weights: [] })).rejects.toThrow();
    await expect(
      buildFillAttestedSplit({ ...base, ...announced, recipients: [owner], weights: [5000, 5000] }),
    ).rejects.toThrow();
    await expect(
      buildFillAttestedSplit({
        ...base,
        ...announced,
        recipients: Array.from({ length: 9 }, () => owner),
        weights: Array.from({ length: 9 }, () => 1000),
      }),
    ).rejects.toThrow();
  });

  it("refuse invalid params before anything is signed", async () => {
    await expect(
      buildCreateIntent({
        owner: ownerSigner,
        treasury: feeRecipient,
        maxCreateFee: MAX_CREATE_FEE,
        maxBounty: MAX_CRANK_BOUNTY,
        nonce: 0n,
        params: { kind: Kind.SwapExactIn, amountIn: 0n, minOut: 1n },
        expiresAt: 1n,
        inputMint,
        outputMint,
        inputTokenProgram: TOKEN,
        outputTokenProgram: TOKEN,
      }),
    ).rejects.toEqual(new IntentCoreError("InvalidParams"));
  });

  it("use the intent the owner and nonce name", async () => {
    const built = await everyBuilt();
    const [intent] = await findIntentPda({ owner, nonce: 42n });
    for (const name of ["cancel_intent", "expire_intent", "close_intent", "fill_intent"]) {
      const ix = built[name];
      const i = idl.instructions
        .find((x) => x.name === name)
        ?.accounts.findIndex((a) => a.name === "intent");
      expect(ix && meta(ix, i ?? -1).address, name).toBe(intent);
    }
  });
});

describe("flash fill builder", () => {
  const spec = {
    solver,
    owner,
    nonce: 42n,
    inputMint,
    outputMint,
    inputTokenProgram: TOKEN,
    outputTokenProgram: TOKEN,
    receiver: owner,
    solverOutput: solver.address,
    solverInput: solver.address,
    feeRecipient,
    amountIn: 7n,
    amountOut: 7n,
    maxFeeBps: 100,
  };
  const noop = { programAddress: TOKEN, data: new Uint8Array([1]) } as Instruction;

  it("places begin and end around the route and points begin at end", async () => {
    const cases: [Instruction[], Instruction[]][] = [
      [[], []],
      [[noop], []],
      [[], [noop, noop, noop]],
      [[noop, noop], [noop]],
    ];
    for (const [prefix, route] of cases) {
      const ixs = await buildFlashFill({ ...spec, prefix, route });
      expect(ixs).toHaveLength(prefix.length + route.length + 2);
      const begin = ixs[prefix.length];
      const end = ixs[ixs.length - 1];
      if (!begin || !end) {
        throw new Error("missing");
      }
      expect(validateIxAgainstIdl(begin, idl)).toEqual([]);
      expect(validateIxAgainstIdl(end, idl)).toEqual([]);
      const { endIndex } = getBeginFillInstructionDataDecoder().decode(begin.data ?? new Uint8Array());
      expect(endIndex).toBe(ixs.length - 1);
      const [intent] = await findIntentPda({ owner, nonce: 42n });
      expect(meta(end, 0).address).toBe(intent);
    }
  });

  it("shifts the end index by the instructions placed before the list", async () => {
    for (const baseIndex of [0, 1, 3]) {
      const ixs = await buildFlashFill({ ...spec, baseIndex, prefix: [noop], route: [noop] });
      const { endIndex } = getBeginFillInstructionDataDecoder().decode(ixs[1]?.data ?? new Uint8Array());
      expect(endIndex).toBe(baseIndex + 3);
    }
    for (const baseIndex of [-1, 0.5, Number.NaN]) {
      await expect(buildFlashFill({ ...spec, baseIndex })).rejects.toThrow(
        `baseIndex must be a non-negative integer, got ${baseIndex}`,
      );
    }
    await expect(
      buildFlashFill({ ...spec, baseIndex: 1, route: new Array<Instruction>(0xfffd).fill(noop) }),
    ).resolves.toHaveLength(0xffff);
    await expect(
      buildFlashFill({ ...spec, baseIndex: 2, route: new Array<Instruction>(0xfffd).fill(noop) }),
    ).rejects.toThrow(InvalidInput);
  });

  it("refuses a flash fill too long to index", async () => {
    await expect(
      buildFlashFill({ ...spec, route: new Array<Instruction>(0xffff).fill(noop) }),
    ).rejects.toThrow(InvalidInput);
    await expect(
      buildFlashFill({ ...spec, route: new Array<Instruction>(0xfffe).fill(noop) }),
    ).resolves.toHaveLength(0x10000);
  });
});
