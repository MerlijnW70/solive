import { AccountRole, type Instruction } from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  buildCancelIntent,
  type IdlLike,
  INTENT_ENGINE_PROGRAM_ADDRESS,
  validateIxAgainstIdl,
} from "../src/internal.js";
import { everyBuilt, idl, inputMint, owner, ownerSigner, read, TOKEN } from "./builder-fixtures.js";

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
