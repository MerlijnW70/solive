import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  AccountRole,
  type Address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createKeyPairSignerFromPrivateKeyBytes,
  createTransactionMessage,
  getAddressDecoder,
  getAddressEncoder,
  getU64Encoder,
  type Instruction,
  type KeyPairSigner,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
} from "@solana/kit";
import { describe, expect, it } from "vitest";
import {
  compileVaultMessage,
  DISCRIMINATORS,
  multisigCodec,
  multisigCreateV2,
  multisigPda,
  programConfigPda,
  proposalApprove,
  proposalCodec,
  proposalCreate,
  proposalPda,
  SQUADS_PROGRAM,
  SYSTEM_PROGRAM,
  transactionPda,
  vaultPda,
  vaultTransactionCodec,
  vaultTransactionCreate,
  vaultTransactionExecute,
} from "../src/layout.js";
import { SOL, Svm } from "./svm.js";

const IDL_SHA256 = "cb9a0a29040ec3853a5105c547ffc608bb0e3175d78dacf30d463aff939f9b9b";
const source = JSON.parse(readFileSync(new URL("../idl/source.json", import.meta.url), "utf8")) as Record<string, string>;

type IdlType = string | { option: IdlType } | { vec: IdlType } | { array: [IdlType, number] } | { defined: string };
type IdlField = { name: string; type: IdlType };
type IdlTypeDef = { name: string; type: { kind: "struct"; fields: IdlField[] } | { kind: "enum"; variants: { name: string; fields?: IdlField[] }[] } };
type Idl = {
  name: string;
  metadata: { address: string };
  instructions: { name: string; accounts: { name: string; isMut: boolean; isSigner: boolean }[]; args: IdlField[] }[];
  accounts: IdlTypeDef[];
  types: IdlTypeDef[];
};

const idlBytes = readFileSync(new URL(`../idl/${source["file"]}`, import.meta.url));
const idl = JSON.parse(idlBytes.toString("utf8")) as Idl;

const sha256 = (text: string) => [...createHash("sha256").update(text).digest().subarray(0, 8)];
const snake = (name: string) => name.replace(/([A-Z])/g, "_$1").toLowerCase();

const typeDef = (name: string): IdlTypeDef => {
  const found = [...idl.types, ...idl.accounts].find((t) => t.name === name);
  if (found === undefined) {
    throw new Error(`the idl defines no ${name}`);
  }
  return found;
};

const le = (value: unknown, size: number): number[] => {
  let n = BigInt(value as bigint | number);
  const out: number[] = [];
  for (let i = 0; i < size; i++) {
    out.push(Number(BigInt.asUintN(8, n)));
    n >>= 8n;
  }
  return out;
};

const SIZES: Record<string, number> = { u8: 1, u16: 2, u32: 4, u64: 8, i64: 8 };

function idlEncode(type: IdlType, value: unknown): number[] {
  if (typeof type === "string") {
    if (type === "publicKey") {
      return [...getAddressEncoder().encode(value as Address)];
    }
    if (type === "bool") {
      return [value === true ? 1 : 0];
    }
    if (type === "bytes") {
      const bytes = [...(value as Uint8Array)];
      return [...le(bytes.length, 4), ...bytes];
    }
    if (type === "string") {
      const bytes = [...new TextEncoder().encode(value as string)];
      return [...le(bytes.length, 4), ...bytes];
    }
    const size = SIZES[type];
    if (size === undefined) {
      throw new Error(`no encoder for idl type ${type}`);
    }
    return le(value, size);
  }
  if ("option" in type) {
    return value === null ? [0] : [1, ...idlEncode(type.option, value)];
  }
  if ("vec" in type) {
    const list = value as unknown[];
    return [...le(list.length, 4), ...list.flatMap((item) => idlEncode(type.vec, item))];
  }
  if ("array" in type) {
    return Array.from(value as ArrayLike<unknown>).flatMap((item) => idlEncode(type.array[0], item));
  }
  return encodeDefined(typeDef(type.defined), value);
}

