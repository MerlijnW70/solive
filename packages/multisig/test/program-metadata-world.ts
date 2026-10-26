import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, inflateSync } from "node:zlib";
import {
  AccountRole,
  type Address,
  address,
  appendTransactionMessageInstructions,
  compileTransaction,
  createTransactionMessage,
  generateKeyPairSigner,
  getBase58Decoder,
  getU32Encoder,
  getU64Encoder,
  type Instruction,
  type KeyPairSigner,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
} from "@solana/kit";
import { SYSTEM_PROGRAM } from "../src/layout.js";
import { canonicalMetadata, PROGRAM_METADATA } from "../src/program-metadata-layout.js";
import { ENGINE_PROGRAM, LOADER, programDataOf } from "../src/squads.js";
import { bytesOf, s } from "./multisig-world.js";
import { engineProgram, programMetadataProgram } from "./svm.js";

export const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
export const LOCAL_IDL = new Uint8Array(readFileSync(join(ROOT, "idl", "intent_engine.json")));
export const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const LOCAL_HASH = digest(LOCAL_IDL);
export const COMPUTE_BUDGET_PROGRAM = address("ComputeBudget111111111111111111111111111111");

const HEADER = 96;
const CHUNK = 900;

export const concat = (...parts: (Uint8Array | number[])[]): Uint8Array => new Uint8Array(Buffer.concat(parts.map((p) => Uint8Array.from(p))));

export const u64 = (value: bigint) => new Uint8Array(getU64Encoder().encode(value));

export const u32 = (value: number) => new Uint8Array(getU32Encoder().encode(value));

const seedBytes = (seed: string) => {
  const out = new Uint8Array(16);
  out.set(new TextEncoder().encode(seed));
  return out;
};

export const meta = (key: Address, role: AccountRole = AccountRole.READONLY) => ({ address: key, role });

export function loadProgramMetadata(): void {
  s.svm.addProgram(PROGRAM_METADATA, programMetadataProgram());
}

export async function engineUpgradedBy(authority: Address | null): Promise<void> {
  const programData = await programDataOf(ENGINE_PROGRAM);
  const option = authority === null ? new Uint8Array(33) : concat([1], bytesOf(authority));
  s.set(programData, LOADER, concat([3, 0, 0, 0], new Uint8Array(8), option, engineProgram()));
  s.set(ENGINE_PROGRAM, LOADER, concat([2, 0, 0, 0], bytesOf(programData)), true);
}

export type MetadataInput = { program?: Address; content: Uint8Array; authority?: Address | null; seed?: string; canonical?: boolean; mutable?: boolean };

export function metadataBytes(input: MetadataInput): Uint8Array {
  const data = deflateSync(input.content);
  return concat(
    [2],
    bytesOf(input.program ?? ENGINE_PROGRAM),
    input.authority === undefined || input.authority === null ? new Uint8Array(32) : bytesOf(input.authority),
    [input.mutable === false ? 0 : 1, input.canonical === false ? 0 : 1],
    seedBytes(input.seed ?? "idl"),
    [1, 2, 1, 0],
    u32(data.length),
    new Uint8Array(5),
    data,
  );
}

export async function placeMetadata(input: MetadataInput, at?: Address): Promise<Address> {
  const where = at ?? (await canonicalMetadata(input.program ?? ENGINE_PROGRAM, input.seed));
  s.set(where, PROGRAM_METADATA, metadataBytes(input));
  return where;
}

export function bufferBytes(authority: Address, stored: Uint8Array): Uint8Array {
  return concat([1], new Uint8Array(32), bytesOf(authority), [0], new Uint8Array(30), stored);
}

export async function sendSigned(signers: KeyPairSigner[], instructions: Instruction[]): Promise<void> {
  const [payer] = signers;
  if (payer === undefined) {
    throw new Error("no payer");
  }
  const tx = await signTransaction(
    signers.map((signer) => signer.keyPair),
    compileTransaction(
      pipe(
        createTransactionMessage({ version: 0 }),
        (msg) => setTransactionMessageFeePayer(payer.address, msg),
        (msg) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: s.svm.latestBlockhash(), lastValidBlockHeight: 0n }, msg),
        (msg) => appendTransactionMessageInstructions(instructions, msg),
      ),
    ),
  );
  await s.chain.send(tx);
}

export const setAuthorityIx = (account: Address, authority: Address, next: Address | null, program: Address = PROGRAM_METADATA, programData: Address = PROGRAM_METADATA): Instruction => ({
  programAddress: PROGRAM_METADATA,
  accounts: [meta(account, AccountRole.WRITABLE), meta(authority, AccountRole.READONLY_SIGNER), meta(program), meta(programData)],
  data: next === null ? Uint8Array.from([2, 0]) : concat([2, 1], bytesOf(next)),
});

