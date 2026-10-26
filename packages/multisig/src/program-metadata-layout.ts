import { createHash } from "node:crypto";
import { gunzipSync, inflateSync } from "node:zlib";
import {
  type Address,
  address,
  getAddressDecoder,
  getAddressEncoder,
  getBase16Decoder,
  getBase58Decoder,
  getBase64Decoder,
  getProgramDerivedAddress,
  type Instruction,
  isSignerRole,
  isWritableRole,
  type ReadonlyUint8Array,
} from "@solana/kit";
import type { Account } from "./chain.js";

export const PROGRAM_METADATA = address("ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S");
export const PROGRAM_METADATA_CLIENT = "@solana-program/program-metadata@0.10.0";
export const IDL_SEED = "idl";
export const METADATA_HEADER = 96;

const SEED_BYTES = 16;
const ADDRESS_BYTES = 32;
const BUFFER_TAG = 1;
const METADATA_TAG = 2;

export const ENCODINGS = ["none", "utf8", "base58", "base64"] as const;
export const COMPRESSIONS = ["none", "gzip", "zlib"] as const;
export const FORMATS = ["none", "json", "yaml", "toml"] as const;
export const DATA_SOURCES = ["direct", "url", "external"] as const;

export type Encoding = (typeof ENCODINGS)[number];
export type Compression = (typeof COMPRESSIONS)[number];
export type Format = (typeof FORMATS)[number];
export type DataSource = (typeof DATA_SOURCES)[number];

export type Role =
  | "metadata"
  | "buffer"
  | "account"
  | "authority"
  | "source buffer"
  | "program"
  | "program data"
  | "system program"
  | "destination"
  | "rent sysvar";

export type Slot = { role: Role; address: Address | null; signer: boolean; writable: boolean };

export type Fields = {
  seed?: string | null;
  encoding?: Encoding;
  compression?: Compression;
  format?: Format;
  dataSource?: DataSource;
  data?: ReadonlyUint8Array | null;
  offset?: number;
  length?: number;
  newAuthority?: Address | null;
};

export type MetadataName = "Write" | "Initialize" | "SetAuthority" | "SetData" | "SetImmutable" | "Trim" | "Close" | "Allocate" | "Extend";

export type MetadataInstruction = { name: MetadataName; slots: Slot[]; extra: number; fields: Fields };

type Layout = { name: MetadataName; roles: readonly (readonly [Role, boolean])[]; fields: (read: Reader) => Fields };

const required = (role: Role) => [role, false] as const;
const optional = (role: Role) => [role, true] as const;

class Reader {
  private at = 1;

  constructor(private readonly data: ReadonlyUint8Array) {}

  take(count: number, what: string): ReadonlyUint8Array {
    if (this.at + count > this.data.length) {
      throw new Error(`its data ends before the ${what}`);
    }
    const out = this.data.subarray(this.at, this.at + count);
    this.at += count;
    return out;
  }

  u8(what: string): number {
    return this.take(1, what)[0] ?? 0;
  }

  u16(what: string): number {
    const bytes = this.take(2, what);
    return new DataView(bytes.buffer, bytes.byteOffset, 2).getUint16(0, true);
  }

  u32(what: string): number {
    const bytes = this.take(4, what);
    return new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true);
  }

  pick<T extends string>(names: readonly T[], what: string): T {
    const value = this.u8(what);
    const name = names[value];
    if (name === undefined) {
      throw new Error(`its ${what} is ${value}, which is not one of ${names.join(", ")}`);
    }
    return name;
  }

  rest(): ReadonlyUint8Array | null {
    const out = this.data.subarray(this.at);
    this.at = this.data.length;
    return out.length === 0 ? null : out;
  }

  done<T>(value: T): T {
    if (this.at !== this.data.length) {
      throw new Error(`it carries ${this.data.length - this.at} bytes after its fields`);
    }
    return value;
  }
}

function seedText(bytes: ReadonlyUint8Array): string {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0) {
    end -= 1;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
  } catch {
    throw new Error("its seed is not utf8");
  }
}

const seedField = (read: Reader) => seedText(read.take(SEED_BYTES, "seed"));

