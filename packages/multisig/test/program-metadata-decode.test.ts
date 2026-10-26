import { deflateSync, gzipSync } from "node:zlib";
import { AccountRole, type Address, getBase58Decoder, getBase64Decoder, type Instruction } from "@solana/kit";
import { beforeAll, describe, expect, it } from "vitest";
import { SYSTEM_PROGRAM } from "../src/layout.js";
import { canonicalMetadata, contentHash, decodeMetadataInstruction, PROGRAM_METADATA, PROGRAM_METADATA_CLIENT } from "../src/program-metadata-layout.js";
import { describeInstructions } from "../src/review.js";
import { ENGINE_PROGRAM, programDataOf, SYSVAR_RENT } from "../src/squads.js";
import { bytesOf, openSvm, s } from "./multisig-world.js";
import { bufferBytes, concat, digest, engineUpgradedBy, loadProgramMetadata, LOCAL_HASH, LOCAL_IDL, meta, placeMetadata, setAuthorityIx } from "./program-metadata-world.js";
import { randomAddress } from "./svm.js";

beforeAll(async () => {
  await openSvm();
  loadProgramMetadata();
});

const { WRITABLE, READONLY_SIGNER } = AccountRole;

const pm = (accounts: { address: Address; role: AccountRole }[], data: number[] | Uint8Array): Instruction => ({ programAddress: PROGRAM_METADATA, accounts, data: Uint8Array.from(data) });

const seed = (text: string) => {
  const out = new Uint8Array(16);
  out.set(new TextEncoder().encode(text));
  return out;
};

const text = (value: string) => new TextEncoder().encode(value);