function encodeDefined(def: IdlTypeDef, value: unknown): number[] {
  const record = value as Record<string, unknown>;
  if (def.type.kind === "struct") {
    return def.type.fields.flatMap((field) => idlEncode(field.type, record[field.name]));
  }
  const at = def.type.variants.findIndex((v) => v.name === record["__kind"]);
  const variant = def.type.variants[at];
  if (variant === undefined) {
    throw new Error(`${def.name} has no variant ${String(record["__kind"])}`);
  }
  return [at, ...(variant.fields ?? []).flatMap((field) => idlEncode(field.type, record[field.name]))];
}

const idlInstruction = (name: string, args: unknown[]) => {
  const ix = idl.instructions.find((i) => i.name === name);
  if (ix === undefined) {
    throw new Error(`the idl has no instruction ${name}`);
  }
  return { roles: ix.accounts.map((a) => (a.isSigner ? 2 : 0) | (a.isMut ? 1 : 0)), data: [...sha256(`global:${snake(name)}`), ...ix.args.flatMap((arg, i) => idlEncode(arg.type, args[i]))] };
};

const hex = (bytes: ArrayLike<number>) => Buffer.from(Uint8Array.from(bytes)).toString("hex");

const view = (ix: Instruction) => ({
  accounts: (ix.accounts ?? []).map((a) => `${a.address} ${a.role}`),
  data: hex(ix.data ?? new Uint8Array()),
});

function matchesIdl(name: keyof typeof DISCRIMINATORS, ix: Instruction, args: unknown[]): void {
  const expected = idlInstruction(name, args);
  expect(ix.programAddress).toBe(SQUADS_PROGRAM);
  expect((ix.accounts ?? []).slice(0, expected.roles.length).map((a) => a.role)).toEqual(expected.roles);
  expect(hex(ix.data ?? new Uint8Array())).toBe(hex(expected.data));
}

const VECTORS: Record<string, { accounts: string[]; data: string }> = {
  multisigCreateV2: {
    accounts: [
      "BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr 0",
      "8SFqwqnq4whPhs8icwHA2hQg3hUoN1qrCLK1SBx3WKwe 1",
      "5chpoExiAypoYjJsikWMLQLf9BYDngakeJTT7tFazmwn 1",
      "9hSR6S7WPtxmTojgo6GG3k4yDPecgJY292j7xrsUGWBu 2",
      "AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9 3",
      "11111111111111111111111111111111 0",
    ],
    data:
      "32ddc75d28f58be9000100030000008a88e3dd7409f195fd52db2d3cba5d72ca6709bf1d94121bf3748801b40f6f5c07ed4928c628d1c2c6eae90338905995612959273a5c63f93636c14614ac8737d107ca93ac1705187071d67b83c7ff0efe8108e8ec4530575d7726879333dbdabe7c07000000000000",
  },
  vaultTransactionCreate: {
    accounts: [
      "5chpoExiAypoYjJsikWMLQLf9BYDngakeJTT7tFazmwn 1",
      "7KMGUcJBeSbfw94xvrhM2HyECzo6FcYsWPSMWoMRdHHt 1",
      "AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9 2",
      "AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9 3",
      "11111111111111111111111111111111 0",
    ],
    data:
      "30fa4ea8d0e2dad30000780000000101010320103b7683275c51a1130fe8fe2ec8963f6eb3ea0139a06fb7bf856a6f03593e8a875fff1eb38451577acd5afee405456568dd7c89e090863a0557bc7af49f17000000000000000000000000000000000000000000000000000000000000000001020200010c000200000000ca9a3b000000000000",
  },
  proposalCreate: {
    accounts: [
      "5chpoExiAypoYjJsikWMLQLf9BYDngakeJTT7tFazmwn 0",
      "3igf4TQdKtnPVUUMm15VAwYGPnG3vr82Qkgb7e5UeEjj 1",
      "AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9 2",
      "AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9 3",
      "11111111111111111111111111111111 0",
    ],
    data: "dc3c49e01e6c4f9f010000000000000000",
  },
  proposalApprove: {
    accounts: [
      "5chpoExiAypoYjJsikWMLQLf9BYDngakeJTT7tFazmwn 0",
      "GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse 3",
      "3igf4TQdKtnPVUUMm15VAwYGPnG3vr82Qkgb7e5UeEjj 1",
    ],
    data: "9025a488bcd82af800",
  },
  vaultTransactionExecute: {
    accounts: [
      "5chpoExiAypoYjJsikWMLQLf9BYDngakeJTT7tFazmwn 0",
      "3igf4TQdKtnPVUUMm15VAwYGPnG3vr82Qkgb7e5UeEjj 1",
      "7KMGUcJBeSbfw94xvrhM2HyECzo6FcYsWPSMWoMRdHHt 0",
      "EdmxWPmx2WH6WgFfTdu9xfkYf3k1g5wD1zccTVySEEh1 2",
      "3AAQL8AxQNBUKh5VUQ7Kq3tiG3qAihSbw2u3Aqkn28z1 1",
      "AKkzLhjhyFtM9j7WAhbaqYpFe49cXeJBg2kzLRC2PnNa 1",
      "11111111111111111111111111111111 0",
    ],
    data: "c208a15799a419ab",
  },
};