const dataFields = (read: Reader): Fields => ({
  encoding: read.pick(ENCODINGS, "encoding"),
  compression: read.pick(COMPRESSIONS, "compression"),
  format: read.pick(FORMATS, "format"),
  dataSource: read.pick(DATA_SOURCES, "data source"),
  data: read.rest(),
});

function newAuthority(read: Reader): Fields {
  const tag = read.u8("new authority option");
  if (tag === 0) {
    return read.done({ newAuthority: null });
  }
  if (tag !== 1) {
    throw new Error(`its new authority option is ${tag}, neither 0 nor 1`);
  }
  return read.done({ newAuthority: getAddressDecoder().decode(read.take(ADDRESS_BYTES, "new authority")) });
}

function allocateSeed(read: Reader): Fields {
  const rest = read.rest();
  if (rest === null) {
    return { seed: null };
  }
  if (rest.length !== SEED_BYTES) {
    throw new Error(`its seed has ${rest.length} bytes, not ${SEED_BYTES}`);
  }
  return { seed: seedText(rest) };
}

const ACCESS = [optional("program"), optional("program data")] as const;

const LAYOUTS: readonly Layout[] = [
  { name: "Write", roles: [required("buffer"), required("authority"), optional("source buffer")], fields: (read) => ({ offset: read.u32("offset"), data: read.rest() }) },
  {
    name: "Initialize",
    roles: [required("metadata"), required("authority"), required("program"), optional("program data"), optional("system program")],
    fields: (read) => ({ seed: seedField(read), ...dataFields(read) }),
  },
  { name: "SetAuthority", roles: [required("account"), required("authority"), ...ACCESS], fields: newAuthority },
  { name: "SetData", roles: [required("metadata"), required("authority"), optional("buffer"), ...ACCESS], fields: dataFields },
  { name: "SetImmutable", roles: [required("metadata"), required("authority"), ...ACCESS], fields: (read) => read.done({}) },
  { name: "Trim", roles: [required("account"), required("authority"), ...ACCESS, required("destination"), required("rent sysvar")], fields: (read) => read.done({}) },
  { name: "Close", roles: [required("account"), required("authority"), ...ACCESS, required("destination")], fields: (read) => read.done({}) },
  { name: "Allocate", roles: [required("buffer"), required("authority"), ...ACCESS, optional("system program")], fields: allocateSeed },
  { name: "Extend", roles: [required("account"), required("authority"), ...ACCESS], fields: (read) => read.done({ length: read.u16("length") }) },
];

export type DecodedMetadata = { decoded: MetadataInstruction } | { malformed: string };

export function decodeMetadataInstruction(ix: Instruction): DecodedMetadata {
  const data = ix.data ?? new Uint8Array();
  const accounts = ix.accounts ?? [];
  const tag = data[0];
  const layout = tag === undefined ? undefined : LAYOUTS[tag];
  if (layout === undefined) {
    return { malformed: tag === undefined ? "it carries no data" : `its discriminator ${tag} names no instruction` };
  }
  if (accounts.length < layout.roles.length) {
    return { malformed: `${layout.name} takes ${layout.roles.length} accounts, but it passes ${accounts.length}` };
  }
  let fields: Fields;
  try {
    fields = layout.fields(new Reader(data));
  } catch (error) {
    return { malformed: `${layout.name}: ${error instanceof Error ? error.message : String(error)}` };
  }
  const slots = layout.roles.map(([role, absent], at): Slot => {
    const meta = accounts[at];
    if (meta === undefined) {
      throw new Error(`account ${at} is missing`);
    }
    return { role, address: absent && meta.address === PROGRAM_METADATA ? null : meta.address, signer: isSignerRole(meta.role), writable: isWritableRole(meta.role) };
  });
  return { decoded: { name: layout.name, slots, extra: accounts.length - layout.roles.length, fields } };
}

export type MetadataHeader = {
  program: Address;
  authority: Address | null;
  mutable: boolean;
  canonical: boolean;
  seed: string;
  encoding: Encoding;
  compression: Compression;
  format: Format;
  dataSource: DataSource;
  data: ReadonlyUint8Array;
};

export type MetadataAccount =
  | ({ kind: "metadata" } & MetadataHeader)
  | { kind: "buffer"; program: Address | null; authority: Address | null; canonical: boolean; seed: string; data: ReadonlyUint8Array }
  | { kind: "missing" }
  | { kind: "other" };