describe("the review decodes the program-metadata program at its 0.10.0 layout", () => {
  it("names every instruction, every account with its role and every data field", async () => {
    const vault = await randomAddress();
    await engineUpgradedBy(vault);
    const idl = await placeMetadata({ content: text("{}") });
    const engineData = await programDataOf(ENGINE_PROGRAM);
    const buffer = await randomAddress();
    s.set(buffer, PROGRAM_METADATA, bufferBytes(vault, deflateSync(LOCAL_IDL)));
    const fresh = await randomAddress();
    const json = text('{"name":"x"}');
    const access = [meta(ENGINE_PROGRAM), meta(engineData)];
    const signs = meta(vault, READONLY_SIGNER);
    const instructions = [
      pm([meta(buffer, WRITABLE), signs, meta(PROGRAM_METADATA)], [0, 5, 0, 0, 0, 1, 2, 3]),
      pm([meta(idl, WRITABLE), signs, ...access, meta(SYSTEM_PROGRAM)], concat([1], seed("idl"), [1, 0, 1, 0], json)),
      setAuthorityIx(idl, vault, vault, ENGINE_PROGRAM, engineData),
      pm([meta(idl, WRITABLE), signs, meta(PROGRAM_METADATA), ...access], concat([3, 1, 0, 1, 0], json)),
      pm([meta(idl, WRITABLE), signs, ...access], [4]),
      pm([meta(idl, WRITABLE), signs, ...access, meta(vault, WRITABLE), meta(SYSVAR_RENT)], [5]),
      pm([meta(buffer, WRITABLE), signs, meta(PROGRAM_METADATA), meta(PROGRAM_METADATA), meta(vault, WRITABLE)], [6]),
      pm([meta(fresh, WRITABLE), signs, meta(PROGRAM_METADATA), meta(PROGRAM_METADATA), meta(SYSTEM_PROGRAM)], [7]),
      pm([meta(idl, WRITABLE), signs, ...access], [8, 0, 4]),
    ];
    const seen = await describeInstructions(s.chain, instructions, vault);
    const target = `the canonical IDL account ${idl} of the intent engine ${ENGINE_PROGRAM}`;
    const may = `; ${vault} may change it as the intent engine's upgrade authority`;
    const engine = `program ${ENGINE_PROGRAM} (the intent engine), program data ${engineData} (the intent engine's)`;
    const jsonContent = `12 bytes that decode through none and utf8 to 12 IDL bytes with sha256 ${digest(json)}`;
    expect(seen.decoded.map((d) => d.summary)).toEqual([
      `Program metadata Write: Writes 3 bytes at offset 5 into buffer ${buffer}, controlled by ${vault}; accounts: buffer ${buffer}, authority ${vault} (signs), source buffer: none; offset 5, data: 3 bytes`,
      `Program metadata Initialize: Creates ${target}${may}; accounts: metadata ${idl}, authority ${vault} (signs), ${engine}, system program ${SYSTEM_PROGRAM}; seed "idl", encoding utf8, compression none, format json, data source direct, data: ${jsonContent}`,
      `Program metadata SetAuthority: Hands the authority of ${target} to ${vault}${may}; accounts: account ${idl}, authority ${vault} (signs), ${engine}; new authority ${vault}`,
      `Program metadata SetData: Sets the data of ${target} from the instruction data${may}; accounts: metadata ${idl}, authority ${vault} (signs), buffer: none, ${engine}; encoding utf8, compression none, format json, data source direct, data: ${jsonContent}`,
      `Program metadata SetImmutable: Makes ${target} immutable: it can never change again${may}; accounts: metadata ${idl}, authority ${vault} (signs), ${engine}; no fields`,
      `Program metadata Trim: Trims ${target} to its data; the spare lamports go to ${vault}${may}; accounts: account ${idl}, authority ${vault} (signs), ${engine}, destination ${vault} (the vault), rent sysvar ${SYSVAR_RENT}; no fields`,
      `Program metadata Close: Closes buffer ${buffer}, controlled by ${vault}; its lamports go to ${vault}; accounts: account ${buffer}, authority ${vault} (signs), program: none, program data: none, destination ${vault} (the vault); no fields`,
      `Program metadata Allocate: Allocates ${fresh}, which does not exist yet as a buffer; accounts: buffer ${fresh}, authority ${vault} (signs), program: none, program data: none, system program ${SYSTEM_PROGRAM}; seed: none`,
      `Program metadata Extend: Extends ${target} by 1024 bytes${may}; accounts: account ${idl}, authority ${vault} (signs), ${engine}; length 1024`,
    ]);
    expect([seen.problems, seen.relayed, seen.buffers]).toEqual([[], [], []]);
    expect(idl).toBe(await canonicalMetadata(ENGINE_PROGRAM));
  });

  it("hashes the IDL bytes a buffer will set through its compression and encoding, and refuses data that does not decode", async () => {
    const vault = await randomAddress();
    await engineUpgradedBy(vault);
    const idl = await placeMetadata({ content: text("{}") });
    const engineData = await programDataOf(ENGINE_PROGRAM);
    const setData = (at: Address, fields: number[]) =>
      pm([meta(idl, WRITABLE), meta(vault, READONLY_SIGNER), meta(at, WRITABLE), meta(ENGINE_PROGRAM), meta(engineData)], [3, ...fields]);
    const held = async (stored: Uint8Array) => {
      const at = await randomAddress();
      s.set(at, PROGRAM_METADATA, bufferBytes(vault, stored));
      return at;
    };
    const zlib = await held(deflateSync(LOCAL_IDL));
    const gzip = await held(gzipSync(LOCAL_IDL));
    const plain = await held(LOCAL_IDL);
    const encoded = await held(deflateSync(Uint8Array.from([0, 1, 2, 250])));
    const seen = await describeInstructions(
      s.chain,
      [setData(zlib, [1, 2, 1, 0]), setData(gzip, [1, 1, 1, 0]), setData(plain, [1, 0, 1, 0]), setData(encoded, [3, 2, 0, 0]), setData(encoded, [2, 2, 0, 0]), setData(plain, [1, 2, 1, 0])],
      vault,
    );
    expect(seen.buffers.map((b) => b.hash)).toEqual([
      LOCAL_HASH,
      LOCAL_HASH,
      LOCAL_HASH,
      digest(text(getBase64Decoder().decode(Uint8Array.from([0, 1, 2, 250])))),
      digest(text(getBase58Decoder().decode(Uint8Array.from([0, 1, 2, 250])))),
      null,
    ]);
    expect(seen.buffers.every((b) => b.sets === "idl" && b.authority === vault)).toBe(true);
    expect(seen.decoded[5]?.summary).toContain(`buffer ${plain}, controlled by ${vault}, holding ${LOCAL_IDL.length} bytes that do not decode: its ${LOCAL_IDL.length} bytes do not decompress as zlib`);
    expect(contentHash(deflateSync(Uint8Array.from([255, 254])), "zlib", "utf8")).toEqual({ error: "its 2 decompressed bytes are not utf8" });
    expect(contentHash(Uint8Array.from([0xab]), "none", "none")).toEqual({ hash: digest(text("ab")), bytes: 2 });
  });

  it("calls an instruction malformed when it does not match the layout exactly", async () => {
    const vault = await randomAddress();
    const two = [meta(vault, WRITABLE), meta(vault, READONLY_SIGNER)];
    const four = [...two, meta(PROGRAM_METADATA), meta(PROGRAM_METADATA)];
    const cases: [Instruction, string][] = [
      [pm(two, []), "it carries no data"],
      [pm(two, [9]), "its discriminator 9 names no instruction"],
      [pm(two, [6]), "Close takes 5 accounts, but it passes 2"],
      [pm([...four, meta(vault)], [6, 0]), "Close: it carries 1 bytes after its fields"],
      [pm(four, [2, 1, 1, 2]), "SetAuthority: its data ends before the new authority"],
      [pm(four, [2, 2]), "SetAuthority: its new authority option is 2, neither 0 nor 1"],
      [pm(four, [8, 1]), "Extend: its data ends before the length"],
      [pm([...four, meta(vault)], [7, 1, 2]), "Allocate: its seed has 2 bytes, not 16"],
      [pm([...four, meta(vault)], [3, 4, 0, 0, 0]), "SetData: its encoding is 4, which is not one of none, utf8, base58, base64"],
      [pm([...four, meta(vault)], [3, 1, 3, 0, 0]), "SetData: its compression is 3, which is not one of none, gzip, zlib"],
      [pm([...four, meta(vault)], [3, 1, 0, 0, 3]), "SetData: its data source is 3, which is not one of direct, url, external"],
      [pm([...four, meta(vault)], [3, 1, 0, 0]), "SetData: its data ends before the data source"],
      [pm([...four, meta(vault)], concat([1], [0xff], new Uint8Array(15), [1, 0, 1, 0])), "Initialize: its seed is not utf8"],
    ];
    for (const [ix, why] of cases) {
      expect(decodeMetadataInstruction(ix)).toEqual({ malformed: why });
    }
    const { problems } = await describeInstructions(s.chain, [cases[2]?.[0] ?? pm(two, [])], vault);
    expect(problems).toEqual([
      `instruction 1 is a program-metadata instruction that does not decode at the ${PROGRAM_METADATA_CLIENT} layout (Close takes 5 accounts, but it passes 2), so approving it would sign for an effect the tool cannot show`,
    ]);
    expect(decodeMetadataInstruction(setAuthorityIx(vault, vault, null))).toMatchObject({ decoded: { name: "SetAuthority", fields: { newAuthority: null } } });
    expect(bytesOf(vault)).toHaveLength(32);
  });
});
