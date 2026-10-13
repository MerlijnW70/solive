import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AccountRole,
  type Address,
  createNoopSigner,
  getAddressEncoder,
  getProgramDerivedAddress,
  type Instruction,
} from "@solana/kit";
import { getApproveCheckedInstructionDataDecoder } from "@solana-program/token";
import { describe, expect, it } from "vitest";
import {
  buildAdvanceEpoch,
  encodePartner,
  nextEpoch,
  remainingOf,
  feeBpsFor,
  IntentStatus,
  U64_MAX,
  buildAdvanceNonce,
  buildApproveForIntent,
  buildCancelIntent,
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
  buildCreateIntent,
  buildExpireIntent,
  buildFillIntent,
  buildFillAttestedSplit,
  getFillAttestedSplitInstructionDataDecoder,
  buildFlashFill,
  getBeginFillInstructionDataDecoder,
  getCreateIntentInstructionDataDecoder,
  getEndFillInstructionDataDecoder,
  getFillIntentInstructionDataDecoder,
  buildInitUser,
  findAssociatedTokenAddress,
  findEventAuthorityPda,
  findIntentPda,
  type IdlLike,
  IntentCoreError,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  Kind,
  validateIxAgainstIdl,
  MAX_CRANK_BOUNTY,
  MAX_CREATE_FEE,
} from "../src/index.js";