const zeroable = (bytes: ReadonlyUint8Array): Address | null => (bytes.every((b) => b === 0) ? null : getAddressDecoder().decode(bytes));

function readHeader(data: ReadonlyUint8Array): MetadataHeader {
  const read = new Reader(data);
  const program = getAddressDecoder().decode(read.take(ADDRESS_BYTES, "program"));
  const authority = zeroable(read.take(ADDRESS_BYTES, "authority"));
  const mutable = read.u8("mutable") !== 0;
  const canonical = read.u8("canonical") !== 0;
  const seed = seedField(read);
  const encoding = read.pick(ENCODINGS, "encoding");
  const compression = read.pick(COMPRESSIONS, "compression");
  const format = read.pick(FORMATS, "format");
  const dataSource = read.pick(DATA_SOURCES, "data source");
  const length = read.u32("data length");
  if (METADATA_HEADER + length > data.length) {
    throw new Error(`its data length ${length} runs past the account`);
  }
  return { program, authority, mutable, canonical, seed, encoding, compression, format, dataSource, data: data.subarray(METADATA_HEADER, METADATA_HEADER + length) };
}

export function metadataAccount(info: Account | null): MetadataAccount {
  if (info === null) {
    return { kind: "missing" };
  }
  if (info.owner !== PROGRAM_METADATA || info.data.length < METADATA_HEADER) {
    return { kind: "other" };
  }
  try {
    if (info.data[0] === METADATA_TAG) {
      return { kind: "metadata", ...readHeader(info.data) };
    }
    if (info.data[0] === BUFFER_TAG) {
      const read = new Reader(info.data);
      const program = zeroable(read.take(ADDRESS_BYTES, "program"));
      const authority = zeroable(read.take(ADDRESS_BYTES, "authority"));
      const canonical = read.u8("canonical") !== 0;
      return { kind: "buffer", program, authority, canonical, seed: seedField(read), data: info.data.subarray(METADATA_HEADER) };
    }
  } catch {
    return { kind: "other" };
  }
  return { kind: "other" };
}

const seedBytes = (seed: string) => {
  const out = new Uint8Array(SEED_BYTES);
  out.set(new TextEncoder().encode(seed).subarray(0, SEED_BYTES));
  return out;
};

export const canonicalMetadata = async (program: Address, seed: string = IDL_SEED): Promise<Address> =>
  (await getProgramDerivedAddress({ programAddress: PROGRAM_METADATA, seeds: [getAddressEncoder().encode(program), seedBytes(seed)] }))[0];

export const nonCanonicalMetadata = async (program: Address, authority: Address, seed: string = IDL_SEED): Promise<Address> =>
  (
    await getProgramDerivedAddress({
      programAddress: PROGRAM_METADATA,
      seeds: [getAddressEncoder().encode(program), getAddressEncoder().encode(authority), seedBytes(seed)],
    })
  )[0];

export type Content = { hash: string; bytes: number } | { error: string };

function uncompress(data: ReadonlyUint8Array, compression: Compression): Uint8Array {
  const bytes = Uint8Array.from(data);
  switch (compression) {
    case "none":
      return bytes;
    case "gzip":
      return new Uint8Array(gunzipSync(bytes));
    case "zlib":
      return new Uint8Array(inflateSync(bytes));
  }
}

function text(bytes: Uint8Array, encoding: Encoding): Uint8Array {
  switch (encoding) {
    case "utf8":
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return bytes;
    case "none":
      return new TextEncoder().encode(getBase16Decoder().decode(bytes));
    case "base58":
      return new TextEncoder().encode(getBase58Decoder().decode(bytes));
    case "base64":
      return new TextEncoder().encode(getBase64Decoder().decode(bytes));
  }
}

export function contentHash(data: ReadonlyUint8Array, compression: Compression, encoding: Encoding): Content {
  let raw: Uint8Array;
  try {
    raw = uncompress(data, compression);
  } catch {
    return { error: `its ${data.length} bytes do not decompress as ${compression}` };
  }
  let content: Uint8Array;
  try {
    content = text(raw, encoding);
  } catch {
    return { error: `its ${raw.length} decompressed bytes are not ${encoding}` };
  }
  return { hash: createHash("sha256").update(content).digest("hex"), bytes: content.length };
}