const signer = (n: number): Promise<KeyPairSigner> => createKeyPairSignerFromPrivateKeyBytes(new Uint8Array(32).fill(n));

async function run(s: Svm, payer: KeyPairSigner, ix: Instruction, extra: KeyPairSigner[] = []): Promise<void> {
  const tx = await signTransaction(
    [payer, ...extra].map((k) => k.keyPair),
    compileTransaction(
      pipe(
        createTransactionMessage({ version: 0 }),
        (m) => setTransactionMessageFeePayer(payer.address, m),
        (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: s.svm.latestBlockhash(), lastValidBlockHeight: 0n }, m),
        (m) => appendTransactionMessageInstructions([ix], m),
      ),
    ),
  );
  await s.chain.send(tx);
}

describe("squads layout", () => {
  it("the pinned squads idl matches its recorded hash", () => {
    expect(createHash("sha256").update(idlBytes).digest("hex")).toBe(IDL_SHA256);
    expect(source).toEqual({
      file: "squads_multisig_program.json",
      url: "https://registry.npmjs.org/@sqds/multisig/-/multisig-2.1.4.tgz",
      entry: "package/idl/squads_multisig_program.json",
      sha256: IDL_SHA256,
      program: SQUADS_PROGRAM,
    });
    expect(idl.name).toBe("squads_multisig_program");
    expect(idl.metadata.address).toBe(SQUADS_PROGRAM);
    for (const [name, discriminator] of Object.entries(DISCRIMINATORS)) {
      const isAccount = idl.accounts.some((a) => a.name === name);
      expect(isAccount || idl.instructions.some((i) => i.name === name)).toBe(true);
      expect([...discriminator]).toEqual(sha256(isAccount ? `account:${name}` : `global:${snake(name)}`));
    }
  });

  it("every squads instruction is byte-identical to the idl layout and the program executes it", async () => {
    const creator = await signer(1);
    const createKey = await signer(2);
    const voter = await signer(3);
    const executor = await signer(4);
    const treasury = (await signer(5)).address;
    const recipient = (await signer(6)).address;
    const s = await Svm.open(treasury);
    for (const k of [creator, voter, executor]) {
      s.fund(k.address);
    }
    const members = [creator.address, voter.address, executor.address];
    const multisig = await multisigPda(createKey.address);
    const vault = await vaultPda(multisig, 0);
    const transaction = await transactionPda(multisig, 1n);
    const proposal = await proposalPda(multisig, 1n);
    s.fund(vault);
    const seen: Record<string, { accounts: string[]; data: string }> = {};

    const create = multisigCreateV2({ programConfig: await programConfigPda(), treasury, multisig, createKey: createKey.address, creator: creator.address, threshold: 1, members, timeLock: 0 });
    matchesIdl("multisigCreateV2", create, [
      { configAuthority: null, threshold: 1, members: members.map((key) => ({ key, permissions: { mask: 7 } })), timeLock: 0, rentCollector: null, memo: null },
    ]);
    seen["multisigCreateV2"] = view(create);
    await run(s, creator, create, [createKey]);
    const created = s.account(multisig);
    const stored = created.exists ? multisigCodec.decode(created.data, 8) : null;
    expect(stored).toMatchObject({ createKey: createKey.address, threshold: 1, timeLock: 0, transactionIndex: 0n });
    expect(hex(created.exists ? created.data.subarray(8, 8 + idlEncode({ defined: "Multisig" }, stored).length) : [])).toBe(hex(idlEncode({ defined: "Multisig" }, stored)));

    const transfer: Instruction = {
      programAddress: SYSTEM_PROGRAM,
      accounts: [
        { address: vault, role: AccountRole.WRITABLE_SIGNER },
        { address: recipient, role: AccountRole.WRITABLE },
      ],
      data: Uint8Array.from([2, 0, 0, 0, ...getU64Encoder().encode(SOL)]),
    };
    const message = compileVaultMessage(vault, [transfer]);
    const propose = vaultTransactionCreate({ multisig, transaction, creator: creator.address, vaultIndex: 0, message });
    matchesIdl("vaultTransactionCreate", propose, [{ vaultIndex: 0, ephemeralSigners: 0, transactionMessage: message, memo: null }]);
    seen["vaultTransactionCreate"] = view(propose);
    await run(s, creator, propose);
    const held = s.account(transaction);
    const vaultTransaction = held.exists ? vaultTransactionCodec.decode(held.data, 8) : null;
    expect(vaultTransaction?.message).toMatchObject({ numSigners: 1, numWritableSigners: 1, numWritableNonSigners: 1, accountKeys: [vault, recipient, SYSTEM_PROGRAM] });
    const layout = idlEncode({ defined: "VaultTransaction" }, vaultTransaction);
    expect(hex(held.exists ? held.data.subarray(8, 8 + layout.length) : [])).toBe(hex(layout));

    const open = proposalCreate({ multisig, proposal, creator: creator.address, index: 1n });
    matchesIdl("proposalCreate", open, [{ transactionIndex: 1n, draft: false }]);
    seen["proposalCreate"] = view(open);
    await run(s, creator, open);

    const vote = proposalApprove({ multisig, proposal, member: voter.address });
    matchesIdl("proposalApprove", vote, [{ memo: null }]);
    seen["proposalApprove"] = view(vote);
    await run(s, voter, vote);
    const approved = s.account(proposal);
    const status = approved.exists ? proposalCodec.decode(approved.data, 8) : null;
    expect(status).toMatchObject({ multisig, transactionIndex: 1n, status: { __kind: "Approved" }, approved: [voter.address] });
    const statusLayout = idlEncode({ defined: "Proposal" }, status);
    expect(hex(approved.exists ? approved.data.subarray(8, 8 + statusLayout.length) : [])).toBe(hex(statusLayout));

    const execute = await vaultTransactionExecute({ multisig, proposal, transaction, member: executor.address, stored: vaultTransaction! });
    matchesIdl("vaultTransactionExecute", execute, []);
    seen["vaultTransactionExecute"] = view(execute);
    await run(s, executor, execute);
    const paid = s.account(recipient);
    expect(paid.exists ? paid.lamports : 0n).toBe(SOL);
    const done = s.account(proposal);
    expect(done.exists ? proposalCodec.decode(done.data, 8).status.__kind : null).toBe("Executed");

    expect(seen).toEqual(VECTORS);
  });

  it("a vault message holds at most the 255 accounts its u8 prefix counts", async () => {
    const vault = (await signer(7)).address;
    const keys = Array.from({ length: 255 }, (_, i) => getAddressDecoder().decode(new Uint8Array(32).fill(i + 1)));
    const touching = (count: number): Instruction => ({
      programAddress: SYSTEM_PROGRAM,
      accounts: keys.slice(0, count).map((at) => ({ address: at, role: AccountRole.READONLY })),
      data: new Uint8Array(),
    });
    expect(compileVaultMessage(vault, [touching(253)])[3]).toBe(255);
    expect(() => compileVaultMessage(vault, [touching(254)])).toThrow("the proposal names 256 accounts, more than the 255 a vault transaction holds");
  });
});