const read = (rel: string) =>
  JSON.parse(readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")) as unknown;
const idl = read("../generated/idl.json") as IdlLike;
const vectors = read("./golden/vectors.json") as {
  keys: Record<"owner" | "input_mint" | "output_mint" | "fee_recipient", Address>;
  pdas: { name: string; nonce?: string; address: Address; vault?: Address }[];
};

const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA" as Address;
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" as Address;
const { owner, input_mint: inputMint, output_mint: outputMint, fee_recipient: feeRecipient } =
  vectors.keys;
const ownerSigner = createNoopSigner(owner);
const solver = createNoopSigner("So1ver1111111111111111111111111111111111111" as Address);
const swap = { kind: Kind.SwapExactIn, amountIn: 400n, minOut: 300n } as const;
const golden42 = vectors.pdas.find((p) => p.name === "intent" && p.nonce === "42");

const meta = (ix: Instruction, i: number) => {
  const m = ix.accounts?.[i];
  if (!m) {
    throw new Error(`no account ${i}`);
  }
  return m;
};

async function everyBuilt(): Promise<Record<string, Instruction>> {
  const ref = { owner, nonce: 42n, inputMint, tokenProgram: TOKEN };
  return {
    init_user: await buildInitUser({ owner: ownerSigner }),
    advance_nonce: await buildAdvanceNonce({ owner: ownerSigner, nonceBase: 9n }),
    advance_epoch: await buildAdvanceEpoch({ owner: ownerSigner, epoch: 9n }),
    create_intent: await buildCreateIntent({
      owner: ownerSigner,
      treasury: feeRecipient,
      maxCreateFee: MAX_CREATE_FEE,
      maxBounty: MAX_CRANK_BOUNTY,
      nonce: 42n,
      params: swap,
      expiresAt: 1_700_003_600n,
      inputMint,
      outputMint,
      inputTokenProgram: TOKEN,
      outputTokenProgram: TOKEN_2022,
    }),
    cancel_intent: await buildCancelIntent({ ...ref, owner: ownerSigner }),
    expire_intent: await buildExpireIntent({ ...ref, cranker: solver }),
    close_intent: await buildCloseIntent({ ...ref, cranker: solver }),
    fill_intent: await buildFillIntent({
      solver,
      owner,
      nonce: 42n,
      inputMint,
      outputMint,
      inputTokenProgram: TOKEN,
      outputTokenProgram: TOKEN_2022,
      receiver: owner,
      solverOutput: solver.address,
      solverInput: solver.address,
      feeRecipient,
      amountIn: 400n,
      amountOut: 300n,
      maxFeeBps: 100,
    }),
  };
}

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
    expect(data.recipients).toEqual(recipients);
    expect(data.weights).toEqual(weights);
    expect(data.amountIn).toBe(400n);
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
    await expect(buildFillAttestedSplit({ ...base, recipients: [], weights: [] })).rejects.toThrow();
    await expect(
      buildFillAttestedSplit({ ...base, recipients: [owner], weights: [5000, 5000] }),
    ).rejects.toThrow();
    await expect(
      buildFillAttestedSplit({
        ...base,
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

describe("validateIxAgainstIdl", () => {
  const withAccounts = (ix: Instruction, f: (a: Instruction["accounts"]) => Instruction["accounts"]) =>
    ({ ...ix, accounts: f(ix.accounts) }) as Instruction;

  it("reports a missing signature and a read-only writable account", async () => {
    const ix = (await everyBuilt())["cancel_intent"];
    if (!ix) {
      throw new Error("missing");
    }
    const broken = withAccounts(ix, (a) =>
      a?.map((m, i) =>
        i === 0 ? { ...m, role: AccountRole.READONLY } : i === 1 ? { ...m, role: AccountRole.READONLY } : m,
      ),
    );
    expect(validateIxAgainstIdl(broken, idl)).toEqual([
      "cancel_intent.owner: must sign",
      "cancel_intent.intent: must be writable",
    ]);
  });

  it("reports a wrong account count, wrong data length, and wrong program", async () => {
    const ix = (await everyBuilt())["advance_nonce"];
    if (!ix) {
      throw new Error("missing");
    }
    const short = withAccounts(ix, (a) => a?.slice(0, 2));
    expect(validateIxAgainstIdl(short, idl)).toEqual(["advance_nonce: 2 accounts, expected 4"]);
    const truncated = { ...ix, data: ix.data?.slice(0, 12) } as Instruction;
    expect(validateIxAgainstIdl(truncated, idl)).toEqual([
      "advance_nonce: data is 12 bytes, expected 16",
    ]);
    const elsewhere = { ...ix, programAddress: TOKEN } as Instruction;
    expect(validateIxAgainstIdl(elsewhere, idl)).toEqual([
      `program ${TOKEN} is not ${INTENT_ENGINE_PROGRAM_ADDRESS}`,
    ]);
  });

  it("checks an optional account that is present like any other", async () => {
    const ix = (await everyBuilt())["fill_intent"];
    const feeIndex = idl.instructions
      .find((x) => x.name === "fill_intent")
      ?.accounts.findIndex((a) => a.name === "fee_to");
    if (!ix || feeIndex === undefined) {
      throw new Error("missing");
    }
    const readonlyFee = withAccounts(ix, (a) =>
      a?.map((m, i) => (i === feeIndex ? { ...m, role: AccountRole.READONLY } : m)),
    );
    expect(validateIxAgainstIdl(readonlyFee, idl)).toEqual(["fill_intent.fee_to: must be writable"]);
  });

  it("reports data that matches no instruction", () => {
    const ix = { programAddress: INTENT_ENGINE_PROGRAM_ADDRESS, data: new Uint8Array(8) } as Instruction;
    expect(validateIxAgainstIdl(ix, idl)).toEqual([
      "data does not start with any instruction discriminator",
    ]);
  });

  it("sizes struct arguments through the IDL's defined types", async () => {
    const ix = {
      programAddress: INTENT_ENGINE_PROGRAM_ADDRESS,
      accounts: [],
      data: new Uint8Array([
        ...(idl.instructions.find((i) => i.name === "update_config")?.discriminator ?? []),
        ...new Uint8Array(82),
      ]),
    } as Instruction;
    expect(validateIxAgainstIdl(ix, idl)).toEqual([
      "update_config: 0 accounts, expected 4",
    ]);
    const long = { ...ix, data: new Uint8Array([...(ix.data ?? new Uint8Array()), 0]) } as Instruction;
    expect(validateIxAgainstIdl(long, idl)).toContain("update_config: data is 91 bytes, expected 90");
  });

  it("sizes length-prefixed extension bytes through the IDL's alias", async () => {
    const cancel = await buildCancelIntent({ owner: ownerSigner, nonce: 1n, inputMint, tokenProgram: TOKEN });
    const data = cancel.data ?? new Uint8Array();
    expect(data).toHaveLength(12);
    expect(validateIxAgainstIdl(cancel, idl)).toEqual([]);
    const withExt = { ...cancel, data: new Uint8Array([...data.subarray(0, 8), 3, 0, 0, 0, 1, 0, 0]) } as Instruction;
    expect(validateIxAgainstIdl(withExt, idl)).toEqual([]);
    const short = { ...cancel, data: new Uint8Array([...data.subarray(0, 8), 3, 0, 0, 0, 1]) } as Instruction;
    expect(validateIxAgainstIdl(short, idl)).toEqual(["cancel_intent: data is 13 bytes, expected 15"]);
    const bodiless = { ...cancel, data: new Uint8Array([...data.subarray(0, 8), 3, 0, 0, 0]) } as Instruction;
    expect(validateIxAgainstIdl(bodiless, idl)).toEqual(["cancel_intent: data is 12 bytes, expected 15"]);
    const headless = { ...cancel, data: data.subarray(0, 10) } as Instruction;
    expect(validateIxAgainstIdl(headless, idl)).toEqual(["cancel_intent: data is 10 bytes, expected 12"]);
    const trailing = { ...cancel, data: new Uint8Array([...data, 0]) } as Instruction;
    expect(validateIxAgainstIdl(trailing, idl)).toEqual(["cancel_intent: data is 13 bytes, expected 12"]);
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
    ).rejects.toThrow(RangeError);
  });

  it("refuses a flash fill too long to index", async () => {
    await expect(
      buildFlashFill({ ...spec, route: new Array<Instruction>(0xffff).fill(noop) }),
    ).rejects.toThrow(RangeError);
    await expect(
      buildFlashFill({ ...spec, route: new Array<Instruction>(0xfffe).fill(noop) }),
    ).resolves.toHaveLength(0x10000);
  });
});

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

describe("foundation fields", () => {
  const create = {
    owner: ownerSigner,
    treasury: feeRecipient,
    maxCreateFee: MAX_CREATE_FEE,
    maxBounty: MAX_CRANK_BOUNTY,
    nonce: 42n,
    params: swap,
    expiresAt: 1_700_003_600n,
    inputMint,
    outputMint,
    inputTokenProgram: TOKEN,
    outputTokenProgram: TOKEN,
  };
  const fill = {
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
    amountIn: 400n,
    amountOut: 300n,
    maxFeeBps: 100,
  };
  const ref = { owner, nonce: 42n, inputMint, tokenProgram: TOKEN };
  const unknown = new IntentCoreError("ExtUnknown");
  const ext = new Uint8Array([1, 0, 0]);

  it("refuse flags and extensions the program would reject before anything is signed", async () => {
    await expect(buildCreateIntent({ ...create, flags: 1 })).rejects.toThrow(new IntentCoreError("FlagsUnknown"));
    await expect(buildCreateIntent({ ...create, flags: 0x10000 })).rejects.toThrow(RangeError);
    await expect(buildCreateIntent({ ...create, ext: new Uint8Array([2, 0, 0]) })).rejects.toThrow(unknown);
    await expect(buildCreateIntent({ ...create, ext })).rejects.toThrow(new IntentCoreError("ExtMalformed"));
    const partner = { key: feeRecipient, bps: 30 };
    await expect(buildCreateIntent({ ...create, ext: encodePartner(partner), partner })).rejects.toThrow(
      "pass either raw extension bytes or a partner, not both",
    );
    await expect(buildCreateIntent({ ...create, ext: encodePartner({ ...partner, bps: 100 }) })).resolves.toBeDefined();
    await expect(buildCreateIntent({ ...create, ext: new Uint8Array(513) })).rejects.toThrow(
      new IntentCoreError("ExtTooLong"),
    );
    await expect(buildFillIntent({ ...fill, ext })).rejects.toThrow(unknown);
    await expect(buildFlashFill({ ...fill, beginExt: ext })).rejects.toThrow(unknown);
    await expect(buildFlashFill({ ...fill, endExt: ext })).rejects.toThrow(unknown);
    await expect(buildCancelIntent({ ...ref, owner: ownerSigner, ext })).rejects.toThrow(unknown);
    await expect(buildExpireIntent({ ...ref, cranker: solver, ext })).rejects.toThrow(unknown);
    await expect(buildCloseIntent({ ...ref, cranker: solver, ext })).rejects.toThrow(unknown);
  });

  it("carry a partner from create to every fill path", async () => {
    const partner = { key: feeRecipient, bps: 30 };
    const created = getCreateIntentInstructionDataDecoder().decode(
      (await buildCreateIntent({ ...create, partner })).data ?? new Uint8Array(),
    );
    expect(Array.from(created.args.ext)).toEqual(Array.from(encodePartner(partner)));
    const partnerTo = await findAssociatedTokenAddress({ owner: feeRecipient, mint: inputMint, tokenProgram: TOKEN });
    const at = (name: string, account: string) =>
      idl.instructions.find((x) => x.name === name)?.accounts.findIndex((a) => a.name === account) ?? -1;
    const direct = await buildFillIntent({ ...fill, partner: feeRecipient });
    expect(meta(direct, at("fill_intent", "partner_to")).address).toBe(partnerTo);
    expect(meta(await buildFillIntent(fill), at("fill_intent", "partner_to")).address).toBe(
      INTENT_ENGINE_PROGRAM_ADDRESS,
    );
    const [begin] = await buildFlashFill({ ...fill, partner: feeRecipient });
    expect(meta(begin ?? direct, at("begin_fill", "partner_to")).address).toBe(partnerTo);
    for (const ix of [direct, begin ?? direct]) {
      expect(validateIxAgainstIdl(ix, idl)).toEqual([]);
    }
  });

  it("encode the taken amount, zero flags and empty extensions", async () => {
    const created = getCreateIntentInstructionDataDecoder().decode((await buildCreateIntent(create)).data ?? new Uint8Array());
    expect(created.args.flags).toBe(0);
    expect(created.args.ext).toHaveLength(0);
    const filled = getFillIntentInstructionDataDecoder().decode((await buildFillIntent(fill)).data ?? new Uint8Array());
    expect(filled).toMatchObject({ amountIn: 400n, amountOut: 300n, maxFeeBps: 100 });
    expect(filled.ext).toHaveLength(0);
    const [begin, end] = await buildFlashFill(fill);
    const begun = getBeginFillInstructionDataDecoder().decode(begin?.data ?? new Uint8Array());
    expect(begun).toMatchObject({ amountIn: 400n, endIndex: 1, maxFeeBps: 100 });
    expect(getEndFillInstructionDataDecoder().decode(end?.data ?? new Uint8Array()).ext).toHaveLength(0);
  });
});

describe("epoch advancement", () => {
  it("jumps by an unpredictable amount drawn from 48 bits of entropy", () => {
    expect(nextEpoch(5n, new Uint8Array(6))).toBe(6n);
    expect(nextEpoch(5n, new Uint8Array([0, 0, 0, 0, 1, 0]))).toBe(5n + 257n);
    expect(nextEpoch(0n, new Uint8Array(6).fill(0xff))).toBe(2n ** 48n);
    expect(nextEpoch(U64_MAX - 1n, new Uint8Array(6).fill(0xff))).toBe(U64_MAX);
    expect(nextEpoch(U64_MAX - 3n, new Uint8Array([0, 0, 0, 0, 0, 2]))).toBe(U64_MAX);
    expect(nextEpoch(U64_MAX - 3n, new Uint8Array([0, 0, 0, 0, 0, 3]))).toBe(U64_MAX - 2n);
    expect(nextEpoch(U64_MAX - 3n, new Uint8Array([0, 0, 0, 0, 0, 4]))).toBe(U64_MAX - 1n);
    const drawn = new Set(Array.from({ length: 64 }, () => nextEpoch(0n)));
    expect(drawn.size).toBeGreaterThan(60);
    for (const e of drawn) {
      expect(e > 0n && e <= 2n ** 48n).toBe(true);
    }
  });

  it("refuses an epoch with no successor or the wrong amount of entropy", () => {
    expect(() => nextEpoch(U64_MAX)).toThrow(`no epoch follows ${U64_MAX}`);
    expect(() => nextEpoch(-1n)).toThrow(RangeError);
    expect(() => nextEpoch(1n, new Uint8Array(5))).toThrow("epoch entropy must be 6 bytes");
    expect(() => nextEpoch(1n, new Uint8Array(7))).toThrow(RangeError);
  });
});

describe("IDL argument sizing", () => {
  const ix = (args: IdlLike["instructions"][number]["args"], types: IdlLike["types"]) => {
    const local: IdlLike = {
      address: INTENT_ENGINE_PROGRAM_ADDRESS,
      instructions: [{ name: "probe", discriminator: [7], accounts: [], args }],
      ...(types === undefined ? {} : { types }),
    };
    const data = { programAddress: INTENT_ENGINE_PROGRAM_ADDRESS, accounts: [], data: new Uint8Array([7, 0]) } as Instruction;
    return validateIxAgainstIdl(data, local);
  };
  const chain = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      name: `A${i}`,
      type: { kind: "type", alias: i + 1 === n ? "u8" : { defined: { name: `A${i + 1}` } } },
    }));
  const unsizable = ["probe: arguments cannot be sized from the IDL"];

  it("follows alias chains up to the depth limit and no further", () => {
    expect(ix([{ name: "a", type: { defined: { name: "A0" } } }], chain(32))).toEqual([]);
    expect(ix([{ name: "a", type: { defined: { name: "A0" } } }], chain(33))).toEqual(unsizable);
  });

  it("stops on a type that contains itself through an alias, a struct field or an array", () => {
    const self = { defined: { name: "S" } };
    expect(ix([{ name: "a", type: self }], [{ name: "S", type: { kind: "type", alias: self } }])).toEqual(unsizable);
    expect(
      ix([{ name: "a", type: self }], [{ name: "S", type: { kind: "struct", fields: [{ name: "s", type: self }] } }]),
    ).toEqual(unsizable);
    expect(
      ix([{ name: "a", type: self }], [{ name: "S", type: { kind: "type", alias: { array: [self, 1] } } }]),
    ).toEqual(unsizable);
    expect(ix([{ name: "a", type: { option: "u8" } }], undefined)).toEqual(unsizable);
  });
});