export async function writeBuffer(deployer: KeyPairSigner, stored: Uint8Array): Promise<Address> {
  const buffer = await generateKeyPairSigner();
  const space = BigInt(HEADER + stored.length);
  const create: Instruction = {
    programAddress: SYSTEM_PROGRAM,
    accounts: [meta(deployer.address, AccountRole.WRITABLE_SIGNER), meta(buffer.address, AccountRole.WRITABLE_SIGNER)],
    data: concat([0, 0, 0, 0], u64(s.svm.minimumBalanceForRentExemption(space)), u64(space), bytesOf(PROGRAM_METADATA)),
  };
  const allocate: Instruction = {
    programAddress: PROGRAM_METADATA,
    accounts: [meta(buffer.address, AccountRole.WRITABLE_SIGNER), meta(buffer.address, AccountRole.WRITABLE_SIGNER), meta(PROGRAM_METADATA), meta(PROGRAM_METADATA), meta(SYSTEM_PROGRAM)],
    data: Uint8Array.from([7]),
  };
  await sendSigned([deployer, buffer], [create, allocate, setAuthorityIx(buffer.address, buffer.address, deployer.address)]);
  for (let offset = 0; offset < stored.length; offset += CHUNK) {
    const write: Instruction = {
      programAddress: PROGRAM_METADATA,
      accounts: [meta(buffer.address, AccountRole.WRITABLE), meta(deployer.address, AccountRole.READONLY_SIGNER), meta(PROGRAM_METADATA)],
      data: concat([0], u32(offset), stored.subarray(offset, offset + CHUNK)),
    };
    await sendSigned([deployer], [write]);
  }
  return buffer.address;
}

export async function idlBuffer(deployer: KeyPairSigner, content: Uint8Array, vault: Address): Promise<Address> {
  const buffer = await writeBuffer(deployer, deflateSync(content));
  await sendSigned([deployer], [setAuthorityIx(buffer, deployer.address, vault)]);
  return buffer;
}

type Listed = { program: Address; accounts: { key: Address; flags: string }[]; data: Uint8Array };

export function instructionListExport(instructions: Listed[]): string {
  const lines = ["", "[Transaction #1]"];
  instructions.forEach((ix, i) => {
    lines.push("", `------ IX #${i + 1} ------`, "", "", ix.program, "");
    for (const { key, flags } of ix.accounts) {
      lines.push(`${key.padEnd(44)} ${(flags.includes("W") ? "W" : "").padStart(2)} ${(flags.includes("S") ? "S" : "").padStart(1)}`);
    }
    lines.push("");
    if (ix.data.length > 0) {
      lines.push(getBase58Decoder().decode(ix.data), "");
    }
  });
  return lines.join("\n");
}

export async function idlUpdateExport(input: { vault: Address; buffer: Address; closeTo: Address; topUp: bigint }): Promise<string> {
  const metadata = await canonicalMetadata(ENGINE_PROGRAM);
  const programData = await programDataOf(ENGINE_PROGRAM);
  return instructionListExport([
    { program: COMPUTE_BUDGET_PROGRAM, accounts: [], data: concat([3], u64(100_000n)) },
    {
      program: SYSTEM_PROGRAM,
      accounts: [
        { key: input.vault, flags: "WS" },
        { key: metadata, flags: "W" },
      ],
      data: concat([2, 0, 0, 0], u64(input.topUp)),
    },
    {
      program: PROGRAM_METADATA,
      accounts: [
        { key: metadata, flags: "W" },
        { key: input.vault, flags: "S" },
        { key: input.buffer, flags: "W" },
        { key: ENGINE_PROGRAM, flags: "" },
        { key: programData, flags: "" },
      ],
      data: Uint8Array.from([3, 1, 2, 1, 0]),
    },
    {
      program: PROGRAM_METADATA,
      accounts: [
        { key: input.buffer, flags: "W" },
        { key: input.vault, flags: "S" },
        { key: PROGRAM_METADATA, flags: "" },
        { key: PROGRAM_METADATA, flags: "" },
        { key: input.closeTo, flags: "W" },
      ],
      data: Uint8Array.from([6]),
    },
  ]);
}

export const instructionList = (exported: string): string =>
  execFileSync(process.execPath, [join(ROOT, "scripts", "instruction-list.mjs")], { input: exported, encoding: "utf8" });

export const rentOf = (bytes: number) => s.svm.minimumBalanceForRentExemption(BigInt(HEADER + bytes));

export const onChainIdl = (at: Address): Uint8Array => {
  const held = s.account(at);
  if (!held.exists) {
    throw new Error(`${at} is closed`);
  }
  const length = new DataView(held.data.buffer, held.data.byteOffset, held.data.byteLength).getUint32(87, true);
  return new Uint8Array(inflateSync(held.data.subarray(HEADER, HEADER + length)));
};

export function sameSizeForgery(content: Uint8Array): Uint8Array {
  const size = deflateSync(content).length;
  for (let at = content.length - 2; at > 0; at -= 1) {
    const byte = content[at] ?? 0;
    if (byte < 0x61 || byte > 0x7a) {
      continue;
    }
    const forged = Uint8Array.from(content);
    forged[at] = byte === 0x78 ? 0x79 : 0x78;
    if (deflateSync(forged).length === size) {
      return forged;
    }
  }
  throw new Error("no forgery of the same compressed size");
}

export const setDataFromBuffer = async (metadata: Address, vault: Address, buffer: Address): Promise<Instruction> => ({
  programAddress: PROGRAM_METADATA,
  accounts: [
    meta(metadata, AccountRole.WRITABLE),
    meta(vault, AccountRole.READONLY_SIGNER),
    meta(buffer, AccountRole.WRITABLE),
    meta(ENGINE_PROGRAM),
    meta(await programDataOf(ENGINE_PROGRAM)),
  ],
  data: Uint8Array.from([3, 1, 2, 1, 0]),
});

export const transferIx = (from: Address, to: Address, lamports: bigint): Instruction => ({
  programAddress: SYSTEM_PROGRAM,
  accounts: [meta(from, AccountRole.WRITABLE_SIGNER), meta(to, AccountRole.WRITABLE)],
  data: concat([2, 0, 0, 0], u64(lamports)),
});