describe("remaining escrow", () => {
  it("is what was escrowed minus what was filled, and never negative", () => {
    expect(remainingOf({ escrowed: 400n, filled: 0n })).toBe(400n);
    expect(remainingOf({ escrowed: 400n, filled: 150n })).toBe(250n);
    expect(remainingOf({ escrowed: 400n, filled: 400n })).toBe(0n);
    expect(() => remainingOf({ escrowed: 400n, filled: 401n })).toThrow("an intent cannot have filled 401 of 400");
  });
});

describe("fee resolution", () => {
  const config = { feeBps: 5, kindFeeMask: 0b1_0010, kindFeeBps: [7, 8, 9, 0] };

  it("uses a kind's own fee only where the mask names that kind, exactly as the program does", () => {
    expect(feeBpsFor(config, Kind.SwapExactIn)).toBe(7);
    expect(feeBpsFor(config, Kind.LimitOrder)).toBe(5);
    expect(feeBpsFor(config, Kind.DutchAuction)).toBe(5);
    expect(feeBpsFor(config, Kind.AttestedResult)).toBe(0);
    expect(feeBpsFor({ ...config, kindFeeMask: 0 }, Kind.SwapExactIn)).toBe(5);
    expect(feeBpsFor({ ...config, kindFeeMask: 0b0_1100 }, Kind.DutchAuction)).toBe(9);
    expect(feeBpsFor({ ...config, kindFeeMask: 0b0_1100 }, Kind.LimitOrder)).toBe(8);
  });

  it("refuses a table that does not cover the kind", () => {
    expect(() => feeBpsFor({ ...config, kindFeeBps: [7] }, Kind.AttestedResult)).toThrow(
      "no fee is configured for kind 4",
    );
    expect(IntentStatus).toEqual({ Open: 0, Filled: 1, Cancelled: 2, Expired: 3, Filling: 4 });
  });
});
